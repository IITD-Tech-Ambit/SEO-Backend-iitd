/**
 * Blended, intent-aware typeahead for IP explore.
 * Inventors come from nested/inner_hits on `ip_documents` (no separate roster index),
 * deduped client-side. Two-layer cache (LRU + Redis) with per-source timeout.
 */

const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'based', 'by', 'for', 'from', 'in', 'into',
    'of', 'on', 'or', 'the', 'their', 'to', 'using', 'via', 'with', 'within'
]);

// Trailing words that suggest the user is still typing a topic phrase.
const TRAILING_CONNECTORS = new Set(['for', 'using', 'of', 'with', 'in', 'on', 'and', 'based', 'via', 'to']);

/** Tiny TTL-aware LRU keyed by string. */
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

export default class IpSuggestService {
    constructor({ opensearch, opensearchIndex, mongoose, redis, logger, config }) {
        this.opensearch = opensearch;
        this.mongoose = mongoose;
        this.documentsIndex = opensearchIndex || config.opensearch.ipIndexName;
        this.redis = redis;
        this.logger = logger;
        this.cfg = config.ipSuggest;

        this.lru = new TTLLRU(this.cfg.lruMax, this.cfg.lruTtlMs);

        // Inventor name tokens: intent signal only — retrieval stays in OpenSearch.
        this._tokenSet = new Set();
        this._tokensLoadedAt = 0;
        this._tokensInflight = null;
    }

    /** Non-blocking first token-set load (call from app bootstrap). */
    init() {
        this._refreshTokenSet().catch((err) =>
            this.logger.warn({ err }, 'ip-suggest: initial inventor token-set load failed'));
    }

    normalizePrefix(q) {
        return (q || '').toString().trim().replace(/\s+/g, ' ').toLowerCase();
    }

    async _refreshTokenSet() {
        if (this._tokensInflight) return this._tokensInflight;
        this._tokensInflight = (async () => {
            const IPMetaData = this.mongoose.model('IPMetaData');
            const docs = await IPMetaData.find({}, { 'inventors.name': 1 }).lean();
            const set = new Set();
            for (const d of docs) {
                for (const inv of d.inventors || []) {
                    if (!inv?.name) continue;
                    for (const tok of String(inv.name).toLowerCase().split(/\s+/)) {
                        const t = tok.replace(/[^a-z]/g, '');
                        if (t.length >= 2) set.add(t);
                    }
                }
            }
            this._tokenSet = set;
            this._tokensLoadedAt = Date.now();
            this.logger.info({ tokens: set.size }, 'ip-suggest: inventor token-set loaded');
            return set;
        })().finally(() => { this._tokensInflight = null; });
        return this._tokensInflight;
    }

    _ensureTokensFresh() {
        if (Date.now() - this._tokensLoadedAt > this.cfg.tokenRefreshMs) {
            this._refreshTokenSet().catch(() => { /* logged elsewhere */ });
        }
    }

    /**
     * Nested prefix match on inventors + inner_hits for client-side dedupe.
     * Deliberately skips `inventors.name.ngram`: that analyzer emits every gram at
     * position 0, so operator:and collapses to an unbounded OR across 2-4 char
     * substrings (matched >15% of inventors for a 5-char query in testing).
     */
    _inventorsQueryBody(q) {
        return {
            size: this.cfg.inventorCandidateDocs,
            _source: false,
            query: {
                nested: {
                    path: 'inventors',
                    score_mode: 'max',
                    query: {
                        match_phrase_prefix: { 'inventors.name': { query: q } }
                    },
                    inner_hits: {
                        size: 5,
                        _source: ['inventors.name', 'inventors.is_faculty', 'inventors.kerberos']
                    }
                }
            }
        };
    }

    _documentsQueryBody(q) {
        const currentYear = new Date().getFullYear();
        return {
            size: this.cfg.documentsSize,
            _source: ['title', 'mongo_id', 'publication_year', 'type_of_ip', 'inventors'],
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
                        { gauss: { publication_year: { origin: currentYear, scale: 8, decay: 0.5 } } }
                    ],
                    score_mode: 'sum',
                    boost_mode: 'sum'
                }
            }
        };
    }

    /** Race OpenSearch against the per-source budget; on timeout/err -> []. */
    async _searchWithTimeout(label, index, body) {
        const timeout = new Promise((resolve) =>
            setTimeout(() => resolve({ __timeout: true }), this.cfg.perSourceTimeoutMs));
        try {
            const res = await Promise.race([
                this.opensearch.search({ index, body }),
                timeout
            ]);
            if (res?.__timeout) {
                this.logger.warn({ label }, 'ip-suggest: source timed out, returning partial');
                return { hits: [], timedOut: true };
            }
            return { hits: res.body?.hits?.hits || [], timedOut: false };
        } catch (err) {
            this.logger.warn({ err, label }, 'ip-suggest: source query failed');
            return { hits: [], timedOut: false, error: true };
        }
    }

    /** Dedupe inventor inner_hits by name (case-insensitive), keep highest score. */
    _mapInventorHits(hits) {
        const byName = new Map();
        for (const hit of hits) {
            const innerHits = hit.inner_hits?.inventors?.hits?.hits || [];
            for (const inner of innerHits) {
                const src = inner._source || {};
                const name = (src.name || '').trim();
                if (!name) continue;
                const key = name.toLowerCase();
                const score = Number(inner._score) || 0;
                const existing = byName.get(key);
                if (!existing || score > existing.score) {
                    byName.set(key, {
                        id: (src.kerberos || key).trim(),
                        name,
                        is_faculty: !!src.is_faculty,
                        kerberos: src.kerberos || '',
                        score
                    });
                }
            }
        }
        return Array.from(byName.values()).sort((a, b) => b.score - a.score);
    }

    _leadInventor(inventors) {
        if (!Array.isArray(inventors) || inventors.length === 0) return '';
        // Index 0 is always the primary inventor (invariant from population).
        return inventors[0]?.name || '';
    }

    _mapDocumentHits(hits) {
        return hits.map((h) => ({
            id: h._source.mongo_id || h._id,
            title: h._source.title || '',
            year: Number(h._source.publication_year) || 0,
            type_of_ip: h._source.type_of_ip || '',
            lead_inventor: this._leadInventor(h._source.inventors),
            score: Number(h._score) || 0
        }));
    }

    _computeIntent(qNorm, topInventorScore, topDocumentScore, hasInventors, hasDocuments) {
        const w = this.cfg.intentWeights;
        const tokens = qNorm.split(' ').filter(Boolean);
        const numTokens = tokens.length;
        const contentTokens = tokens.filter((t) => !STOPWORDS.has(t));

        // 1. Name-token membership (exact; prefix for the final in-progress token).
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

        // 2. Name shape: 1-3 tokens / initials -> inventor-ish.
        const initialsPattern = tokens.some((t) => /^[a-z]\.?$/.test(t));
        let shape = 0;
        if (numTokens >= 1 && numTokens <= 3) shape += 0.6;
        if (numTokens <= 2) shape += 0.2;
        if (initialsPattern) shape += 0.4;
        if (numTokens >= 5) shape = 0;
        shape = Math.min(1, shape);

        // 3. Topic signal: stopwords / length / trailing connectors -> document.
        let topic = 0;
        const stopCount = tokens.filter((t) => STOPWORDS.has(t)).length;
        if (stopCount > 0) topic += 0.4;
        if (numTokens >= 4) topic += 0.4;
        if (numTokens >= 6) topic += 0.2;
        if (numTokens > 0 && TRAILING_CONNECTORS.has(tokens[numTokens - 1])) topic += 0.3;
        topic = Math.min(1, topic);

        // 4. Cross-source retrieval confidence.
        const a = hasInventors ? (topInventorScore || 0) : 0;
        const p = hasDocuments ? (topDocumentScore || 0) : 0;
        let retInventor = 0;
        let retDocument = 0;
        if (a + p > 0) {
            retInventor = a / (a + p);
            retDocument = p / (a + p);
        }

        const inventorEvidence =
            w.nameTokenMatch * nameTokenRatio +
            w.nameShape * shape +
            w.retrievalConfidence * retInventor;
        const documentEvidence =
            w.topicSignal * topic +
            w.retrievalConfidence * retDocument;

        const total = inventorEvidence + documentEvidence;
        if (total <= 0 || (!hasInventors && !hasDocuments)) {
            return { intent: 'mixed', confidence: 0 };
        }
        const inventorProb = inventorEvidence / total;

        let intent;
        if (inventorProb >= 0.6) intent = 'inventor';
        else if (inventorProb <= 0.4) intent = 'document';
        else intent = 'mixed';

        const confidence = Math.round(Math.max(inventorProb, 1 - inventorProb) * 100) / 100;
        return { intent, confidence };
    }

    async suggest(rawQuery, rawLimit) {
        const startTime = Date.now();
        const qNorm = this.normalizePrefix(rawQuery);
        const limit = Math.min(
            Math.max(parseInt(rawLimit, 10) || this.cfg.defaultLimit, 1),
            this.cfg.maxLimit
        );

        // Too short -> empty groups.
        if (qNorm.length < this.cfg.minPrefix) {
            return {
                intent: 'mixed',
                confidence: 0,
                groups: { inventors: [], documents: [] },
                cacheHit: false,
                tookMs: Date.now() - startTime
            };
        }

        const cacheKey = `ip-suggest:v1:${qNorm}:${limit}`;

        const lruHit = this.lru.get(cacheKey);
        if (lruHit) {
            return { ...lruHit, cacheHit: true, tookMs: Date.now() - startTime };
        }

        try {
            const redisHit = await this.redis.get(cacheKey);
            if (redisHit) {
                const parsed = JSON.parse(redisHit);
                this.lru.set(cacheKey, parsed);
                return { ...parsed, cacheHit: true, tookMs: Date.now() - startTime };
            }
        } catch (err) {
            this.logger.warn({ err }, 'ip-suggest: redis read failed');
        }

        this._ensureTokensFresh();

        // OpenSearch keeps original casing; qNorm is for the intent engine.
        const q = (rawQuery || '').toString().trim().replace(/\s+/g, ' ');

        const [inventorsRes, documentsRes] = await Promise.all([
            this._searchWithTimeout('inventors', this.documentsIndex, this._inventorsQueryBody(q)),
            this._searchWithTimeout('documents', this.documentsIndex, this._documentsQueryBody(q))
        ]);

        const inventors = this._mapInventorHits(inventorsRes.hits).slice(0, limit);
        const documents = this._mapDocumentHits(documentsRes.hits).slice(0, limit);

        const topInventorScore = inventors[0]?.score || 0;
        const topDocumentScore = documents[0]?.score || 0;
        const { intent, confidence } = this._computeIntent(
            qNorm, topInventorScore, topDocumentScore, inventors.length > 0, documents.length > 0
        );

        const payload = {
            intent,
            confidence,
            groups: { inventors, documents }
        };

        if (!inventorsRes.timedOut && !documentsRes.timedOut) {
            this.lru.set(cacheKey, payload);
            try {
                await this.redis.setex(cacheKey, this.cfg.redisTtl, JSON.stringify(payload));
            } catch (err) {
                this.logger.warn({ err }, 'ip-suggest: redis write failed');
            }
        }

        return { ...payload, cacheHit: false, tookMs: Date.now() - startTime };
    }
}
