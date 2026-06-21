import { getSpellingVariant } from './SpellingVariants.js';

/**
 * Constructs every OpenSearch query body and clause used by search: basic BM25,
 * hybrid (BM25 + kNN), impact-weighted, and normalized-hybrid, plus the shared
 * author/field clause builders.
 *
 * Ranking intent shared across modes: an exact whole-phrase match outranks a
 * near-phrase match, which outranks scattered individual-word matches, which
 * outrank purely-semantic (kNN-only) matches.
 */
export default class QueryBuilder {
    constructor({ searchConfig, filterBuilder, rosterService }) {
        this.searchConfig = searchConfig;
        this.filters = filterBuilder;
        this.roster = rosterService;
    }

    /**
     * Nested author match WITHOUT the IITD roster filter. Only valid for author-scoped
     * search where an anchor filter already restricts results to one IITD faculty's papers.
     */
    _buildNonGatedAuthorMatchClause(query, { fuzziness } = {}) {
        const terms = (query || '').trim().split(/\s+/).filter(Boolean);
        if (!terms.length) return null;
        const b = this.searchConfig.fieldBoosts;
        const fuzz = fuzziness != null ? { fuzziness } : {};
        return {
            nested: {
                path: 'authors',
                score_mode: 'max',
                query: {
                    bool: {
                        must: terms.map((term) => ({
                            bool: {
                                should: [
                                    { match: { 'authors.author_name': { query: term, boost: b.authorName * 1.5, ...fuzz } } },
                                    { match: { 'authors.author_name_variants': { query: term, boost: b.authorVariants, ...fuzz } } }
                                ],
                                minimum_should_match: 1
                            }
                        }))
                    }
                }
            }
        };
    }

    /**
     * Nested author match constrained to the IITD Faculty roster (plus any
     * extraAuthorScopusIds, e.g. an anchor author). Co-authors off the roster cannot match.
     */
    buildIITDAuthorMatchClause(query, { fuzziness, boost, extraAuthorScopusIds = [], iitdScopusIds = null } = {}) {
        const terms = (query || '').trim().split(/\s+/).filter(Boolean);
        const roster = iitdScopusIds || this.roster.current();
        if (!terms.length || !roster || roster.length === 0) return null;
        const allowed = extraAuthorScopusIds?.length
            ? [...new Set([...roster, ...extraAuthorScopusIds.map(String)])]
            : roster;
        const b = this.searchConfig.fieldBoosts;
        const fuzz = fuzziness != null ? { fuzziness } : {};
        const termShould = (term) => ({
            bool: {
                should: [
                    { match: { 'authors.author_name': { query: term, boost: b.authorName * 1.5, ...fuzz } } },
                    { match: { 'authors.author_name_variants': { query: term, boost: b.authorVariants, ...fuzz } } }
                ],
                minimum_should_match: 1
            }
        });
        const nested = {
            nested: {
                path: 'authors',
                score_mode: 'max',
                query: {
                    bool: {
                        must: terms.map(termShould),
                        filter: [{ terms: { 'authors.author_id': allowed } }]
                    }
                }
            }
        };
        if (boost != null) nested.nested.boost = boost;
        return nested;
    }

    /**
     * Field-scoped clause when search_in is set.
     * - Author-only: Mongo-resolved Faculty Scopus ids + kerberos -> terms; else nested
     *   authors restricted to the IITD roster (unless authorScoped).
     * - Mixed fields: each token must match at least one selected field group.
     *
     * `literalMatch` (basic) matches only the un-stemmed `.standard` sub-fields.
     */
    buildConstrainedSearchInClause(query, searchIn, matchOpts = {}, facultyAuthorIds = null, facultyKerberosIds = null) {
        const terms = query.trim().split(/\s+/).filter((t) => t.length > 0);
        if (!terms.length) return { match_all: {} };
        const fuzz = matchOpts.fuzziness != null ? { fuzziness: matchOpts.fuzziness } : {};
        const b = this.searchConfig.fieldBoosts;
        const iitdScopusIds = this.roster.current();
        const authorScoped = !!matchOpts.authorScoped;
        const literalMatch = !!matchOpts.literalMatch;

        if (searchIn.length === 1 && searchIn[0] === 'author') {
            if ((facultyAuthorIds && facultyAuthorIds.length > 0) || (facultyKerberosIds && facultyKerberosIds.length > 0)) {
                const should = [];
                if (facultyAuthorIds?.length > 0) {
                    should.push(
                        { terms: { author_ids: facultyAuthorIds } },
                        { nested: { path: 'authors', query: { terms: { 'authors.author_id': facultyAuthorIds } } } }
                    );
                }
                if (facultyKerberosIds?.length > 0) {
                    should.push({ terms: { kerberos: facultyKerberosIds } });
                }
                return { bool: { should, minimum_should_match: 1 } };
            }
            // Faculty resolver found nothing — fall back to a fuzzy nested author-name match.
            // Outside author-scoped context, HARD-FILTER to the IITD roster so non-affiliated
            // co-authors cannot cause matches.
            const nestedBool = {
                must: terms.map((term) => ({
                    bool: {
                        should: [
                            { match: { 'authors.author_name': { query: term, boost: b.authorName * 1.5, ...fuzz } } },
                            { match: { 'authors.author_name_variants': { query: term, boost: b.authorVariants, ...fuzz } } }
                        ],
                        minimum_should_match: 1
                    }
                }))
            };
            if (!authorScoped) {
                if (!iitdScopusIds || iitdScopusIds.length === 0) return { match_none: {} };
                nestedBool.filter = [{ terms: { 'authors.author_id': iitdScopusIds } }];
            }
            return { nested: { path: 'authors', score_mode: 'max', query: { bool: nestedBool } } };
        }

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

        const authorTerm = (term) => {
            const nestedBool = {
                must: [{
                    bool: {
                        should: [
                            { match: { 'authors.author_name': { query: term, boost: b.authorName * 1.5, ...fuzz } } },
                            { match: { 'authors.author_name_variants': { query: term, boost: b.authorVariants, ...fuzz } } }
                        ],
                        minimum_should_match: 1
                    }
                }]
            };
            if (!authorScoped) {
                if (!iitdScopusIds || iitdScopusIds.length === 0) return { match_none: {} };
                nestedBool.filter = [{ terms: { 'authors.author_id': iitdScopusIds } }];
            }
            return { nested: { path: 'authors', score_mode: 'max', query: { bool: nestedBool } } };
        };

        const subjectTerm = (term) => ({
            match: { subject_area: { query: term, boost: b.subjectArea * 1.2, ...fuzz } }
        });

        const fieldTerm = (term) => ({
            match: { field_associated: { query: term, boost: b.fieldAssociated * 1.2, ...fuzz } }
        });

        const oneTermAcrossSelectedFields = (term) => {
            const should = [];
            if (searchIn.includes('title')) should.push(titleTerm(term));
            if (searchIn.includes('abstract')) should.push(abstractTerm(term));
            if (searchIn.includes('author')) should.push(authorTerm(term));
            if (searchIn.includes('subject_area')) should.push(subjectTerm(term));
            if (searchIn.includes('field')) should.push(fieldTerm(term));
            return { bool: { should, minimum_should_match: should.length ? 1 : 0 } };
        };

        return { bool: { must: terms.map(oneTermAcrossSelectedFields) } };
    }

    /**
     * Author-only search-on-search: `anchorText` pins the person; `queryNarrow`
     * matches title + abstract inside that person's papers.
     */
    buildAuthorRefineNarrowMust(queryNarrow, anchorText, anchorFacultyIds, matchOpts = {}, anchorKerberosIds = null) {
        return {
            bool: {
                must: [
                    this.buildConstrainedSearchInClause(anchorText, ['author'], matchOpts, anchorFacultyIds, anchorKerberosIds),
                    this.buildConstrainedSearchInClause(queryNarrow, ['title', 'abstract'], matchOpts)
                ]
            }
        };
    }

    /**
     * Tiered phrase-priority SHOULD boosts. SHOULD-only: they reorder results
     * (exact phrase > near phrase > scattered words) without changing recall.
     * `literal` uses the un-stemmed `.standard` sub-fields (basic mode).
     */
    _buildPhraseBoostTiers(query, { literal = false } = {}) {
        const words = query.trim().split(/\s+/).filter(Boolean);
        if (words.length < 2) return [];
        const titleField = literal ? 'title.standard' : 'title';
        const abstractField = literal ? 'abstract.standard' : 'abstract';
        return [
            { match_phrase: { [titleField]: { query, slop: 0, boost: 20 } } },
            { match_phrase: { [titleField]: { query, slop: 2, boost: 10 } } },
            { match_phrase: { [abstractField]: { query, slop: 0, boost: 6 } } },
            { match_phrase: { [abstractField]: { query, slop: 4, boost: 3 } } }
        ];
    }

    /**
     * Per-term BM25 clause for advanced mode.
     * <=3 terms: all terms required (strict). 4+: should with ~75% minimum_should_match.
     */
    buildStrictBm25Must(query, searchFields, fuzz = { fuzziness: 'AUTO' }, { strict = false } = {}) {
        const terms = query.trim().split(/\s+/).filter(t => t.length > 0);

        if (terms.length <= 1) {
            const variant = getSpellingVariant(terms[0] || query);
            if (variant) {
                return {
                    bool: {
                        should: [
                            { multi_match: { query: query, fields: searchFields, type: 'best_fields', tie_breaker: 0.3, ...fuzz } },
                            { multi_match: { query: variant, fields: searchFields, type: 'best_fields', tie_breaker: 0.3, ...fuzz } }
                        ],
                        minimum_should_match: 1
                    }
                };
            }
            return {
                multi_match: { query: query, fields: searchFields, type: 'best_fields', tie_breaker: 0.3, ...fuzz }
            };
        }

        const clauses = terms.map(term => {
            const variant = getSpellingVariant(term);
            if (variant) {
                return {
                    bool: {
                        should: [
                            { multi_match: { query: term, fields: searchFields, type: 'best_fields', tie_breaker: 0.3, ...fuzz } },
                            { multi_match: { query: variant, fields: searchFields, type: 'best_fields', tie_breaker: 0.3, ...fuzz } }
                        ],
                        minimum_should_match: 1
                    }
                };
            }
            return {
                multi_match: { query: term, fields: searchFields, type: 'best_fields', tie_breaker: 0.3, ...fuzz }
            };
        });

        if (terms.length <= 3 || strict) {
            return { bool: { must: clauses } };
        }

        const minRequired = Math.max(3, Math.ceil(terms.length * 0.75));
        return { bool: { should: clauses, minimum_should_match: minRequired } };
    }

    /**
     * The strict, un-fuzzy, all-terms literal clause that basic mode uses to RECALL a document
     * for the primary query. This is exactly the set of documents basic mode returns, so it is
     * reused as the advanced lexical-floor filter to guarantee basic results are a subset of
     * advanced — without flooring the looser fuzzy/partial matches that advanced additionally
     * recalls (which would let near-gibberish fuzzy matches clear the relevance bar).
     */
    buildLiteralPrimaryClause(query, searchIn = null, { authorScoped = false, facultyAuthorIds = null, facultyKerberosIds = null, authorRefineNarrow = false, refineWithinAnchor = null } = {}) {
        const literalFields = this.filters.getSearchFields(searchIn, { literalMatch: true });
        const authorOnly = searchIn?.length === 1 && searchIn[0] === 'author';
        const csiOpts = { authorScoped, literalMatch: true };

        if (searchIn && searchIn.length > 0) {
            if (authorRefineNarrow && authorOnly && refineWithinAnchor?.trim()) {
                return this.buildAuthorRefineNarrowMust(query, refineWithinAnchor, facultyAuthorIds, csiOpts, facultyKerberosIds);
            }
            return this.buildConstrainedSearchInClause(query, searchIn, csiOpts, facultyAuthorIds, facultyKerberosIds);
        }

        const base = this._buildCrossFieldsWithVariants(query, literalFields);
        const authorClause = authorScoped
            ? this._buildNonGatedAuthorMatchClause(query)
            : this.buildIITDAuthorMatchClause(query);
        return authorClause
            ? { bool: { should: [base, authorClause], minimum_should_match: 1 } }
            : base;
    }

    /**
     * cross_fields query (basic mode) honoring British/American spelling variants.
     */
    _buildCrossFieldsWithVariants(query, searchFields) {
        const words = query.trim().split(/\s+/);
        const hasVariant = words.some(w => getSpellingVariant(w) !== null);
        if (!hasVariant) {
            return { multi_match: { query, fields: searchFields, type: 'cross_fields', operator: 'and' } };
        }
        const variantWords = words.map(w => getSpellingVariant(w) || w);
        const variantQuery = variantWords.join(' ');
        return {
            bool: {
                should: [
                    { multi_match: { query, fields: searchFields, type: 'cross_fields', operator: 'and' } },
                    { multi_match: { query: variantQuery, fields: searchFields, type: 'cross_fields', operator: 'and' } }
                ],
                minimum_should_match: 1
            }
        };
    }

    /**
     * Basic mode: strict BM25 only (no embeddings, no fuzziness on the primary match).
     * cross_fields + operator:and for precise multi-word matching. Supports refine_within.
     */
    buildBasicQuery(query, filters, page, perPage, sort, searchIn = null, refineWithin = null, facultyAuthorIds = null, refineFacultyIds = null, authorRefineNarrow = false, facultyKerberosIds = null, refineKerberosIds = null, { authorScoped = false } = {}) {
        const from = (page - 1) * perPage;
        const filterClauses = this.filters.buildFilters(filters);

        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;
        const searchAllFields = !searchIn || searchIn.length === 0;
        const authorOnly = searchIn?.length === 1 && searchIn[0] === 'author';

        const primaryOpts = { authorScoped, facultyAuthorIds, facultyKerberosIds, authorRefineNarrow, refineWithinAnchor: refineWithin };
        const mustClauses = [this.buildLiteralPrimaryClause(query, searchIn, primaryOpts)];
        if (refineWithin && !(authorRefineNarrow && authorOnly)) {
            const refineOpts = { authorScoped, facultyAuthorIds: refineFacultyIds, facultyKerberosIds: refineKerberosIds };
            mustClauses.push(this.buildLiteralPrimaryClause(refineWithin, searchIn, refineOpts));
        }

        const boostClauses = [];

        const phraseOnTitleAbstract = searchAllFields || searchIn.includes('title') || searchIn.includes('abstract')
            || authorRefineNarrow;
        if (isMultiWord && phraseOnTitleAbstract) {
            boostClauses.push(...this._buildPhraseBoostTiers(query, { literal: true }));
        }

        // Soft morphology boost: a low-weight nudge on the stemmed root fields so e.g.
        // "communication" ranking benefits from "communications" papers, while a
        // stemmed-only match (like "community") can never beat a literal match.
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

        if (searchAllFields || searchIn.includes('subject_area')) {
            boostClauses.push({ match: { subject_area: { query: query, boost: 2.0 } } });
        }

        if (searchAllFields || searchIn.includes('field')) {
            boostClauses.push({ match: { field_associated: { query: query, boost: 1.5 } } });
        }

        let sortClause = ['_score'];
        if (sort === 'date') {
            sortClause = [{ publication_year: 'desc' }, '_score'];
        } else if (sort === 'citations') {
            sortClause = [{ citation_count: 'desc' }, '_score'];
        }

        return {
            size: perPage,
            from,
            track_total_hits: true,
            _source: ['mongo_id'],
            query: {
                bool: { must: mustClauses, should: boostClauses, filter: filterClauses }
            },
            sort: sortClause,
            aggs: this.filters.getAggregations()
        };
    }

    /**
     * Advanced hybrid (BM25 + kNN) for date/citations sort, where primary ordering is by
     * field rather than score. Either BM25 or kNN can recall a candidate.
     */
    buildHybridQuery(query, embedding, filters, page, perPage, sort, searchIn = null, facultyAuthorIds = null, authorRefineNarrow = false, refineWithinAnchor = null, facultyKerberosIds = null, { authorScoped = false } = {}) {
        const from = (page - 1) * perPage;
        const filterClauses = this.filters.buildFilters(filters);
        const searchFields = this.filters.getHybridSearchFields(searchIn);

        const searchAllFields = !searchIn || searchIn.length === 0;
        const authorOnly = searchIn?.length === 1 && searchIn[0] === 'author';

        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;

        const boostClauses = [];

        if (isMultiWord && (searchAllFields || searchIn.includes('title') || searchIn.includes('abstract') || (authorRefineNarrow && authorOnly))) {
            boostClauses.push(...this._buildPhraseBoostTiers(query));
        }

        if (searchAllFields || searchIn.includes('subject_area')) {
            boostClauses.push({ match: { subject_area: { query: query, boost: 2.0 } } });
        }

        if (searchAllFields || searchIn.includes('field')) {
            boostClauses.push({ match: { field_associated: { query: query, boost: 1.5 } } });
        }

        const csiOpts = { fuzziness: 'AUTO', authorScoped };
        let bm25Clause;
        if (authorRefineNarrow && authorOnly && refineWithinAnchor?.trim()) {
            bm25Clause = this.buildAuthorRefineNarrowMust(query, refineWithinAnchor, facultyAuthorIds, csiOpts, facultyKerberosIds);
        } else if (searchIn && searchIn.length > 0) {
            bm25Clause = this.buildConstrainedSearchInClause(query, searchIn, csiOpts, facultyAuthorIds, facultyKerberosIds);
        } else {
            const textBm25 = this.buildStrictBm25Must(query, searchFields);
            const authorClause = authorScoped
                ? this._buildNonGatedAuthorMatchClause(query, { fuzziness: 'AUTO' })
                : this.buildIITDAuthorMatchClause(query, { fuzziness: 'AUTO' });
            bm25Clause = authorClause
                ? { bool: { should: [textBm25, authorClause], minimum_should_match: 1 } }
                : textBm25;
        }

        const knnRecall = { knn: { embedding: { vector: embedding, k: 100 } } };
        const recallGate = { bool: { should: [bm25Clause, knnRecall], minimum_should_match: 1 } };

        let sortClause = ['_score'];
        if (sort === 'date') {
            sortClause = [{ publication_year: 'desc' }, '_score'];
        } else if (sort === 'citations') {
            sortClause = [{ citation_count: 'desc' }, '_score'];
        }

        return {
            size: perPage,
            from,
            track_total_hits: true,
            _source: ['mongo_id'],
            query: {
                bool: { must: [recallGate], should: boostClauses, filter: filterClauses }
            },
            sort: sortClause,
            aggs: this.filters.getAggregations()
        };
    }

    /**
     * Impact-weighted hybrid: combines relevance with log-scale citation count and recency.
     */
    buildImpactQuery(query, embedding, filters, page, perPage, searchIn = null, facultyAuthorIds = null, authorRefineNarrow = false, refineWithinAnchor = null, facultyKerberosIds = null, { authorScoped = false } = {}) {
        const from = (page - 1) * perPage;
        const filterClauses = this.filters.buildFilters(filters);
        const searchFields = this.filters.getHybridSearchFields(searchIn);
        const currentYear = new Date().getFullYear();
        const searchAllFields = !searchIn || searchIn.length === 0;
        const authorOnly = searchIn?.length === 1 && searchIn[0] === 'author';

        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;

        const boostClauses = [];
        if (searchAllFields || searchIn.includes('subject_area')) {
            boostClauses.push({ match: { subject_area: { query: query, boost: 2.0 } } });
        }

        if (isMultiWord && (searchAllFields || searchIn.includes('title') || searchIn.includes('abstract') || (authorRefineNarrow && authorOnly))) {
            boostClauses.push(...this._buildPhraseBoostTiers(query));
        }

        const csiOpts = { fuzziness: 'AUTO', authorScoped };
        let bm25Clause;
        if (authorRefineNarrow && authorOnly && refineWithinAnchor?.trim()) {
            bm25Clause = this.buildAuthorRefineNarrowMust(query, refineWithinAnchor, facultyAuthorIds, csiOpts, facultyKerberosIds);
        } else if (searchIn && searchIn.length > 0) {
            bm25Clause = this.buildConstrainedSearchInClause(query, searchIn, csiOpts, facultyAuthorIds, facultyKerberosIds);
        } else {
            const textBm25 = this.buildStrictBm25Must(query, searchFields);
            const authorClause = authorScoped
                ? this._buildNonGatedAuthorMatchClause(query, { fuzziness: 'AUTO' })
                : this.buildIITDAuthorMatchClause(query, { fuzziness: 'AUTO' });
            bm25Clause = authorClause
                ? { bool: { should: [textBm25, authorClause], minimum_should_match: 1 } }
                : textBm25;
        }

        const knnRecall = { knn: { embedding: { vector: embedding, k: 100 } } };
        const recallGate = { bool: { should: [bm25Clause, knnRecall], minimum_should_match: 1 } };

        return {
            size: perPage,
            from,
            track_total_hits: true,
            min_score: this.searchConfig.minScore.impact,
            _source: ['mongo_id'],
            query: {
                function_score: {
                    query: {
                        bool: { must: [recallGate], should: boostClauses, filter: filterClauses }
                    },
                    functions: [
                        {
                            field_value_factor: {
                                field: 'citation_count',
                                factor: this.searchConfig.citationFactor,
                                modifier: 'log1p',
                                missing: 0
                            },
                            weight: 1.2
                        },
                        {
                            gauss: {
                                publication_year: {
                                    origin: currentYear,
                                    scale: this.searchConfig.recencyScale,
                                    decay: 0.5
                                }
                            },
                            weight: 0.8
                        }
                    ],
                    score_mode: 'sum',
                    boost_mode: 'multiply'
                }
            },
            aggs: this.filters.getAggregations()
        };
    }

    /**
     * Normalized hybrid (relevance sort): BM25 and kNN combined on comparable scales.
     *
     * OpenSearch with the FAISS engine does not support Painless cosineSimilarity(), so
     * vector similarity comes from the k-NN plugin's native `knn_score` script alongside a
     * sigmoid-normalized BM25 painless script.
     *
     * Final score (boost_mode=replace, score_mode=sum):
     *   bm25Weight * sigmoid(BM25) + vectorWeight * knn_score + lexicalFloor(if BM25 match)
     *
     * The lexical floor guarantees any lexical match (a superset of every basic-mode match)
     * clears `min_score`, so advanced results are a strict superset of basic, and exact/lexical
     * matches rank above purely-semantic ones that the relevance bar would otherwise prune.
     */
    buildNormalizedHybridQuery(query, embedding, filters, page, perPage, searchIn = null, facultyAuthorIds = null, authorRefineNarrow = false, refineWithinAnchor = null, facultyKerberosIds = null, { authorScoped = false } = {}) {
        const from = (page - 1) * perPage;
        const filterClauses = this.filters.buildFilters(filters);
        const searchFields = this.filters.getHybridSearchFields(searchIn);
        const weights = this.searchConfig.hybridWeights;
        const searchAllFields = !searchIn || searchIn.length === 0;
        const authorOnly = searchIn?.length === 1 && searchIn[0] === 'author';

        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;

        const fuzzSetting = { fuzziness: 'AUTO' };
        const csiOpts = { ...fuzzSetting, authorScoped };
        let bm25Clause;
        if (authorRefineNarrow && authorOnly && refineWithinAnchor?.trim()) {
            bm25Clause = this.buildAuthorRefineNarrowMust(query, refineWithinAnchor, facultyAuthorIds, csiOpts, facultyKerberosIds);
        } else if (searchIn && searchIn.length > 0) {
            bm25Clause = this.buildConstrainedSearchInClause(query, searchIn, csiOpts, facultyAuthorIds, facultyKerberosIds);
        } else {
            const textBm25 = this.buildStrictBm25Must(query, searchFields, fuzzSetting);
            const authorClause = authorScoped
                ? this._buildNonGatedAuthorMatchClause(query, fuzzSetting)
                : this.buildIITDAuthorMatchClause(query, { fuzziness: 'AUTO' });
            bm25Clause = authorClause
                ? { bool: { should: [textBm25, authorClause], minimum_should_match: 1 } }
                : textBm25;
        }

        const knnRecall = { knn: { embedding: { vector: embedding, k: 100 } } };
        // Either BM25 or kNN can recall; the lexical floor + min_score below prune the
        // weak kNN-only tail.
        const recallGate = { bool: { should: [bm25Clause, knnRecall], minimum_should_match: 1 } };

        // Floor only the STRICT literal matches basic mode would return (not the looser fuzzy
        // recall) so basic stays a subset of advanced without admitting near-gibberish fuzzy hits.
        const lexicalFloorClause = this.buildLiteralPrimaryClause(query, searchIn, {
            authorScoped, facultyAuthorIds, facultyKerberosIds, authorRefineNarrow, refineWithinAnchor
        });

        const boostClauses = [];
        if (searchAllFields || searchIn.includes('subject_area')) {
            boostClauses.push({ match: { subject_area: { query: query, boost: 2.0 } } });
        }

        if (isMultiWord && (searchAllFields || searchIn.includes('title') || searchIn.includes('abstract') || (authorRefineNarrow && authorOnly))) {
            boostClauses.push(...this._buildPhraseBoostTiers(query));
        }

        return {
            size: perPage,
            from,
            track_total_hits: true,
            min_score: this.searchConfig.minScore.relevant,
            _source: ['mongo_id'],
            query: {
                function_score: {
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
                        { filter: lexicalFloorClause, weight: this.searchConfig.minScore.relevant }
                    ],
                    score_mode: 'sum',
                    boost_mode: 'replace'
                }
            },
            aggs: this.filters.getAggregations()
        };
    }
}
