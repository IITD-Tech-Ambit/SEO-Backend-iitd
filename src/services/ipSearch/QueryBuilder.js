import { buildHighlightQuery, buildHighlightBlock, HIGHLIGHT_FIELDS } from '../../utils/highlight.js';

// Bounds fuzzy per-term candidate fan-out: with several fields x several overlapping
// recall arms x many query terms, uncapped fuzzy matching (default max_expansions: 50)
// can exceed OpenSearch's maxClauseCount (1024) on long, common-word queries.
const FUZZY_MAX_EXPANSIONS = 10;
// Beyond this many terms, a query is a natural-language sentence, not "name + topic" —
// skip the inventor-matching arm (which redoes fuzzy matching per term again) rather than
// let it compound the clause count for no real recall benefit.
const MAX_TERMS_FOR_IDENTITY_ARMS = 6;

function withExpansionCap(fuzz) {
    return (fuzz && fuzz.fuzziness != null) ? { ...fuzz, max_expansions: FUZZY_MAX_EXPANSIONS } : fuzz;
}

/** Coerce refine_chain / refine_within into a de-duplicated ordered list of non-empty terms. */
export function normalizeChain(refineChain) {
    const arr = Array.isArray(refineChain)
        ? refineChain
        : (refineChain != null && String(refineChain).trim() ? [refineChain] : []);
    const seen = new Set();
    const out = [];
    for (const raw of arr) {
        const term = (raw == null ? '' : String(raw)).trim();
        if (!term || seen.has(term.toLowerCase())) continue;
        seen.add(term.toLowerCase());
        out.push(term);
    }
    return out;
}

/**
 * OpenSearch query bodies/clauses for IP search (basic BM25, hybrid, normalized-hybrid).
 * Ranking: exact phrase > near phrase > scattered terms > pure kNN.
 * Inventor matching is not roster-gated; faculty enrichment is downstream in ResultHydrator.
 */
export default class QueryBuilder {
    constructor({ searchConfig, filterBuilder }) {
        this.searchConfig = searchConfig;
        this.filters = filterBuilder;
    }

    _buildHighlightBlock(query, refineChain = []) {
        const terms = [query, ...normalizeChain(refineChain)];
        const fields = [HIGHLIGHT_FIELDS.title, HIGHLIGHT_FIELDS.abstract];
        return buildHighlightBlock(buildHighlightQuery(terms, fields));
    }

    /**
     * Inventor match across nested `inventors.name` and flat `inventor_names`.
     * A fixed numeric fuzziness (unlike 'AUTO', which scales edit distance to term length) lets
     * a short term like "at" fuzzy-match almost any short fragment — e.g. an initial in a
     * co-inventor's name — regardless of the query's actual intent. Terms of length <=2 always
     * match exactly here, mirroring the length band 'AUTO' itself already uses.
     */
    buildInventorMatchClause(query, { fuzziness, boost } = {}) {
        const terms = (query || '').trim().split(/\s+/).filter(Boolean);
        if (!terms.length) return null;
        const b = this.searchConfig.fieldBoosts;
        const fuzzFor = (term) => withExpansionCap((fuzziness != null && term.length > 2) ? { fuzziness } : {});
        const nested = {
            nested: {
                path: 'inventors',
                score_mode: 'max',
                query: {
                    bool: {
                        must: terms.map((term) => ({
                            match: { 'inventors.name': { query: term, boost: b.inventorName, ...fuzzFor(term) } }
                        }))
                    }
                }
            }
        };
        const flat = {
            match: { inventor_names: { query, boost: b.inventorName, ...withExpansionCap(fuzziness != null ? { fuzziness: 'AUTO' } : {}) } }
        };
        const clause = { bool: { should: [nested, flat], minimum_should_match: 1 } };
        if (boost != null) clause.boost = boost;
        return clause;
    }

    /** Phrase-form inventor match (small slop) for the phrase-primary recall tier. */
    _buildInventorPhraseClause(query) {
        const q = (query || '').trim();
        if (!q) return null;
        const b = this.searchConfig.fieldBoosts;
        const slop = this.searchConfig.phraseSlop;
        const nested = {
            nested: {
                path: 'inventors',
                score_mode: 'max',
                query: { match_phrase: { 'inventors.name': { query: q, slop, boost: b.inventorName * 1.5 } } }
            }
        };
        const flat = { match_phrase: { inventor_names: { query: q, slop, boost: b.inventorName } } };
        return { bool: { should: [nested, flat], minimum_should_match: 1 } };
    }

    /**
     * Field-scoped clause when search_in is set. Each token must match ≥1 selected field.
     * `literalMatch` uses only un-stemmed `.standard` sub-fields.
     */
    buildConstrainedSearchInClause(query, searchIn, matchOpts = {}) {
        const terms = query.trim().split(/\s+/).filter((t) => t.length > 0);
        if (!terms.length) return { match_all: {} };
        // A fixed numeric fuzziness (unlike 'AUTO') lets a short term fuzzy-match almost anything
        // short — terms of length <=2 always match exactly, mirroring 'AUTO's own length band.
        const fuzzFor = (term) => withExpansionCap((matchOpts.fuzziness != null && term.length > 2) ? { fuzziness: matchOpts.fuzziness } : {});
        const b = this.searchConfig.fieldBoosts;
        const literalMatch = !!matchOpts.literalMatch;

        const titleTerm = (term) => {
            const fuzz = fuzzFor(term);
            if (literalMatch) {
                return { match: { 'title.standard': { query: term, boost: b.title * 1.5, ...fuzz } } };
            }
            return {
                bool: {
                    should: [
                        { match: { title: { query: term, boost: b.title, ...fuzz } } },
                        { match: { 'title.standard': { query: term, boost: b.title * 0.8, ...fuzz } } }
                    ],
                    minimum_should_match: 1
                }
            };
        };

        const abstractTerm = (term) => {
            const fuzz = fuzzFor(term);
            if (literalMatch) {
                return { match: { 'abstract.standard': { query: term, boost: b.abstract * 1.5, ...fuzz } } };
            }
            return {
                bool: {
                    should: [
                        { match: { abstract: { query: term, boost: b.abstract * 1.2, ...fuzz } } },
                        { match: { 'abstract.standard': { query: term, boost: b.abstract, ...fuzz } } }
                    ],
                    minimum_should_match: 1
                }
            };
        };

        const inventorTerm = (term) => {
            const fuzz = fuzzFor(term);
            return {
                bool: {
                    should: [
                        {
                            nested: {
                                path: 'inventors',
                                score_mode: 'max',
                                query: { match: { 'inventors.name': { query: term, boost: b.inventorName * 1.5, ...fuzz } } }
                            }
                        },
                        { match: { inventor_names: { query: term, boost: b.inventorName, ...fuzz } } }
                    ],
                    minimum_should_match: 1
                }
            };
        };

        const fieldOfInventionTerm = (term) => {
            const fuzz = fuzzFor(term);
            if (literalMatch) {
                return { match: { field_of_invention: { query: term, boost: b.fieldOfInvention * 1.5, ...fuzz } } };
            }
            return {
                bool: {
                    should: [
                        { match: { field_of_invention: { query: term, boost: b.fieldOfInvention * 1.2, ...fuzz } } },
                        { match: { 'field_of_invention.ngram': { query: term, boost: b.fieldOfInventionNgram, ...fuzz } } }
                    ],
                    minimum_should_match: 1
                }
            };
        };

        // classification is keyword: match the token as-is against exact codes.
        const classificationTerm = (term) => ({
            match: { classification: { query: term, boost: b.classification } }
        });

        const oneTermAcrossSelectedFields = (term) => {
            const should = [];
            if (searchIn.includes('title')) should.push(titleTerm(term));
            if (searchIn.includes('abstract')) should.push(abstractTerm(term));
            if (searchIn.includes('inventor')) should.push(inventorTerm(term));
            if (searchIn.includes('field_of_invention')) should.push(fieldOfInventionTerm(term));
            if (searchIn.includes('classification')) should.push(classificationTerm(term));
            return { bool: { should, minimum_should_match: should.length ? 1 : 0 } };
        };

        return { bool: { must: terms.map(oneTermAcrossSelectedFields) } };
    }

    /** Strict lexical FILTER clauses for prior refine terms (monotonic narrowing). */
    buildRefineFilterClauses(refineChain = [], searchIn = null) {
        if (!Array.isArray(refineChain) || refineChain.length === 0) return [];
        return refineChain
            .filter((term) => term && term.trim())
            .map((term) => this.buildLiteralPrimaryClause(term, searchIn));
    }

    /**
     * Phrase-priority SHOULD boosts (reorder only; no recall change).
     * `literal` uses un-stemmed `.standard` fields (basic mode).
     */
    _buildPhraseBoostTiers(query, { literal = false } = {}) {
        const words = query.trim().split(/\s+/).filter(Boolean);
        if (words.length < 2) return [];
        const titleField = literal ? 'title.standard' : 'title';
        const abstractField = literal ? 'abstract.standard' : 'abstract';
        const tiers = [
            { match_phrase: { [titleField]: { query, slop: 0, boost: 20 } } },
            { match_phrase: { [titleField]: { query, slop: 2, boost: 10 } } },
            { match_phrase: { [abstractField]: { query, slop: 0, boost: 6 } } },
            { match_phrase: { [abstractField]: { query, slop: 4, boost: 3 } } }
        ];
        // Un-stemmed exact-title tier so exact titles outrank stemmed/partial matches in advanced mode.
        if (!literal) {
            tiers.unshift({ match_phrase: { 'title.standard': { query, slop: 0, boost: 25 } } });
        }
        return tiers;
    }

    /** Advanced BM25: ≤3 terms all required; 4+ uses ~75% minimum_should_match. */
    buildStrictBm25Must(query, searchFields, fuzz = { fuzziness: 'AUTO' }, { strict = false } = {}) {
        const terms = query.trim().split(/\s+/).filter((t) => t.length > 0);

        if (terms.length <= 1) {
            return {
                multi_match: { query: query, fields: searchFields, type: 'best_fields', tie_breaker: 0.3, ...fuzz }
            };
        }

        // Per-term admission relies on stopword-aware analysis: `title`/`abstract` (unsuffixed)
        // use OpenSearch's built-in `english` analyzer, which strips stopwords via its own
        // english_stop filter. `.standard`/`.exact` are literal/un-stemmed fields for phrase-level
        // precision elsewhere (see _buildPhraseBoostTiers) — including them here lets a single
        // common word like "at" satisfy a whole term slot in the N-of-M admission count.
        const perTermFields = searchFields.filter((f) => !/\.(standard|exact)(\^|$)/.test(f));
        const matchFields = perTermFields.length ? perTermFields : searchFields;
        // A fixed numeric fuzziness (unlike 'AUTO') lets a short term fuzzy-match almost anything
        // short — terms of length <=2 always match exactly, mirroring 'AUTO's own length band.
        const fuzzFor = (term) => withExpansionCap((fuzz?.fuzziness != null && fuzz.fuzziness !== 'AUTO' && term.length <= 2) ? {} : fuzz);

        const clauses = terms.map((term) => ({
            multi_match: { query: term, fields: matchFields, type: 'best_fields', tie_breaker: 0.3, ...fuzzFor(term) }
        }));

        if (terms.length <= 3 || strict) {
            return { bool: { must: clauses } };
        }

        const minRequired = Math.max(3, Math.ceil(terms.length * 0.75));
        return { bool: { should: clauses, minimum_should_match: minRequired } };
    }

    /**
     * Strict un-fuzzy literal recall clause (basic primary + advanced lexical floor).
     * Keeps basic results a subset of advanced without flooring fuzzy/partial matches.
     */
    buildLiteralPrimaryClause(query, searchIn = null) {
        if (searchIn && searchIn.length > 0) {
            return this.buildConstrainedSearchInClause(query, searchIn, { literalMatch: true });
        }
        const literalFields = this.filters.getSearchFields(searchIn, { literalMatch: true });
        const base = { multi_match: { query, fields: literalFields, type: 'cross_fields', operator: 'and' } };
        const inventorClause = this.buildInventorMatchClause(query);
        return inventorClause
            ? { bool: { should: [base, inventorClause], minimum_should_match: 1 } }
            : base;
    }

    /**
     * Phrase-scoped search_in routing (whole-phrase per selected field).
     * `classification` stays plain match (keyword field).
     */
    _buildConstrainedPhraseClause(query, searchIn) {
        const b = this.searchConfig.fieldBoosts;
        const slop = this.searchConfig.phraseSlop;
        const should = [];
        if (searchIn.includes('title')) {
            should.push({ match_phrase: { 'title.standard': { query, slop, boost: b.title * 1.5 } } });
        }
        if (searchIn.includes('abstract')) {
            should.push({ match_phrase: { 'abstract.standard': { query, slop, boost: b.abstract * 1.5 } } });
        }
        if (searchIn.includes('inventor')) {
            const inventorPhrase = this._buildInventorPhraseClause(query);
            if (inventorPhrase) should.push(inventorPhrase);
        }
        if (searchIn.includes('field_of_invention')) {
            should.push({ match_phrase: { field_of_invention: { query, slop, boost: b.fieldOfInvention * 1.5 } } });
        }
        if (searchIn.includes('classification')) {
            should.push({ match: { classification: { query, boost: b.classification } } });
        }
        return should.length ? { bool: { should, minimum_should_match: 1 } } : { match_none: {} };
    }

    /**
     * Phrase-first RECALL (contiguous small-slop phrase; no fuzziness). Basic mode tries this
     * first; `buildLiteralPrimaryClause` (term-AND) is the fallback when it recalls nothing.
     */
    buildPhrasePrimaryClause(query, searchIn = null) {
        const q = (query || '').trim();
        if (!q) return { match_none: {} };
        if (searchIn && searchIn.length > 0) {
            return this._buildConstrainedPhraseClause(q, searchIn);
        }
        const b = this.searchConfig.fieldBoosts;
        const slop = this.searchConfig.phraseSlop;
        const should = [
            { match_phrase: { 'title.standard': { query: q, slop, boost: b.title * 1.5 } } },
            { match_phrase: { 'abstract.standard': { query: q, slop, boost: b.abstract * 1.5 } } },
            { match_phrase: { field_of_invention: { query: q, slop, boost: b.fieldOfInvention * 1.5 } } }
        ];
        const inventorClause = this._buildInventorPhraseClause(q);
        if (inventorClause) should.push(inventorClause);
        return { bool: { should, minimum_should_match: 1 } };
    }

    _sortClause(sort) {
        if (sort === 'date') {
            return [{ publication_year: { order: 'desc', missing: '_last' } }, { filing_date: { order: 'desc', missing: '_last' } }, '_score'];
        }
        return ['_score'];
    }

    /** Shared basic-mode body; only `primaryClause` differs between phrase and term-AND tiers. */
    _buildBasicQueryWithPrimary(primaryClause, query, filters, page, perPage, sort, searchIn = null, refineChain = []) {
        const from = (page - 1) * perPage;
        const filterClauses = this.filters.buildFilters(filters);
        const chain = normalizeChain(refineChain);

        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;
        const searchAllFields = !searchIn || searchIn.length === 0;

        const mustClauses = [primaryClause];

        // Prior refine terms as FILTERS: narrow monotonically without affecting newest-query scoring.
        filterClauses.push(...this.buildRefineFilterClauses(chain, searchIn));

        const boostClauses = [];
        const phraseOnTitleAbstract = searchAllFields || searchIn.includes('title') || searchIn.includes('abstract');
        if (isMultiWord && phraseOnTitleAbstract) {
            boostClauses.push(...this._buildPhraseBoostTiers(query, { literal: true }));
        }

        // Soft morphology boost on stemmed root fields.
        if (phraseOnTitleAbstract) {
            boostClauses.push({
                multi_match: {
                    query: query,
                    fields: ['title^1', 'abstract^0.5'],
                    type: 'best_fields',
                    tie_breaker: 0.3,
                    boost: 0.3
                }
            });
        }

        if (searchAllFields || searchIn.includes('field_of_invention')) {
            boostClauses.push({ match: { field_of_invention: { query: query, boost: 1.5 } } });
        }

        return {
            size: perPage,
            from,
            track_total_hits: true,
            _source: ['mongo_id', 'title', 'abstract'],
            query: {
                bool: { must: mustClauses, should: boostClauses, filter: filterClauses }
            },
            sort: this._sortClause(sort),
            aggs: this.filters.getAggregations(),
            highlight: this._buildHighlightBlock(query, chain)
        };
    }

    /**
     * Filter-only browse: no query text, so no relevance signal to gate on — every doc matching
     * the filters (e.g. department) is returned, sorted by recency by default. Used for facet
     * "browse by X" entry points where forcing a text match against title/abstract would wrongly
     * exclude documents that belong to the facet but don't happen to repeat the facet's own name.
     */
    buildBrowseQuery(filters, page, perPage, sort) {
        const from = (page - 1) * perPage;
        const filterClauses = this.filters.buildFilters(filters);
        return {
            size: perPage,
            from,
            track_total_hits: true,
            _source: ['mongo_id'],
            query: filterClauses.length > 0 ? { bool: { filter: filterClauses } } : { match_all: {} },
            sort: sort === 'relevance' ? this._sortClause('date') : this._sortClause(sort),
            aggs: this.filters.getAggregations()
        };
    }

    /** Basic phrase-primary tier (tried first by IpSearchService). */
    buildBasicPhraseQuery(query, filters, page, perPage, sort, searchIn = null, refineChain = []) {
        return this._buildBasicQueryWithPrimary(
            this.buildPhrasePrimaryClause(query, searchIn),
            query, filters, page, perPage, sort, searchIn, refineChain
        );
    }

    /** Basic term-AND fallback when phrase-primary recalls nothing. */
    buildBasicQuery(query, filters, page, perPage, sort, searchIn = null, refineChain = []) {
        return this._buildBasicQueryWithPrimary(
            this.buildLiteralPrimaryClause(query, searchIn),
            query, filters, page, perPage, sort, searchIn, refineChain
        );
    }

    /** Advanced hybrid for field-ordered sorts (e.g. date). BM25 or kNN may recall. */
    buildHybridQuery(query, embedding, filters, page, perPage, sort, searchIn = null, { refineChain = [], refineFilterClauses = null } = {}) {
        const from = (page - 1) * perPage;
        const filterClauses = this.filters.buildFilters(filters);
        const searchFields = this.filters.getHybridSearchFields(searchIn);
        const chain = normalizeChain(refineChain);

        const searchAllFields = !searchIn || searchIn.length === 0;
        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;

        const boostClauses = [];
        if (isMultiWord && (searchAllFields || searchIn.includes('title') || searchIn.includes('abstract'))) {
            boostClauses.push(...this._buildPhraseBoostTiers(query));
        }
        if (searchAllFields || searchIn.includes('field_of_invention')) {
            boostClauses.push({ match: { field_of_invention: { query: query, boost: 1.5 } } });
        }

        const bm25Clause = this._buildAdvancedBm25Clause(query, searchIn, searchFields, { fuzziness: 'AUTO' });
        const knnRecall = { knn: { embedding: { vector: embedding, k: 100 } } };
        // Fold basic's literal term-AND into recall so date-sorted advanced is a structural basic superset.
        const basicSupersetClause = this.buildLiteralPrimaryClause(query, searchIn);
        // See buildNormalizedHybridQuery: pure-kNN recall is unreliable within a single inventor's
        // small candidate pool, so it's excluded from the admit gate when filters.kerberos is set.
        const recallArms = filters?.kerberos
            ? [bm25Clause, basicSupersetClause]
            : [bm25Clause, knnRecall, basicSupersetClause];
        const recallGate = { bool: { should: recallArms, minimum_should_match: 1 } };

        // Advanced mode: narrow using the anchor's actual result-id membership (computed by the
        // service via _buildRefineAnchorIdFilter), not a literal AND-of-terms — otherwise a doc
        // that only matched the anchor semantically gets wrongly evicted on refine.
        filterClauses.push(...(refineFilterClauses || this.buildRefineFilterClauses(chain, searchIn)));

        return {
            size: perPage,
            from,
            track_total_hits: true,
            _source: ['mongo_id', 'title', 'abstract'],
            query: {
                bool: { must: [recallGate], should: boostClauses, filter: filterClauses }
            },
            sort: this._sortClause(sort),
            aggs: this.filters.getAggregations(),
            highlight: this._buildHighlightBlock(query, refineChain)
        };
    }

    /** Advanced BM25 honoring search_in; inventor arm included for all-field searches. */
    _buildAdvancedBm25Clause(query, searchIn, searchFields, fuzz) {
        if (searchIn && searchIn.length > 0) {
            return this.buildConstrainedSearchInClause(query, searchIn, fuzz);
        }
        const textBm25 = this.buildStrictBm25Must(query, searchFields, fuzz);
        const termCount = query.trim().split(/\s+/).filter(Boolean).length;
        // Long queries are natural-language sentences, not "name + topic" — the inventor arm
        // below redoes fuzzy per-term matching again, which is what pushes long/common-word
        // queries past OpenSearch's maxClauseCount. Skip it past this length.
        if (termCount > MAX_TERMS_FOR_IDENTITY_ARMS) return textBm25;
        const inventorClause = this.buildInventorMatchClause(query, fuzz);
        return inventorClause
            ? { bool: { should: [textBm25, inventorClause], minimum_should_match: 1 } }
            : textBm25;
    }


    /** SHOULD: titles containing ALL query terms (un-stemmed) rank above partial coverage. */
    _buildTitleCoverageClause(query, boost = 5) {
        const words = query.trim().split(/\s+/).filter(Boolean);
        if (words.length < 2) return null;
        return { match: { 'title.standard': { query, operator: 'and', boost } } };
    }

    /**
     * Normalized hybrid (relevance/normalized): OpenSearch-native `hybrid` query, one arm per
     * recall signal (BM25, kNN), combined by Reciprocal Rank Fusion (`search_pipeline` query
     * param — see IpSearchService). RRF fuses by RANK, not raw score, so there's no BM25-vs-
     * cosine scale mismatch to hand-tune and no min_score cliff: a real but weak match ranks
     * low instead of vanishing outright. Each arm carries its own filter so filtering happens
     * pre-fusion (OpenSearch 2.19's `hybrid` query has no top-level `filter` field yet).
     *
     * No separate "refine-chain anchor preference" arm: RRF fuses by UNION, so an arm whose
     * query is unconditionally true within the anchor filter (as a pure re-rank booster would
     * need to be) becomes an unconditional ADMISSION arm instead — it would re-admit the
     * anchor's entire filtered candidate set regardless of the current query term, silently
     * defeating refine-chain narrowing. The id-membership filter already applied to the real
     * bm25/kNN arms is what actually narrows; ranking loses the old score-carry-forward nicety,
     * but correctness matters far more than that ordering refinement.
     */
    buildNormalizedHybridQuery(query, embedding, filters, page, perPage, searchIn = null, { refineChain = [], refineFilterClauses = null, bm25AdmitsNothing = false } = {}) {
        const from = (page - 1) * perPage;
        const filterClauses = this.filters.buildFilters(filters);
        const searchFields = this.filters.getHybridSearchFields(searchIn);
        const chain = normalizeChain(refineChain);
        const searchAllFields = !searchIn || searchIn.length === 0;

        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;

        const bm25Clause = this._buildAdvancedBm25Clause(query, searchIn, searchFields, { fuzziness: 'AUTO' });

        const boostClauses = [];
        if (isMultiWord && (searchAllFields || searchIn.includes('title') || searchIn.includes('abstract'))) {
            boostClauses.push(...this._buildPhraseBoostTiers(query));
        }
        if (isMultiWord && (searchAllFields || searchIn.includes('title'))) {
            const coverageClause = this._buildTitleCoverageClause(query);
            if (coverageClause) boostClauses.push(coverageClause);
        }
        if (searchAllFields || searchIn.includes('field_of_invention')) {
            boostClauses.push({ match: { field_of_invention: { query: query, boost: 1.5 } } });
        }

        filterClauses.push(...(refineFilterClauses || this.buildRefineFilterClauses(chain, searchIn)));

        const bm25Arm = { bool: { must: [bm25Clause], should: boostClauses, filter: filterClauses } };
        const knnArm = { bool: { must: [{ knn: { embedding: { vector: embedding, k: 100 } } }], filter: filterClauses } };
        // Pure-kNN recall is excluded when scoped to one inventor (filters.kerberos): within a
        // small single-person candidate pool, embedding similarity across an entire domain-
        // specific corpus is often nearly flat (observed <0.15 spread across a query's whole
        // top-15), so its "top" neighbor can be little more than the least-bad of an unrelated
        // bunch. kNN still ranks normally once there's no hard identity filter to fall back on.
        // But BM25's N-of-M admission bar can be mathematically unreachable for a paraphrased
        // query with several stopwords — with kNN excluded there's no fallback, so a genuinely
        // matching patent becomes permanently unfindable within that inventor's scope.
        // bm25AdmitsNothing (the caller's own BM25-only precheck against the same scoped pool)
        // allows kNN back in only as a last resort, not a co-equal arm.
        const arms = (filters?.kerberos && !bm25AdmitsNothing) ? [bm25Arm] : [bm25Arm, knnArm];

        return {
            size: perPage,
            from,
            track_total_hits: true,
            _source: ['mongo_id', 'title', 'abstract'],
            query: { hybrid: { queries: arms } },
            aggs: this.filters.getAggregations(),
            highlight: this._buildHighlightBlock(query, refineChain)
        };
    }
}
