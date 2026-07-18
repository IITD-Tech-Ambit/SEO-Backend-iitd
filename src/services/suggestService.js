/**
 * Suggest Service — blended, intent-aware typeahead.
 *
 * Runs authors + papers OpenSearch queries in parallel, scores hybrid intent
 * (no ML), and returns both groups ordered by intent. Two-layer cache
 * (in-process LRU + Redis) with a per-source timeout for partial results.
 */

const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'based', 'by', 'for', 'from', 'in', 'into',
    'of', 'on', 'or', 'the', 'their', 'to', 'using', 'via', 'with', 'within'
]);

// Trailing words that strongly suggest the user is still typing a topic phrase.
const TRAILING_CONNECTORS = new Set(['for', 'using', 'of', 'with', 'in', 'on', 'and', 'based', 'via', 'to']);

/** Tiny TTL-aware LRU keyed by string. Bounded memory; nanosecond hits. */
class TTLLRU {
    constructor(max, ttlMs) {
        this.max = max;
        this.ttlMs = ttlMs;
        this.map = new Map();
    }
    get(key) {
        const entry = this.map.get(key);
        if (!entry) return undefined;
        if (Date.now() - entry.t > this.ttlMs) {
            this.map.delete(key);
            return undefined;
        }
        // refresh recency
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.v;
    }
    set(key, value) {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, { v: value, t: Date.now() });
        while (this.map.size > this.max) {
            const oldest = this.map.keys().next().value;
            this.map.delete(oldest);
        }
    }
}

export default class SuggestService {
    constructor({ opensearch, opensearchIndex, mongoose, redis, logger, config }) {
        this.opensearch = opensearch;
        this.mongoose = mongoose;
        this.authorsIndex = config.opensearch.authorsSuggestIndex;
        this.papersIndex = opensearchIndex;
        this.redis = redis;
        this.logger = logger;
        this.cfg = config.suggest;

        this.lru = new TTLLRU(this.cfg.lruMax, this.cfg.lruTtlMs);

        // In-memory faculty name-token Set — ONLY a signal for the intent engine, never
        // used for retrieval (retrieval is delegated to OpenSearch so it scales).
        this._tokenSet = new Set();
        this._tokensLoadedAt = 0;
        this._tokensInflight = null;
    }

    /** Kick off the first token-set load (call from app bootstrap). Non-blocking. */
    init() {
        this._refreshTokenSet().catch((err) =>
            this.logger.warn({ err }, 'suggest: initial faculty token-set load failed'));
    }

    normalizePrefix(q) {
        return (q || '').toString().trim().replace(/\s+/g, ' ').toLowerCase();
    }

    async _refreshTokenSet() {
        if (this._tokensInflight) return this._tokensInflight;
        this._tokensInflight = (async () => {
            const Faculty = this.mongoose.model('Faculty');
            const docs = await Faculty.find({}, { firstName: 1, lastName: 1 }).lean();
            const set = new Set();
            for (const d of docs) {
                for (const part of [d.firstName, d.lastName]) {
                    if (!part) continue;
                    for (const tok of String(part).toLowerCase().split(/\s+/)) {
                        const t = tok.replace(/[^a-z]/g, '');
                        if (t.length >= 2) set.add(t);
                    }
                }
            }
            this._tokenSet = set;
            this._tokensLoadedAt = Date.now();
            this.logger.info({ tokens: set.size }, 'suggest: faculty token-set loaded');
            return set;
        })().finally(() => { this._tokensInflight = null; });
        return this._tokensInflight;
    }

    _ensureTokensFresh() {
        if (Date.now() - this._tokensLoadedAt > this.cfg.tokenRefreshMs) {
            // Fire-and-forget; current request uses whatever is loaded.
            this._refreshTokenSet().catch(() => { /* logged elsewhere */ });
        }
    }

    _authorsQueryBody(q, qNorm) {
        return {
            size: this.cfg.authorsSize,
            _source: ['expert_id', 'scopus_id', 'name', 'department', 'image_url',
                'designation', 'h_index', 'citation_count', 'paper_count'],
            query: {
                function_score: {
                    query: {
                        bool: {
                            should: [
                                { match: { 'name.autocomplete': { query: q, operator: 'and', boost: 3 } } },
                                { term: { 'name.keyword': { value: qNorm, boost: 8 } } },
                                { match: { name: { query: q, fuzziness: 'AUTO', boost: 1.5 } } },
                                { match: { 'name_variants.autocomplete': { query: q, operator: 'and', boost: 2 } } }
                            ],
                            minimum_should_match: 1
                        }
                    },
                    functions: [
                        { field_value_factor: { field: 'h_index', modifier: 'log1p', factor: 0.3, missing: 0 } },
                        { field_value_factor: { field: 'citation_count', modifier: 'log1p', factor: 0.1, missing: 0 } }
                    ],
                    score_mode: 'sum',
                    boost_mode: 'sum'
                }
            }
        };
    }

    _papersQueryBody(q) {
        const currentYear = new Date().getFullYear();
        return {
            size: this.cfg.papersSize,
            _source: ['title', 'mongo_id', 'publication_year', 'authors'],
            query: {
                function_score: {
                    query: {
                        bool: {
                            should: [
                                { match: { 'title.autocomplete': { query: q, operator: 'and', boost: 4 } } },
                                { match: { 'title.shingles': { query: q, boost: 2 } } },
                                { match: { 'abstract.standard': { query: q, boost: 0.5 } } },
                                { match: { 'abstract.shingles': { query: q, boost: 0.7 } } }
                            ],
                            minimum_should_match: 1
                        }
                    },
                    functions: [
                        { field_value_factor: { field: 'citation_count', modifier: 'log1p', factor: 0.2, missing: 0 } },
                        { gauss: { publication_year: { origin: currentYear, scale: 8, decay: 0.5 } } }
                    ],
                    score_mode: 'sum',
                    boost_mode: 'sum'
                }
            }
        };
    }

    /** Race an OpenSearch search against the per-source budget; on timeout/err -> []. */
    async _searchWithTimeout(label, index, body) {
        const timeout = new Promise((resolve) =>
            setTimeout(() => resolve({ __timeout: true }), this.cfg.perSourceTimeoutMs));
        try {
            const res = await Promise.race([
                this.opensearch.search({ index, body }),
                timeout
            ]);
            if (res?.__timeout) {
                this.logger.warn({ label }, 'suggest: source timed out, returning partial');
                return { hits: [], timedOut: true };
            }
            return { hits: res.body?.hits?.hits || [], timedOut: false };
        } catch (err) {
            this.logger.warn({ err, label }, 'suggest: source query failed');
            return { hits: [], timedOut: false, error: true };
        }
    }

    _mapAuthorHits(hits) {
        return hits.map((h) => ({
            id: h._source.expert_id || h._id,
            scopus_id: h._source.scopus_id || '',
            name: h._source.name || '',
            department: h._source.department || '',
            image_url: h._source.image_url || '',
            score: Number(h._score) || 0
        }));
    }

    _leadAuthor(authors) {
        if (!Array.isArray(authors) || authors.length === 0) return '';
        let lead = authors[0];
        for (const a of authors) {
            if (Number(a.author_position) === 1) { lead = a; break; }
            if (Number(a.author_position) < Number(lead.author_position || Infinity)) lead = a;
        }
        return lead.author_name || '';
    }

    _mapPaperHits(hits) {
        return hits.map((h) => ({
            id: h._source.mongo_id || h._id,
            title: h._source.title || '',
            year: Number(h._source.publication_year) || 0,
            lead_author: this._leadAuthor(h._source.authors),
            score: Number(h._score) || 0
        }));
    }

    _computeIntent(qNorm, topAuthorScore, topPaperScore, hasAuthors, hasPapers) {
        const w = this.cfg.intentWeights;
        const tokens = qNorm.split(' ').filter(Boolean);
        const numTokens = tokens.length;
        const contentTokens = tokens.filter((t) => !STOPWORDS.has(t));

        // 1. Name-token membership in the faculty token set (strong author signal).
        // Exact match for completed tokens; prefix-aware for the final, in-progress token
        // (so "gup" still counts as a hit on "gupta").
        let matched = 0;
        for (let i = 0; i < contentTokens.length; i++) {
            const t = contentTokens[i].replace(/[^a-z]/g, '');
            if (!t) continue;
            if (this._tokenSet.has(t)) { matched++; continue; }
            if (i === contentTokens.length - 1 && t.length >= 2) {
                for (const setTok of this._tokenSet) {
                    if (setTok.startsWith(t)) { matched++; break; }
                }
            }
        }
        const nameTokenRatio = contentTokens.length ? matched / contentTokens.length : 0;

        // 2. Name shape: 1-3 tokens / initials pattern -> author-ish.
        const initialsPattern = tokens.some((t) => /^[a-z]\.?$/.test(t));
        let shape = 0;
        if (numTokens >= 1 && numTokens <= 3) shape += 0.6;
        if (numTokens <= 2) shape += 0.2;
        if (initialsPattern) shape += 0.4;
        if (numTokens >= 5) shape = 0;
        shape = Math.min(1, shape);

        // 3. Topic signal: stopwords / length / trailing connectors -> paper/topic.
        let topic = 0;
        const stopCount = tokens.filter((t) => STOPWORDS.has(t)).length;
        if (stopCount > 0) topic += 0.4;
        if (numTokens >= 4) topic += 0.4;
        if (numTokens >= 6) topic += 0.2;
        if (numTokens > 0 && TRAILING_CONNECTORS.has(tokens[numTokens - 1])) topic += 0.3;
        topic = Math.min(1, topic);

        // 4. Cross-source retrieval confidence (paper score includes abstract).
        const a = hasAuthors ? (topAuthorScore || 0) : 0;
        const p = hasPapers ? (topPaperScore || 0) : 0;
        let retAuthor = 0;
        let retPaper = 0;
        if (a + p > 0) {
            retAuthor = a / (a + p);
            retPaper = p / (a + p);
        }

        const authorEvidence =
            w.nameTokenMatch * nameTokenRatio +
            w.nameShape * shape +
            w.retrievalConfidence * retAuthor;
        const paperEvidence =
            w.topicSignal * topic +
            w.retrievalConfidence * retPaper;

        const total = authorEvidence + paperEvidence;
        if (total <= 0 || (!hasAuthors && !hasPapers)) {
            return { intent: 'mixed', confidence: 0 };
        }
        const authorProb = authorEvidence / total;

        let intent;
        if (authorProb >= 0.6) intent = 'author';
        else if (authorProb <= 0.4) intent = 'paper';
        else intent = 'mixed';

        const confidence = Math.round(Math.max(authorProb, 1 - authorProb) * 100) / 100;
        return { intent, confidence };
    }

    async suggest(rawQuery, rawLimit) {
        const startTime = Date.now();
        const qNorm = this.normalizePrefix(rawQuery);
        const limit = Math.min(
            Math.max(parseInt(rawLimit, 10) || this.cfg.defaultLimit, 1),
            this.cfg.maxLimit
        );

        // Too short -> empty groups (the client shows recent searches instead).
        if (qNorm.length < this.cfg.minPrefix) {
            return {
                intent: 'mixed',
                confidence: 0,
                groups: { authors: [], papers: [] },
                cacheHit: false,
                tookMs: Date.now() - startTime
            };
        }

        const cacheKey = `suggest:v1:${qNorm}:${limit}`;

        // Layer 1: in-process LRU.
        const lruHit = this.lru.get(cacheKey);
        if (lruHit) {
            return { ...lruHit, cacheHit: true, tookMs: Date.now() - startTime };
        }

        // Layer 2: Redis.
        try {
            const redisHit = await this.redis.get(cacheKey);
            if (redisHit) {
                const parsed = JSON.parse(redisHit);
                this.lru.set(cacheKey, parsed);
                return { ...parsed, cacheHit: true, tookMs: Date.now() - startTime };
            }
        } catch (err) {
            this.logger.warn({ err }, 'suggest: redis read failed');
        }

        this._ensureTokensFresh();

        // The query passed to OpenSearch keeps original casing for analyzers; qNorm is for
        // the lowercase-normalized keyword term and the intent engine.
        const q = (rawQuery || '').toString().trim().replace(/\s+/g, ' ');

        const [authorsRes, papersRes] = await Promise.all([
            this._searchWithTimeout('authors', this.authorsIndex, this._authorsQueryBody(q, qNorm)),
            this._searchWithTimeout('papers', this.papersIndex, this._papersQueryBody(q))
        ]);

        const authors = this._mapAuthorHits(authorsRes.hits).slice(0, limit);
        const papers = this._mapPaperHits(papersRes.hits).slice(0, limit);

        const topAuthorScore = authors[0]?.score || 0;
        const topPaperScore = papers[0]?.score || 0;
        const { intent, confidence } = this._computeIntent(
            qNorm, topAuthorScore, topPaperScore, authors.length > 0, papers.length > 0
        );

        const payload = {
            intent,
            confidence,
            groups: { authors, papers }
        };

        // Write both cache layers (skip caching partial results from a timed-out source).
        if (!authorsRes.timedOut && !papersRes.timedOut) {
            this.lru.set(cacheKey, payload);
            try {
                await this.redis.setex(cacheKey, this.cfg.redisTtl, JSON.stringify(payload));
            } catch (err) {
                this.logger.warn({ err }, 'suggest: redis write failed');
            }
        }

        return { ...payload, cacheHit: false, tookMs: Date.now() - startTime };
    }
}
