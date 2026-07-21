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

    /** Inventor match across nested `inventors.name` and flat `inventor_names`. */
    buildInventorMatchClause(query, { fuzziness, boost } = {}) {
        const terms = (query || '').trim().split(/\s+/).filter(Boolean);
        if (!terms.length) return null;
        const b = this.searchConfig.fieldBoosts;
        const fuzz = fuzziness != null ? { fuzziness } : {};
        const nested = {
            nested: {
                path: 'inventors',
                score_mode: 'max',
                query: {
                    bool: {
                        must: terms.map((term) => ({
                            match: { 'inventors.name': { query: term, boost: b.inventorName, ...fuzz } }
                        }))
                    }
                }
            }
        };
        const flat = {
            match: { inventor_names: { query, boost: b.inventorName, ...fuzz } }
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
        const fuzz = matchOpts.fuzziness != null ? { fuzziness: matchOpts.fuzziness } : {};
        const b = this.searchConfig.fieldBoosts;
        const literalMatch = !!matchOpts.literalMatch;

        const titleTerm = (term) => {
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

        const inventorTerm = (term) => ({
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
        });

        const fieldOfInventionTerm = (term) => {
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

        const clauses = terms.map((term) => ({
            multi_match: { query: term, fields: searchFields, type: 'best_fields', tie_breaker: 0.3, ...fuzz }
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
            _source: ['mongo_id'],
            query: {
                bool: { must: mustClauses, should: boostClauses, filter: filterClauses }
            },
            sort: this._sortClause(sort),
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
        const recallGate = { bool: { should: [bm25Clause, knnRecall, basicSupersetClause], minimum_should_match: 1 } };

        // Advanced mode: narrow using the anchor's actual result-id membership (computed by the
        // service via _buildRefineAnchorIdFilter), not a literal AND-of-terms — otherwise a doc
        // that only matched the anchor semantically gets wrongly evicted on refine.
        filterClauses.push(...(refineFilterClauses || this.buildRefineFilterClauses(chain, searchIn)));

        return {
            size: perPage,
            from,
            track_total_hits: true,
            _source: ['mongo_id'],
            query: {
                bool: { must: [recallGate], should: boostClauses, filter: filterClauses }
            },
            sort: this._sortClause(sort),
            aggs: this.filters.getAggregations()
        };
    }

    /** Advanced BM25 honoring search_in; inventor arm included for all-field searches. */
    _buildAdvancedBm25Clause(query, searchIn, searchFields, fuzz) {
        if (searchIn && searchIn.length > 0) {
            return this.buildConstrainedSearchInClause(query, searchIn, fuzz);
        }
        const textBm25 = this.buildStrictBm25Must(query, searchFields, fuzz);
        const inventorClause = this.buildInventorMatchClause(query, fuzz);
        return inventorClause
            ? { bool: { should: [textBm25, inventorClause], minimum_should_match: 1 } }
            : textBm25;
    }


    /** BM25/vector weights from pre-check hit ratio (lexical-rich vs sparse-lexical). */
    _resolveHybridWeights(bm25HitCount, candidateK) {
        const base = this.searchConfig.hybridWeights;
        const adaptive = this.searchConfig.adaptiveHybridWeights;
        if (!adaptive || bm25HitCount == null || !candidateK) return base;
        const ratio = bm25HitCount / candidateK;
        if (ratio >= adaptive.lexicalRichRatio) return adaptive.lexicalRich;
        if (ratio < adaptive.semanticRatio) return adaptive.semantic;
        return base;
    }

    /** SHOULD: titles containing ALL query terms (un-stemmed) rank above partial coverage. */
    _buildTitleCoverageClause(query, boost = 5) {
        const words = query.trim().split(/\s+/).filter(Boolean);
        if (words.length < 2) return null;
        return { match: { 'title.standard': { query, operator: 'and', boost } } };
    }

    /**
     * Adaptive min_score from the same pre-check ratio as `_resolveHybridWeights`.
     * Sparse-lexical queries use `semanticRelevant`; lexically-rich keep `relevant`.
     */
    _resolveMinScore(bm25HitCount, candidateK) {
        const ms = this.searchConfig.minScore;
        const adaptive = this.searchConfig.adaptiveHybridWeights;
        if (!adaptive || bm25HitCount == null || !candidateK) return ms.relevant;
        const ratio = bm25HitCount / candidateK;
        if (ratio < adaptive.semanticRatio) return ms.semanticRelevant;
        return ms.relevant;
    }

    /**
     * Normalized hybrid (relevance/normalized): sigmoid BM25 + knn_score on comparable scales,
     * plus a lexical floor. Sparse-lexical queries use a lower min_score via `_resolveMinScore`
     * because pure-kNN tops out near `weights.vector * knn_score` (~1.2) and would fail `relevant`.
     */
    /**
     * One summed script_score function per refine-chain anchor, carrying forward that anchor's
     * own per-doc relevance score (captured by IpSearchService._buildRefineAnchorIdFilter) instead
     * of discarding it once a doc clears the membership filter. Without this, ranking after a
     * narrow-down reflects only the newest term — a doc that was the #1 match for every prior
     * query gets buried behind docs that are merely mediocre-but-decent on all terms. Weighted
     * below the current term's own contribution since the newest query is still the primary intent.
     */
    _buildRefineAnchorScoreFunctions(refineScoreMaps = []) {
        const weight = this.searchConfig.refineAnchorWeight ?? 0.5;
        return refineScoreMaps
            .filter((scoreMap) => scoreMap && Object.keys(scoreMap).length > 0)
            .map((scoreMap) => ({
                script_score: {
                    script: {
                        source: "params.scores.getOrDefault(doc['mongo_id'].value, 0.0)",
                        lang: 'painless',
                        params: { scores: scoreMap }
                    }
                },
                weight
            }));
    }

    buildNormalizedHybridQuery(query, embedding, filters, page, perPage, searchIn = null, { bm25HitCount = null, candidateK = null, refineChain = [], refineFilterClauses = null, refineScoreMaps = [] } = {}) {
        const from = (page - 1) * perPage;
        const filterClauses = this.filters.buildFilters(filters);
        const searchFields = this.filters.getHybridSearchFields(searchIn);
        const weights = this._resolveHybridWeights(bm25HitCount, candidateK);
        const minScore = this._resolveMinScore(bm25HitCount, candidateK);
        const chain = normalizeChain(refineChain);
        const searchAllFields = !searchIn || searchIn.length === 0;

        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;

        const bm25Clause = this._buildAdvancedBm25Clause(query, searchIn, searchFields, { fuzziness: 'AUTO' });
        const knnRecall = { knn: { embedding: { vector: embedding, k: 100 } } };

        // Floor only basic's strict literal matches so basic ⊂ advanced without admitting fuzzy near-misses.
        const lexicalFloorClause = this.buildLiteralPrimaryClause(query, searchIn);

        // Fold literal clause into recall (not only the floor filter) so basic hits are structurally present.
        const recallGate = { bool: { should: [bm25Clause, knnRecall, lexicalFloorClause], minimum_should_match: 1 } };

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

        // min_score is applied on the INNER function_score (base bm25/knn/lexical-floor relevance
        // only) so it decides recall exactly as it did before refine-chain boosting existed. The
        // anchor-chain boost is then summed on top by the OUTER function_score with no min_score
        // of its own — it re-ranks the already-qualifying set, it never pulls in a document that
        // failed the relevance bar on its own merits (that would silently inflate recall: a doc
        // could "qualify" purely because it matched an earlier query, not the current one).
        const anchorScoreFunctions = this._buildRefineAnchorScoreFunctions(refineScoreMaps);
        const baseFunctionScore = {
            query: {
                bool: { must: [recallGate], should: boostClauses, filter: filterClauses }
            },
            functions: [
                {
                    script_score: {
                        script: { source: `${weights.bm25} * (_score / (1.0 + _score))`, lang: 'painless' }
                    }
                },
                {
                    script_score: {
                        script: {
                            source: 'knn_score',
                            lang: 'knn',
                            params: { field: 'embedding', query_value: embedding, space_type: 'cosinesimil' }
                        }
                    },
                    weight: weights.vector
                },
                // Literal hits always clear the higher `relevant` bar, even under semantic min_score.
                { filter: lexicalFloorClause, weight: this.searchConfig.minScore.relevant }
            ],
            score_mode: 'sum',
            boost_mode: 'replace',
            min_score: minScore
        };

        const finalQuery = anchorScoreFunctions.length > 0
            ? {
                function_score: {
                    query: { function_score: baseFunctionScore },
                    functions: anchorScoreFunctions,
                    score_mode: 'sum',
                    boost_mode: 'sum'
                }
            }
            : { function_score: baseFunctionScore };

        return {
            size: perPage,
            from,
            track_total_hits: true,
            _source: ['mongo_id'],
            query: finalQuery,
            aggs: this.filters.getAggregations()
        };
    }
}
