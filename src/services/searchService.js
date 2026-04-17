import crypto from 'crypto';
import '../models/departments.js'; // Ensure Department model is registered for populate

/**
 * Search Service
 * Orchestrates hybrid search across OpenSearch and MongoDB
 * 
 * Optimizations:
 * - Field weighting with subject_area boosting
 * - Phrase matching for multi-word queries
 * - Hybrid score normalization (BM25 + k-NN)
 * - Citation-impact scoring option
 * - Nested author search support
 */
export default class SearchService {
    constructor(fastify, config) {
        this.opensearch = fastify.opensearch;
        this.indexName = fastify.opensearchIndex;
        this.redis = fastify.redis;
        this.redisTTL = fastify.redisTTL;
        this.mongoose = fastify.mongoose;
        this.embeddingService = fastify.embeddingService;
        this.config = config;
        this.logger = fastify.log;

        // Search tuning parameters (easily adjustable)
        this.searchConfig = {
            hybridWeights: {
                bm25: 0.4,
                vector: 0.6
            },
            fieldBoosts: {
                title: 4,
                titleExact: 5,
                abstract: 1.5,
                subjectArea: 3,
                subjectAreaNgram: 2,
                authorName: 2,
                authorNameNgram: 1.5,
                authorVariants: 2.5,
                authorVariantsNgram: 1.5,
                fieldAssociated: 2.5,
                fieldAssociatedNgram: 1.5
            },
            phraseBoost: 2.5,
            citationFactor: 0.3,
            recencyScale: 5,
            // Minimum score thresholds to filter low-confidence results
            minScore: {
                hybrid: 0.5,      // For BM25 + k-NN hybrid queries
                impact: 0.5,      // For function_score impact queries  
                normalized: 0.15  // For normalized 0-1 scale scores
            }
        };
    }

    /**
     * Get the British/American English spelling variant of a word, if one exists.
     * Returns null if no variant is known.
     */
    _getSpellingVariant(word) {
        const w = word.toLowerCase();
        // [american, british] pairs
        const pairs = [
            ['color', 'colour'], ['favor', 'favour'], ['honor', 'honour'],
            ['humor', 'humour'], ['labor', 'labour'], ['neighbor', 'neighbour'],
            ['vapor', 'vapour'], ['fiber', 'fibre'], ['center', 'centre'],
            ['liter', 'litre'], ['meter', 'metre'], ['caliber', 'calibre'],
            ['theater', 'theatre'], ['defense', 'defence'], ['offense', 'offence'],
            ['license', 'licence'], ['practice', 'practise'],
            ['analyze', 'analyse'], ['catalyze', 'catalyse'],
            ['optimize', 'optimise'], ['recognize', 'recognise'],
            ['characterize', 'characterise'], ['minimize', 'minimise'],
            ['maximize', 'maximise'], ['utilize', 'utilise'],
            ['realize', 'realise'], ['organize', 'organise'],
            ['stabilize', 'stabilise'], ['polymerize', 'polymerise'],
            ['synthesize', 'synthesise'], ['oxidize', 'oxidise'],
            ['ionize', 'ionise'], ['polarize', 'polarise'],
            ['crystallize', 'crystallise'], ['paralyze', 'paralyse'],
            ['modeling', 'modelling'], ['traveling', 'travelling'],
            ['labeling', 'labelling'], ['canceling', 'cancelling'],
            ['aluminum', 'aluminium'], ['sulfur', 'sulphur'],
            ['aging', 'ageing'], ['gray', 'grey'],
        ];
        for (const [am, br] of pairs) {
            if (w === am) return br;
            if (w === br) return am;
            // Derived forms: colorful→colourful, colorimetric→colourimetric, etc.
            if (w.startsWith(am)) return br + w.slice(am.length);
            if (w.startsWith(br)) return am + w.slice(br.length);
        }
        return null;
    }

    /**
     * Dedupe + sort search_in so cache keys match regardless of field order from the client.
     */
    _normalizeSearchIn(searchIn) {
        if (!searchIn || !Array.isArray(searchIn) || searchIn.length === 0) return null;
        const allowed = new Set(['title', 'abstract', 'author', 'subject_area', 'field']);
        const unique = [...new Set(searchIn.filter((f) => allowed.has(f)))];
        unique.sort();
        return unique.length ? unique : null;
    }

    /**
     * Generate cache key for search results
     * Normalizes filters to ensure consistent caching
     */
    _getCacheKey(query, filters, sort, page, perPage, searchIn = null) {
        const normalizedFilters = filters ? Object.fromEntries(
            Object.entries(filters).filter(([_, v]) => v !== undefined && v !== null && v !== '')
        ) : {};

        const payload = JSON.stringify({
            query,
            filters: normalizedFilters,
            sort,
            page,
            perPage,
            searchIn: searchIn || 'default'
        });
        const hash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
        return `search:${hash}`;
    }

    /**
     * Build OpenSearch filter clauses from request filters
     */
    _buildFilters(filters) {
        const mustFilters = [];

        if (filters?.year_from || filters?.year_to) {
            mustFilters.push({
                range: {
                    publication_year: {
                        ...(filters.year_from && { gte: filters.year_from }),
                        ...(filters.year_to && { lte: filters.year_to })
                    }
                }
            });
        }

        if (filters?.field_associated) {
            mustFilters.push({
                match: {
                    field_associated: {
                        query: filters.field_associated,
                        fuzziness: 'AUTO'
                    }
                }
            });
        }

        if (filters?.document_type) {
            mustFilters.push({ term: { document_type: filters.document_type } });
        }

        // Support both single and array document types
        if (filters?.document_types?.length) {
            mustFilters.push({ terms: { document_type: filters.document_types } });
        }

        if (filters?.subject_area?.length) {
            mustFilters.push({ terms: { 'subject_area.keyword': filters.subject_area } });
        }

        // Author filter: union of nested authors.author_id AND top-level kerberos
        // when _authorKerberos has been pre-resolved from Faculty.email
        if (filters?.author_id) {
            const authorNestedClause = {
                nested: {
                    path: 'authors',
                    query: { term: { 'authors.author_id': filters.author_id } }
                }
            };
            if (filters._authorKerberos) {
                mustFilters.push({
                    bool: {
                        should: [
                            authorNestedClause,
                            { term: { kerberos: filters._authorKerberos } }
                        ],
                        minimum_should_match: 1
                    }
                });
            } else {
                mustFilters.push(authorNestedClause);
            }
        }

        // author_affiliation removed from schema — affiliation filter disabled

        if (filters?.first_author_only === true) {
            mustFilters.push({
                nested: {
                    path: 'authors',
                    query: { term: { 'authors.author_position': 1 } }
                }
            });
        }

        // Interdisciplinary filter (3+ subject areas)
        if (filters?.interdisciplinary === true) {
            mustFilters.push({
                range: { subject_area_count: { gte: 3 } }
            });
        }

        if (filters?.kerberos) {
            mustFilters.push({ term: { kerberos: filters.kerberos } });
        }

        return mustFilters;
    }

    /**
     * Get optimized search fields with boosting
     * 
     * Boost rationale:
     * - title^4: Highest - query terms in title = strong match
     * - title.exact^5: Exact title match = very strong
     * - subject_area^3: Field matches = domain relevance
     * - author_names^2: Author search common use case
     * - field_associated^2.5: Department relevance
     * Note: abstract removed - semantic search via embeddings handles this
     */
    _getSearchFields(searchIn = null) {
        const b = this.searchConfig.fieldBoosts;

        // Default comprehensive search with optimized weights
        // Includes .standard sub-fields for un-stemmed fuzzy matching
        // and .autocomplete sub-fields for prefix/partial matching
        const defaultFields = [
            `title^${b.title}`,
            `title.exact^${b.titleExact}`,
            `title.standard^${b.title * 0.8}`,
            `title.autocomplete^${b.title * 0.5}`,
            `abstract^${b.abstract}`,
            `abstract.standard^${b.abstract * 0.8}`,
            `subject_area^${b.subjectArea}`,
            `subject_area.ngram^${b.subjectAreaNgram}`,
            `author_names^${b.authorName}`,
            `author_names.ngram^${b.authorNameNgram}`,
            `author_names.autocomplete^${b.authorName * 0.5}`,
            `field_associated^${b.fieldAssociated}`,
            `field_associated.ngram^${b.fieldAssociatedNgram}`
        ];

        if (!searchIn || searchIn.length === 0) {
            return defaultFields;
        }

        // Field-specific search with optimized boosts
        const fieldMapping = {
            title: [
                `title^${b.title}`,
                `title.exact^${b.titleExact}`,
                `title.standard^${b.title * 0.8}`,
                `title.autocomplete^${b.title * 0.5}`
            ],
            abstract: [
                `abstract^${b.abstract * 1.5}`,
                `abstract.standard^${b.abstract}`
            ],
            author: [
                `author_names^${b.authorName * 1.5}`,
                `author_names.ngram^${b.authorNameNgram}`,
                `author_names.autocomplete^${b.authorName * 0.5}`,
                `author_name_variants^${b.authorVariants}`,
                `author_name_variants.ngram^${b.authorVariantsNgram}`
            ],
            subject_area: [
                `subject_area^${b.subjectArea * 1.5}`,
                `subject_area.ngram^${b.subjectAreaNgram}`
            ],
            field: [
                `field_associated^${b.fieldAssociated * 1.5}`,
                `field_associated.ngram^${b.fieldAssociatedNgram}`
            ]
        };

        return searchIn
            .flatMap(f => fieldMapping[f] || [])
            .filter(Boolean);
    }

    /**
     * Build aggregations for faceted search
     */
    _getAggregations() {
        return {
            years: {
                terms: { field: 'publication_year', size: 30, order: { _key: 'desc' } }
            },
            year_ranges: {
                range: {
                    field: 'publication_year',
                    ranges: [
                        { key: '2020-Present', from: 2020 },
                        { key: '2010-2019', from: 2010, to: 2020 },
                        { key: '2000-2009', from: 2000, to: 2010 },
                        { key: 'Pre-2000', to: 2000 }
                    ]
                }
            },
            document_types: {
                terms: { field: 'document_type', size: 15 }
            },
            fields: {
                terms: { field: 'field_associated.keyword', size: 30 }
            },
            subject_areas: {
                terms: { field: 'subject_area.keyword', size: 50 }
            }
        };
    }

    _escapeRegexForMongo(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Resolve IIT Delhi Faculty.scopus_id values from a free-text author query (MongoDB).
     * Used when search_in is author-only so we match papers by canonical Scopus author id.
     * @returns {Promise<string[]>}
     */
    async _resolveFacultyScopusIdsForAuthorQuery(query) {
        const q = query.trim();
        if (!q) return { scopusIds: [], kerberosIds: [] };
        const Faculty = this.mongoose.model('Faculty');
        const esc = (s) => this._escapeRegexForMongo(s);
        const tokens = q.split(/\s+/).filter(Boolean);

        let candidates = [];

        const pattern = `^${esc(q).replace(/\s+/g, '\\s+')}$`;
        try {
            candidates = await Faculty.find({
                $expr: {
                    $regexMatch: {
                        input: { $trim: { input: { $concat: ['$firstName', ' ', '$lastName'] } } },
                        regex: pattern,
                        options: 'i'
                    }
                }
            })
                .select('scopus_id email')
                .limit(25)
                .lean();
        } catch (err) {
            this.logger.warn({ err }, 'Faculty full-name regex lookup failed');
        }

        if (candidates.length === 0 && tokens.length >= 2) {
            const first = tokens[0];
            const last = tokens.slice(1).join(' ');
            candidates = await Faculty.find({
                firstName: new RegExp(`^${esc(first)}$`, 'i'),
                lastName: new RegExp(`^${esc(last)}$`, 'i')
            })
                .select('scopus_id email')
                .limit(25)
                .lean();
        }

        if (candidates.length === 0 && tokens.length >= 2) {
            const last = tokens[tokens.length - 1];
            const first = tokens.slice(0, -1).join(' ');
            candidates = await Faculty.find({
                firstName: new RegExp(`^${esc(first)}$`, 'i'),
                lastName: new RegExp(`^${esc(last)}$`, 'i')
            })
                .select('scopus_id email')
                .limit(25)
                .lean();
        }

        if (candidates.length === 0 && tokens.length === 1) {
            const re = new RegExp(`^${esc(tokens[0])}$`, 'i');
            candidates = await Faculty.find({
                $or: [{ firstName: re }, { lastName: re }]
            })
                .select('scopus_id email')
                .limit(25)
                .lean();
        }

        const ids = new Set();
        const kerberosIds = new Set();
        for (const f of candidates) {
            for (const sid of f.scopus_id || []) {
                ids.add(String(sid));
            }
            if (f.email) {
                const k = f.email.split('@')[0].toLowerCase();
                if (k) kerberosIds.add(k);
            }
        }
        return { scopusIds: [...ids], kerberosIds: [...kerberosIds] };
    }

    /**
     * When search_in is set: constrains which fields the query may match.
     * - Author-only: optional Mongo faculty Scopus ids → terms; else nested authors only (no flat author_names).
     * - Mixed fields: each token must match at least one selected group (AND tokens, OR groups per token).
     * @param {object} [matchOpts] - Pass `{ fuzziness: 'AUTO' }` for advanced primary queries, `{ fuzziness: 2 }` only for advanced fuzzy fallback. Omit fuzziness for basic (strict token match).
     * @param {string[]|null} [facultyAuthorIds] - Author-only: restrict to these Scopus ids when resolved from Faculty.
     */
    _buildConstrainedSearchInClause(query, searchIn, matchOpts = {}, facultyAuthorIds = null, facultyKerberosIds = null) {
        const terms = query.trim().split(/\s+/).filter((t) => t.length > 0);
        if (!terms.length) {
            return { match_all: {} };
        }
        const fuzz = matchOpts.fuzziness != null ? { fuzziness: matchOpts.fuzziness } : {};
        const b = this.searchConfig.fieldBoosts;

        // Author-only: Mongo-resolved Faculty.scopus_id + kerberos → terms; else nested authors only.
        if (searchIn.length === 1 && searchIn[0] === 'author') {
            if ((facultyAuthorIds && facultyAuthorIds.length > 0) || (facultyKerberosIds && facultyKerberosIds.length > 0)) {
                const should = [];
                if (facultyAuthorIds?.length > 0) {
                    should.push(
                        { terms: { author_ids: facultyAuthorIds } },
                        {
                            nested: {
                                path: 'authors',
                                query: { terms: { 'authors.author_id': facultyAuthorIds } }
                            }
                        }
                    );
                }
                if (facultyKerberosIds?.length > 0) {
                    should.push({ terms: { kerberos: facultyKerberosIds } });
                }
                return {
                    bool: { should, minimum_should_match: 1 }
                };
            }
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

        const titleTerm = (term) => ({
            bool: {
                should: [
                    { match: { title: { query: term, boost: b.title, ...fuzz } } },
                    { match: { 'title.standard': { query: term, boost: b.title * 0.8, ...fuzz } } }
                ],
                minimum_should_match: 1
            }
        });

        const abstractTerm = (term) => ({
            bool: {
                should: [
                    { match: { abstract: { query: term, boost: b.abstract * 1.2, ...fuzz } } },
                    { match: { 'abstract.standard': { query: term, boost: b.abstract, ...fuzz } } }
                ],
                minimum_should_match: 1
            }
        });

        const authorTerm = (term) => ({
            bool: {
                should: [
                    { match: { author_names: { query: term, boost: b.authorName * 1.5, ...fuzz } } },
                    { match: { author_name_variants: { query: term, boost: b.authorVariants, ...fuzz } } },
                    {
                        nested: {
                            path: 'authors',
                            score_mode: 'max',
                            query: {
                                bool: {
                                    should: [
                                        { match: { 'authors.author_name': { query: term, boost: b.authorName * 1.5, ...fuzz } } },
                                        { match: { 'authors.author_name_variants': { query: term, boost: b.authorVariants, ...fuzz } } }
                                    ],
                                    minimum_should_match: 1
                                }
                            }
                        }
                    }
                ],
                minimum_should_match: 1
            }
        });

        const subjectTerm = (term) => ({
            match: {
                subject_area: { query: term, boost: b.subjectArea * 1.2, ...fuzz }
            }
        });

        const fieldTerm = (term) => ({
            match: {
                field_associated: { query: term, boost: b.fieldAssociated * 1.2, ...fuzz }
            }
        });

        const oneTermAcrossSelectedFields = (term) => {
            const should = [];
            if (searchIn.includes('title')) should.push(titleTerm(term));
            if (searchIn.includes('abstract')) should.push(abstractTerm(term));
            if (searchIn.includes('author')) should.push(authorTerm(term));
            if (searchIn.includes('subject_area')) should.push(subjectTerm(term));
            if (searchIn.includes('field')) should.push(fieldTerm(term));
            return {
                bool: {
                    should,
                    minimum_should_match: should.length ? 1 : 0
                }
            };
        };

        return {
            bool: {
                must: terms.map(oneTermAcrossSelectedFields)
            }
        };
    }

    /**
     * Author-only + search-on-search: `anchorText` (refine_within) pins the person via Faculty / nested author;
     * `queryNarrow` (current query box) matches title + abstract inside those papers.
     */
    _buildAuthorRefineNarrowMust(queryNarrow, anchorText, anchorFacultyIds, matchOpts = {}, anchorKerberosIds = null) {
        return {
            bool: {
                must: [
                    this._buildConstrainedSearchInClause(anchorText, ['author'], matchOpts, anchorFacultyIds, anchorKerberosIds),
                    this._buildConstrainedSearchInClause(queryNarrow, ['title', 'abstract'], matchOpts)
                ]
            }
        };
    }

    /**
     * Build a per-term BM25 clause for advanced mode.
     * Short queries (≤3 terms): all terms required (strict, avoids noisy matches).
     * Longer queries (4+): uses should with ~75% minimum_should_match so
     * natural-language phrases still find results.
     */
    _buildStrictBm25Must(query, searchFields, fuzz = { fuzziness: 'AUTO' }, { strict = false } = {}) {
        const terms = query.trim().split(/\s+/).filter(t => t.length > 0);

        // For a single term with a spelling variant, search for either form
        if (terms.length <= 1) {
            const variant = this._getSpellingVariant(terms[0] || query);
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
                multi_match: {
                    query: query,
                    fields: searchFields,
                    type: 'best_fields',
                    tie_breaker: 0.3,
                    ...fuzz
                }
            };
        }

        // For multi-term queries, wrap each term that has a variant in a should group
        const clauses = terms.map(term => {
            const variant = this._getSpellingVariant(term);
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
                multi_match: {
                    query: term,
                    fields: searchFields,
                    type: 'best_fields',
                    tie_breaker: 0.3,
                    ...fuzz
                }
            };
        });

        if (terms.length <= 3 || strict) {
            return { bool: { must: clauses } };
        }

        const minRequired = Math.max(3, Math.ceil(terms.length * 0.75));
        return {
            bool: {
                should: clauses,
                minimum_should_match: minRequired
            }
        };
    }

    /**
     * Build a cross_fields query that handles British/American spelling variants.
     * If any word has a variant, wraps the original + variant queries in should.
     */
    _buildCrossFieldsWithVariants(query, searchFields) {
        const words = query.trim().split(/\s+/);
        const hasVariant = words.some(w => this._getSpellingVariant(w) !== null);
        if (!hasVariant) {
            return {
                multi_match: { query, fields: searchFields, type: 'cross_fields', operator: 'and' }
            };
        }
        // Build variant query by replacing each word with its alternative
        const variantWords = words.map(w => this._getSpellingVariant(w) || w);
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
     * Build BM25-only query (Basic mode) — no embeddings, no ML
     * STRICT keyword matching: no fuzziness on the primary match.
     * Uses cross_fields + operator:and for precise multi-word matching.
     * Fuzziness is reserved for the fallback path only.
     * Supports refine_within for search-on-search narrowing
     */
    _buildBasicQuery(query, filters, page, perPage, sort, searchIn = null, refineWithin = null, facultyAuthorIds = null, refineFacultyIds = null, authorRefineNarrow = false, facultyKerberosIds = null, refineKerberosIds = null) {
        const from = (page - 1) * perPage;
        const filterClauses = this._buildFilters(filters);
        
        // Remove ngram and autocomplete fields to enforce exact word matching
        const searchFields = this._getSearchFields(searchIn)
            .filter(f => !f.includes('.ngram') && !f.includes('.autocomplete'));

        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;
        const searchAllFields = !searchIn || searchIn.length === 0;
        const authorOnly = searchIn?.length === 1 && searchIn[0] === 'author';

        // Primary MUST: constrained per search_in (author: Mongo ids or nested), else legacy cross_fields
        let mustClauses;
        if (searchIn && searchIn.length > 0) {
            if (authorRefineNarrow && authorOnly && refineWithin?.trim()) {
                mustClauses = [this._buildAuthorRefineNarrowMust(query, refineWithin, facultyAuthorIds, {}, facultyKerberosIds)];
            } else {
                mustClauses = [this._buildConstrainedSearchInClause(query, searchIn, {}, facultyAuthorIds, facultyKerberosIds)];
                if (refineWithin) {
                    mustClauses.push(this._buildConstrainedSearchInClause(refineWithin, searchIn, {}, refineFacultyIds, refineKerberosIds));
                }
            }
        } else {
            mustClauses = [this._buildCrossFieldsWithVariants(query, searchFields)];
            if (refineWithin) {
                mustClauses.push(this._buildCrossFieldsWithVariants(refineWithin, searchFields));
            }
        }

        // SHOULD (boost-only): only touch fields included in search_in (or full search)
        const boostClauses = [];

        const phraseOnTitleAbstract = searchAllFields || searchIn.includes('title') || searchIn.includes('abstract')
            || authorRefineNarrow;
        if (isMultiWord && phraseOnTitleAbstract) {
            boostClauses.push({
                multi_match: {
                    query: query,
                    fields: ['title^5', 'abstract^2'],
                    type: 'phrase',
                    slop: 2,
                    boost: this.searchConfig.phraseBoost
                }
            });
        }

        if (searchAllFields || searchIn.includes('subject_area')) {
            boostClauses.push({
                match: { subject_area: { query: query, boost: 2.0 } }
            });
        }

        if (searchAllFields || searchIn.includes('field')) {
            boostClauses.push({
                match: { field_associated: { query: query, boost: 1.5 } }
            });
        }

        // Sort clause
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
                bool: {
                    must: mustClauses,
                    should: boostClauses,
                    filter: filterClauses
                }
            },
            sort: sortClause,
            aggs: this._getAggregations()
        };
    }

    /**
     * Build OpenSearch tiered query for strict priority sorting
     * 
     * Priority:
     * 1. Title matches (Score: 10)
     * 2. Other matches (Score: 1)
     * 
     * Secondary Sort:
     * - Citation Count (desc)
     * - Publication Year (desc)
     */
         _buildHybridQuery(query, embedding, filters, page, perPage, sort, searchIn = null, facultyAuthorIds = null, authorRefineNarrow = false, refineWithinAnchor = null, facultyKerberosIds = null) {
        const from = (page - 1) * perPage;
        const filterClauses = this._buildFilters(filters);
        // For advanced search fuzzy matching, n-gram fields generate too much noise. Filter them out.
        const searchFields = this._getSearchFields(searchIn)
            .filter(f => !f.includes('.ngram') && !f.includes('.autocomplete'));

        const searchAllFields = !searchIn || searchIn.length === 0;
        const authorOnly = searchIn?.length === 1 && searchIn[0] === 'author';

        // Detect multi-word query for phrase boosting
        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;

        // Build BOOST-only should clauses (ranking, not matching)
        const boostClauses = [];

        if (isMultiWord && (searchAllFields || searchIn.includes('title') || searchIn.includes('abstract') || (authorRefineNarrow && authorOnly))) {
            boostClauses.push({
                multi_match: {
                    query: query,
                    fields: ['title^5', 'abstract^2'],
                    type: 'phrase',
                    slop: 2,
                    boost: this.searchConfig.phraseBoost
                }
            });
        }

        if (searchAllFields || searchIn.includes('subject_area')) {
            boostClauses.push({
                match: {
                    subject_area: {
                        query: query,
                        boost: 2.0
                    }
                }
            });
        }

        if (searchAllFields || searchIn.includes('field')) {
            boostClauses.push({
                match: {
                    field_associated: {
                        query: query,
                        boost: 1.5
                    }
                }
            });
        }

        // k-NN vector search as BOOST ONLY (improves ranking, doesn't expand result set)
        boostClauses.push({
            knn: {
                embedding: {
                    vector: embedding,
                    k: 100
                }
            }
        });

        let bm25Must;
        if (authorRefineNarrow && authorOnly && refineWithinAnchor?.trim()) {
            bm25Must = this._buildAuthorRefineNarrowMust(query, refineWithinAnchor, facultyAuthorIds, { fuzziness: 'AUTO' }, facultyKerberosIds);
        } else if (searchIn && searchIn.length > 0) {
            bm25Must = this._buildConstrainedSearchInClause(query, searchIn, { fuzziness: 'AUTO' }, facultyAuthorIds, facultyKerberosIds);
        } else {
            bm25Must = this._buildStrictBm25Must(query, searchFields);
        }

        // Build sort clause
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
                bool: {
                    must: [bm25Must],
                    should: boostClauses,
                    filter: filterClauses
                }
            },
            sort: sortClause,
            aggs: this._getAggregations()
        };
    }


    /**
     * Build impact-weighted query using function_score
     * Combines relevance with citation count and recency
     */
    _buildImpactQuery(query, embedding, filters, page, perPage, searchIn = null, facultyAuthorIds = null, authorRefineNarrow = false, refineWithinAnchor = null, facultyKerberosIds = null) {
        const from = (page - 1) * perPage;
        const filterClauses = this._buildFilters(filters);
        const searchFields = this._getSearchFields(searchIn)
            .filter(f => !f.includes('.ngram') && !f.includes('.autocomplete'));
        const currentYear = new Date().getFullYear();
        const searchAllFields = !searchIn || searchIn.length === 0;
        const authorOnly = searchIn?.length === 1 && searchIn[0] === 'author';

        // Detect multi-word query
        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;

        // Build boost-only should clauses
        const boostClauses = [];
        if (searchAllFields || searchIn.includes('subject_area')) {
            boostClauses.push({
                match: {
                    subject_area: { query: query, boost: 2.0 }
                }
            });
        }

        if (isMultiWord && (searchAllFields || searchIn.includes('title') || searchIn.includes('abstract') || (authorRefineNarrow && authorOnly))) {
            boostClauses.push({
                multi_match: {
                    query: query,
                    fields: ['title^5', 'abstract^2'],
                    type: 'phrase',
                    slop: 2,
                    boost: this.searchConfig.phraseBoost
                }
            });
        }

        let bm25Must;
        if (authorRefineNarrow && authorOnly && refineWithinAnchor?.trim()) {
            bm25Must = this._buildAuthorRefineNarrowMust(query, refineWithinAnchor, facultyAuthorIds, { fuzziness: 'AUTO' }, facultyKerberosIds);
        } else if (searchIn && searchIn.length > 0) {
            bm25Must = this._buildConstrainedSearchInClause(query, searchIn, { fuzziness: 'AUTO' }, facultyAuthorIds, facultyKerberosIds);
        } else {
            bm25Must = this._buildStrictBm25Must(query, searchFields);
        }

        return {
            size: perPage,
            from,
            track_total_hits: true,  // Get accurate total count
            min_score: this.searchConfig.minScore.impact,  // Filter low-confidence results
            _source: ['mongo_id'],
            query: {
                function_score: {
                    query: {
                        bool: {
                            must: [bm25Must],
                            should: boostClauses,
                            filter: filterClauses
                        }
                    },
                    functions: [
                        {
                            // Log-scale citation boost (prevents dominance by highly-cited papers)
                            field_value_factor: {
                                field: 'citation_count',
                                factor: this.searchConfig.citationFactor,
                                modifier: 'log1p',
                                missing: 0
                            },
                            weight: 1.2
                        },
                        {
                            // Recency boost: papers within scale years get boost
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
            aggs: this._getAggregations()
        };
    }

    /**
     * Build normalized hybrid query using script_score
     * Normalizes BM25 and k-NN scores for fair combination
     */
    _buildNormalizedHybridQuery(query, embedding, filters, page, perPage, searchIn = null, facultyAuthorIds = null, authorRefineNarrow = false, refineWithinAnchor = null, facultyKerberosIds = null) {
        const from = (page - 1) * perPage;
        const filterClauses = this._buildFilters(filters);
        const searchFields = this._getSearchFields(searchIn)
            .filter(f => !f.includes('.ngram') && !f.includes('.autocomplete'));
        const weights = this.searchConfig.hybridWeights;
        const searchAllFields = !searchIn || searchIn.length === 0;
        const authorOnly = searchIn?.length === 1 && searchIn[0] === 'author';

        // Detect multi-word query
        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;

        let bm25Must;
        if (authorRefineNarrow && authorOnly && refineWithinAnchor?.trim()) {
            bm25Must = this._buildAuthorRefineNarrowMust(query, refineWithinAnchor, facultyAuthorIds, { fuzziness: 'AUTO' }, facultyKerberosIds);
        } else if (searchIn && searchIn.length > 0) {
            bm25Must = this._buildConstrainedSearchInClause(query, searchIn, { fuzziness: 'AUTO' }, facultyAuthorIds, facultyKerberosIds);
        } else {
            bm25Must = this._buildStrictBm25Must(query, searchFields);
        }

        // Boost-only clauses
        const boostClauses = [];
        if (searchAllFields || searchIn.includes('subject_area')) {
            boostClauses.push({
                match: {
                    subject_area: { query: query, boost: 2.0 }
                }
            });
        }

        if (isMultiWord && (searchAllFields || searchIn.includes('title') || searchIn.includes('abstract') || (authorRefineNarrow && authorOnly))) {
            boostClauses.push({
                multi_match: {
                    query: query,
                    fields: ['title^5', 'abstract^2'],
                    type: 'phrase',
                    slop: 2,
                    boost: this.searchConfig.phraseBoost
                }
            });
        }

        return {
            size: perPage,
            from,
            track_total_hits: true,  // Get accurate total count
            min_score: this.searchConfig.minScore.normalized,  // Filter low-confidence results (0-1 scale)
            _source: ['mongo_id'],
            query: {
                script_score: {
                    query: {
                        bool: {
                            must: [bm25Must],
                            should: boostClauses,
                            filter: filterClauses
                        }
                    },
                    script: {
                        source: `
                            // Normalize BM25 score (typically 0-20) to 0-1 range
                            double bm25 = _score / (1.0 + _score);
                            
                            // k-NN cosine similarity (returns -1 to 1, normalize to 0-1)
                            double knn = (cosineSimilarity(params.queryVector, 'embedding') + 1.0) / 2.0;
                            
                            // Weighted combination
                            return params.bm25Weight * bm25 + params.vectorWeight * knn;
                        `,
                        params: {
                            queryVector: embedding,
                            bm25Weight: weights.bm25,
                            vectorWeight: weights.vector
                        }
                    }
                }
            },
            aggs: this._getAggregations()
        };
    }

    /**
     * Parse aggregations into facets
     */
    _parseFacets(aggregations) {
        return {
            years: aggregations?.years?.buckets?.map(b => ({
                value: b.key,
                count: b.doc_count
            })) || [],
            year_ranges: aggregations?.year_ranges?.buckets?.map(b => ({
                value: b.key,
                count: b.doc_count
            })) || [],
            document_types: aggregations?.document_types?.buckets?.map(b => ({
                value: b.key,
                count: b.doc_count
            })) || [],
            fields: aggregations?.fields?.buckets?.map(b => ({
                value: b.key,
                count: b.doc_count
            })) || [],
            subject_areas: aggregations?.subject_areas?.buckets?.map(b => ({
                value: b.key,
                count: b.doc_count
            })) || []
        };
    }

    /**
     * Hydrate search results from MongoDB
     */
    async _hydrateFromMongoDB(osHits) {
        if (!osHits.length) return [];

        const mongoIds = osHits.map(hit => hit._source.mongo_id);

        const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');

        const docs = await ResearchDocument.find({
            _id: { $in: mongoIds }
        })
            .select('-__v')
            .lean();

        const docMap = new Map(docs.map(d => [d._id.toString(), d]));

        // Preserve OpenSearch ranking order
        const ordered = mongoIds
            .map(id => docMap.get(id))
            .filter(Boolean);
        await this._filterAuthorsToFacultyRoster(ordered);
        return ordered;
    }

    /**
     * Keep only paper authors whose Scopus author_id appears on a Faculty record (IIT Delhi roster).
     * Also uses paper.kerberos to guarantee the primary faculty author is always retained.
     * Mutates each document in place.
     */
    async _filterAuthorsToFacultyRoster(results) {
        if (!results?.length) return;

        const scopusIds = new Set();
        const kerberosValues = new Set();
        for (const doc of results) {
            for (const a of doc.authors || []) {
                if (a?.author_id != null && String(a.author_id).trim() !== '') {
                    scopusIds.add(String(a.author_id).trim());
                }
            }
            if (doc.kerberos && String(doc.kerberos).trim()) {
                kerberosValues.add(String(doc.kerberos).trim());
            }
        }
        if (scopusIds.size === 0 && kerberosValues.size === 0) return;

        const Faculty = this.mongoose.model('Faculty');
        const [scopusFacultyDocs, kerberosFacultyDocs] = await Promise.all([
            scopusIds.size > 0
                ? Faculty.find({ scopus_id: { $in: [...scopusIds] } }, { scopus_id: 1 }).lean()
                : [],
            kerberosValues.size > 0
                ? Faculty.find(
                    { email: { $in: [...kerberosValues].map(k => new RegExp(`^${k}@`, 'i')) } },
                    { scopus_id: 1, email: 1, title: 1, firstName: 1, lastName: 1 }
                ).lean()
                : []
        ]);

        const allowed = new Set();
        for (const f of scopusFacultyDocs) {
            for (const sid of f.scopus_id || []) {
                if (sid != null && String(sid).trim()) allowed.add(String(sid).trim());
            }
        }
        for (const f of kerberosFacultyDocs) {
            for (const sid of f.scopus_id || []) {
                if (sid != null && String(sid).trim()) allowed.add(String(sid).trim());
            }
        }

        const kerberosFacultyMap = new Map();
        for (const f of kerberosFacultyDocs) {
            const k = (f.email || '').split('@')[0].toLowerCase();
            if (k) kerberosFacultyMap.set(k, f);
        }

        for (const doc of results) {
            if (doc.authors?.length) {
                doc.authors = doc.authors.filter(
                    (a) => a.author_id != null && allowed.has(String(a.author_id).trim())
                );
            }
            if ((!doc.authors || doc.authors.length === 0) && doc.kerberos) {
                const faculty = kerberosFacultyMap.get(String(doc.kerberos).trim().toLowerCase());
                if (faculty) {
                    const name = [faculty.title, faculty.firstName, faculty.lastName]
                        .filter(p => p && String(p).trim())
                        .join(' ').replace(/\s+/g, ' ').trim();
                    if (name) {
                        doc.authors = [{
                            author_name: name,
                            author_id: (faculty.scopus_id || [])[0] || ''
                        }];
                    }
                }
            }
        }
    }

    /**
     * For basic search responses: replace paper author_name (Scopus string) with the canonical
     * directory name from Faculty when authors.author_id matches Faculty.scopus_id.
     * Also resolves names via paper.kerberos for authors injected by _filterAuthorsToFacultyRoster.
     */
    async _applyFacultyDisplayNamesForBasicSearch(results) {
        if (!results?.length) return;

        const scopusIds = new Set();
        const kerberosValues = new Set();
        for (const doc of results) {
            for (const a of doc.authors || []) {
                if (a?.author_id != null && String(a.author_id).trim() !== '') {
                    scopusIds.add(String(a.author_id).trim());
                }
            }
            if (doc.kerberos && String(doc.kerberos).trim()) {
                kerberosValues.add(String(doc.kerberos).trim());
            }
        }
        if (scopusIds.size === 0 && kerberosValues.size === 0) return;

        const Faculty = this.mongoose.model('Faculty');
        const [scopusFacultyDocs, kerberosFacultyDocs] = await Promise.all([
            scopusIds.size > 0
                ? Faculty.find({ scopus_id: { $in: [...scopusIds] } })
                    .select('title firstName lastName scopus_id')
                    .lean()
                : [],
            kerberosValues.size > 0
                ? Faculty.find({ email: { $in: [...kerberosValues].map(k => new RegExp(`^${k}@`, 'i')) } })
                    .select('title firstName lastName scopus_id email')
                    .lean()
                : []
        ]);

        const idToDisplayName = new Map();
        for (const f of [...scopusFacultyDocs, ...kerberosFacultyDocs]) {
            const parts = [f.title, f.firstName, f.lastName].filter((p) => p && String(p).trim());
            const name = parts.join(' ').replace(/\s+/g, ' ').trim();
            if (!name) continue;
            for (const sid of f.scopus_id || []) {
                if (sid != null && String(sid).trim()) {
                    idToDisplayName.set(String(sid).trim(), name);
                }
            }
        }

        const kerberosToName = new Map();
        for (const f of kerberosFacultyDocs) {
            const k = (f.email || '').split('@')[0].toLowerCase();
            const parts = [f.title, f.firstName, f.lastName].filter(p => p && String(p).trim());
            const name = parts.join(' ').replace(/\s+/g, ' ').trim();
            if (k && name) kerberosToName.set(k, name);
        }

        for (const doc of results) {
            if (!doc.authors?.length) continue;
            for (const a of doc.authors) {
                if (a.author_id == null) continue;
                const key = String(a.author_id).trim();
                const display = idToDisplayName.get(key);
                if (display) {
                    a.author_name = display;
                }
            }
            if (doc.kerberos) {
                const kName = kerberosToName.get(String(doc.kerberos).trim().toLowerCase());
                if (kName) {
                    for (const a of doc.authors) {
                        if (!a.author_name || !a.author_name.trim()) {
                            a.author_name = kName;
                        }
                    }
                }
            }
        }
    }

    /**
     * Extract related faculty from search results (Mongo-hydrated docs).
     * Dual strategy: scopus_id matching for co-authors + kerberos for primary faculty.
     */
    async _extractRelatedFaculty(results) {
        if (!results.length) return [];

        const Faculty = this.mongoose.model('Faculty');

        // Build per-faculty paper sets using BOTH scopus_id and kerberos to count unique papers.
        // A faculty member can appear on a paper via scopus author_id, kerberos, or both —
        // we need the union of those papers, not separate counts.

        const scopusIds = new Set();
        const kerberosValues = new Set();
        for (const doc of results) {
            for (const a of doc.authors || []) {
                if (a?.author_id != null && String(a.author_id).trim()) {
                    scopusIds.add(String(a.author_id).trim());
                }
            }
            const k = (doc.kerberos || '').trim().toLowerCase();
            if (k) kerberosValues.add(k);
        }

        const authorIds = [...scopusIds];
        const kerberosArr = [...kerberosValues];

        this.logger.info({
            uniqueAuthorIds: authorIds.length,
            uniqueKerberos: kerberosArr.length
        }, 'Related faculty: IDs collected from results');

        if (authorIds.length === 0 && kerberosArr.length === 0) return [];

        // Parallel batch lookups: scopus_id + kerberos (email prefix)
        const [scopusFacultyDocs, kerberosFacultyDocs] = await Promise.all([
            authorIds.length > 0
                ? Faculty.find({ scopus_id: { $in: authorIds } })
                    .populate('department', 'name')
                    .select('firstName lastName email expert_id department scopus_id')
                    .limit(50)
                    .lean()
                : [],
            kerberosArr.length > 0
                ? Faculty.find({ email: { $in: kerberosArr.map(k => new RegExp(`^${k}@`, 'i')) } })
                    .populate('department', 'name')
                    .select('firstName lastName email expert_id department scopus_id')
                    .lean()
                : []
        ]);

        this.logger.info({
            scopusMatched: scopusFacultyDocs.length,
            kerberosMatched: kerberosFacultyDocs.length
        }, 'Related faculty: lookup results');

        // Build lookup maps: expert_id → Faculty doc, scopus_id → expert_id, kerberos → expert_id
        const facultyByExpertId = new Map();
        const scopusToExpertId = new Map();
        const kerberosToExpertId = new Map();

        for (const f of scopusFacultyDocs) {
            facultyByExpertId.set(f.expert_id, f);
            for (const sid of f.scopus_id || []) {
                scopusToExpertId.set(String(sid).trim(), f.expert_id);
            }
        }
        for (const f of kerberosFacultyDocs) {
            facultyByExpertId.set(f.expert_id, f);
            const k = (f.email || '').split('@')[0].toLowerCase();
            if (k) kerberosToExpertId.set(k, f.expert_id);
            for (const sid of f.scopus_id || []) {
                scopusToExpertId.set(String(sid).trim(), f.expert_id);
            }
        }

        // Count unique papers per faculty (union of scopus_id + kerberos matches)
        const facultyPaperSets = new Map();
        for (let i = 0; i < results.length; i++) {
            const doc = results[i];
            const docKey = doc._id?.toString() || String(i);
            const matched = new Set();

            // Match via author scopus_ids
            for (const a of doc.authors || []) {
                const aid = a?.author_id != null ? String(a.author_id).trim() : '';
                if (!aid) continue;
                const eid = scopusToExpertId.get(aid);
                if (eid) matched.add(eid);
            }

            // Match via kerberos
            const k = (doc.kerberos || '').trim().toLowerCase();
            if (k) {
                const eid = kerberosToExpertId.get(k);
                if (eid) matched.add(eid);
            }

            for (const eid of matched) {
                if (!facultyPaperSets.has(eid)) facultyPaperSets.set(eid, new Set());
                facultyPaperSets.get(eid).add(docKey);
            }
        }

        // Build final faculty list
        const facultyList = [];
        for (const [expertId, paperSet] of facultyPaperSets) {
            const f = facultyByExpertId.get(expertId);
            if (!f) continue;
            facultyList.push({
                _id: f._id,
                name: `${f.firstName} ${f.lastName}`.trim(),
                email: f.email,
                expert_id: f.expert_id,
                department: f.department,
                paperCount: paperSet.size
            });
        }

        return facultyList.sort((a, b) => b.paperCount - a.paperCount);
    }

    /**
     * Execute search with caching.
     *
     * Basic: strict BM25 only (no fuzziness, no embeddings, no fuzzy fallback). refine_within uses the same strict rules.
     *   Results are hydrated from MongoDB; author display names can be resolved from Faculty (see _applyFacultyDisplayNamesForBasicSearch).
     * Advanced: BM25 with fuzziness AUTO (+ optional search_in constraints with fuzz), hybrid kNN, BM25 pre-check with fuzz,
     *   and a fuzzy fallback (fuzziness 2) if needed. refine_within clauses use the same fuzzy settings.
     *
     * Author-scoped search mirrors this: basic = BM25-only on filtered IDs; advanced = fuzzy BM25 + kNN (see authorScopedSearch).
     */
    async search({ query, filters, sort = 'relevance', page = 1, per_page = 20, search_in = null, mode = 'advanced', refine_within = null }) {
        const searchInNorm = this._normalizeSearchIn(search_in);

        // Pre-resolve kerberos for author_id filter so _buildFilters can create a union clause
        if (filters?.author_id && !filters._authorKerberos) {
            try {
                const Faculty = this.mongoose.model('Faculty');
                let f = await Faculty.findOne({ scopus_id: filters.author_id }).select('email').lean();
                if (!f) f = await Faculty.findOne({ expert_id: filters.author_id }).select('email').lean();
                if (f?.email) {
                    const k = f.email.split('@')[0].trim().toLowerCase();
                    if (k) filters._authorKerberos = k;
                }
            } catch (err) {
                this.logger.warn({ err: err?.message }, 'Failed to resolve kerberos for author_id filter');
            }
        }

        const cachePayload = JSON.stringify({
            query,
            filters,
            sort,
            page,
            per_page,
            search_in: searchInNorm,
            mode,
            refine_within: refine_within || null
        });
        const cacheKey = `search:${crypto.createHash('sha256').update(cachePayload).digest('hex').slice(0, 16)}`;

        this.logger.info({ cacheKey, query, filters, sort, search_in: searchInNorm, mode, refine_within }, 'Search request');

        const bypassCache = false;

        try {
            if (!bypassCache) {
                const cached = await this.redis.get(cacheKey);
                if (cached) {
                    this.logger.info({ cacheKey, query }, 'Search cache HIT');
                    return { ...JSON.parse(cached), cacheHit: true };
                }
            }
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed');
        }

        let facultyAuthorIds = null;
        let facultyKerberosIds = null;
        let refineFacultyIds = null;
        let refineKerberosIds = null;
        let authorRefineNarrow = false;
        if (searchInNorm?.length === 1 && searchInNorm[0] === 'author') {
            if (refine_within?.trim()) {
                const resolved = await this._resolveFacultyScopusIdsForAuthorQuery(refine_within.trim());
                facultyAuthorIds = resolved.scopusIds;
                facultyKerberosIds = resolved.kerberosIds;
                authorRefineNarrow = true;
            } else {
                const resolved = await this._resolveFacultyScopusIdsForAuthorQuery(query);
                facultyAuthorIds = resolved.scopusIds;
                facultyKerberosIds = resolved.kerberosIds;
            }
            this.logger.info(
                { anchorIds: facultyAuthorIds?.length, kerberosIds: facultyKerberosIds?.length, authorRefineNarrow },
                'Author-only: Faculty → Scopus author ids + kerberos'
            );
        }

        // ── BASIC MODE: Pure BM25, no embeddings ──
        if (mode === 'basic') {
            this.logger.info({ query, mode }, 'Running BASIC (BM25-only) search');

            const osQuery = this._buildBasicQuery(query, filters, page, per_page, sort, searchInNorm, refine_within, facultyAuthorIds, refineFacultyIds, authorRefineNarrow, facultyKerberosIds, refineKerberosIds);
            // No min_score for basic: operator:'and' ensures all terms must match, no need for score threshold

            this.logger.info({ mode: 'basic', refine_within: !!refine_within }, 'Basic query built');

            let osResponse = await this.opensearch.search({
                index: this.indexName,
                body: osQuery
            });

            let hits = osResponse.body.hits.hits;
            let total = osResponse.body.hits.total.value;

            // Basic mode: strict BM25 only — no fuzzy fallback (fuzziness belongs in advanced mode only)
            if (total === 0) {
                this.logger.info({ query, refine_within: !!refine_within }, 'Basic search: no hits (strict match, no fuzzy fallback)');
                let suggestions = [];
                if (query.trim()) {
                    suggestions = await this._getSuggestions(query);
                }
                return {
                    results: [],
                    related_faculty: [],
                    suggestions,
                    facets: {},
                    pagination: { page, per_page, total: 0, total_pages: 0 },
                    mode: 'basic',
                    cacheHit: false
                };
            }
            const results = await this._hydrateFromMongoDB(hits);
            await this._applyFacultyDisplayNamesForBasicSearch(results);
            const related_faculty = await this._extractRelatedFaculty(results);

            let suggestions = [];
            if (total < 3) {
                suggestions = await this._getSuggestions(query);
            }

            const response = {
                results,
                related_faculty,
                suggestions,
                facets: this._parseFacets(osResponse.body.aggregations),
                pagination: { page, per_page, total, total_pages: Math.ceil(total / per_page) },
                mode: 'basic'
            };

            // Cache
            try {
                await this.redis.setex(cacheKey, this.redisTTL.searchResults, JSON.stringify(response));
            } catch (err) {
                this.logger.warn({ err }, 'Redis cache write failed');
            }

            return { ...response, cacheHit: false };
        }

        // ── ADVANCED MODE: Hybrid BM25 + k-NN ──
        this.logger.info({ query, mode }, 'Running ADVANCED (hybrid) search');

        // Generate query embedding
        const embedding = await this.embeddingService.embedQuery(query);

        // Pre-check: Run BM25 query WITH fuzziness to catch near-matches (typos)
        const bm25Matches = await this._bm25PreCheck(query, searchInNorm, facultyAuthorIds, authorRefineNarrow, refine_within, facultyKerberosIds);

        // If no BM25 matches even with fuzziness, try fuzzy fallback
        if (bm25Matches === 0) {
            this.logger.info({ query }, 'No BM25 matches even with fuzziness, attempting fuzzy fallback');
            return await this._fuzzyFallbackSearch(query, embedding, filters, sort, page, per_page, searchInNorm, facultyAuthorIds, authorRefineNarrow, refine_within, facultyKerberosIds);
        }

        // Build query based on sort option
        let osQuery;
        if (sort === 'impact') {
            osQuery = this._buildImpactQuery(query, embedding, filters, page, per_page, searchInNorm, facultyAuthorIds, authorRefineNarrow, refine_within, facultyKerberosIds);
        } else if (sort === 'normalized') {
            osQuery = this._buildNormalizedHybridQuery(query, embedding, filters, page, per_page, searchInNorm, facultyAuthorIds, authorRefineNarrow, refine_within, facultyKerberosIds);
        } else {
            osQuery = this._buildHybridQuery(query, embedding, filters, page, per_page, sort, searchInNorm, facultyAuthorIds, authorRefineNarrow, refine_within, facultyKerberosIds);
        }

        // If refining within a prior query, add the original query as an additional BM25 MUST clause.
        // Uses the same per-term must logic as the primary query (_buildStrictBm25Must) so that
        // the refine constraint is equally strict — all terms required for short queries (≤3 words).
        if (refine_within && !authorRefineNarrow) {
            const searchFields = this._getSearchFields(searchInNorm)
                .filter(f => !f.includes('.ngram') && !f.includes('.autocomplete'));

            const refineClause = searchInNorm && searchInNorm.length > 0
                ? this._buildConstrainedSearchInClause(refine_within, searchInNorm, { fuzziness: 'AUTO' }, refineFacultyIds, refineKerberosIds)
                : this._buildStrictBm25Must(refine_within, searchFields);

            const mustArrays = [
                osQuery.query?.bool?.must,
                osQuery.query?.script_score?.query?.bool?.must,
                osQuery.query?.function_score?.query?.bool?.must
            ].filter(Boolean);

            if (mustArrays.length) {
                mustArrays[0].push(refineClause);
            }
            this.logger.info({ refine_within }, 'Added refine_within constraint to advanced query');
        }

        this.logger.info({ 
            opensearchQuery: JSON.stringify(osQuery.query, null, 2),
            sort: osQuery.sort,
            minScore: osQuery.min_score,
            mode: 'advanced',
            refine_within: !!refine_within
        }, 'OpenSearch query being executed');

        const osResponse = await this.opensearch.search({
            index: this.indexName,
            body: osQuery
        });

        const hits = osResponse.body.hits.hits;
        const total = osResponse.body.hits.total.value;

        // Hydrate from MongoDB
        const results = await this._hydrateFromMongoDB(hits);
        await this._applyFacultyDisplayNamesForBasicSearch(results);

        // Extract related faculty from results
        const related_faculty = await this._extractRelatedFaculty(results);

        // Generate "did you mean?" suggestions for low-result queries
        let suggestions = [];
        if (total < 3) {
            suggestions = await this._getSuggestions(query);
        }

        // Build response
        const response = {
            results,
            related_faculty,
            suggestions,
            facets: this._parseFacets(osResponse.body.aggregations),
            pagination: {
                page,
                per_page,
                total,
                total_pages: Math.ceil(total / per_page)
            },
            mode: 'advanced'
        };

        // If primary search returned 0 results, try fuzzy fallback
        if (total === 0) {
            this.logger.info({ query }, 'Primary search returned 0 results, attempting fuzzy fallback');
            return await this._fuzzyFallbackSearch(query, embedding, filters, sort, page, per_page, searchInNorm, facultyAuthorIds, authorRefineNarrow, refine_within, facultyKerberosIds);
        }

        // Cache results
        try {
            await this.redis.setex(
                cacheKey,
                this.redisTTL.searchResults,
                JSON.stringify(response)
            );
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache write failed');
        }

        this.logger.info({ 
            facultyCount: related_faculty.length,
            sampleFaculty: related_faculty.slice(0, 2)
        }, 'Returning search response with faculty');

        return { ...response, cacheHit: false };
    }

    /**
     * BM25 pre-check: count how many documents match with fuzziness
     * Used to decide whether to attempt a fuzzy fallback
     */
    async _bm25PreCheck(query, search_in = null, facultyAuthorIds = null, authorRefineNarrow = false, refine_within = null, facultyKerberosIds = null) {
        const authorOnly = search_in?.length === 1 && search_in[0] === 'author';
        const useAuthorRefine = authorRefineNarrow && authorOnly && refine_within?.trim();

        const bm25CheckQuery = useAuthorRefine
            ? {
                size: 0,
                query: this._buildAuthorRefineNarrowMust(query, refine_within, facultyAuthorIds, { fuzziness: 'AUTO' }, facultyKerberosIds)
            }
            : search_in && search_in.length > 0
            ? {
                size: 0,
                query: this._buildConstrainedSearchInClause(query, search_in, { fuzziness: 'AUTO' }, facultyAuthorIds, facultyKerberosIds)
            }
            : {
                size: 0,
                query: {
                    multi_match: {
                        query: query,
                        fields: ['title', 'abstract', 'author_names', 'subject_area', 'field_associated'],
                        fuzziness: 'AUTO'
                    }
                }
            };

        const response = await this.opensearch.search({
            index: this.indexName,
            body: bm25CheckQuery
        });

        return response.body.hits.total.value;
    }

    /**
     * Fuzzy fallback search — used when primary search/pre-check returns 0 results
     * Runs with higher fuzziness tolerance and no min_score to catch typos
     */
    async _fuzzyFallbackSearch(query, embedding, filters, sort, page, per_page, search_in, facultyAuthorIds = null, authorRefineNarrow = false, refine_within = null, facultyKerberosIds = null) {
        // When refining (search-on-search), the user is narrowing results.
        // If the refinement query has no BM25 matches, return 0 — don't broaden via fuzzy.
        if (refine_within && !authorRefineNarrow) {
            this.logger.info({ query, refine_within }, 'Skipping fuzzy fallback: refine_within is active — narrowing should not expand results');
            const suggestions = await this._getSuggestions(query);
            return {
                results: [],
                related_faculty: [],
                suggestions,
                fuzzy_fallback: false,
                facets: {},
                pagination: { page, per_page, total: 0, total_pages: 0 },
                mode: 'advanced',
                message: 'No results found matching your refinement. Try different keywords.',
                cacheHit: false
            };
        }

        const from = (page - 1) * per_page;
        const searchFields = this._getSearchFields(search_in)
            .filter(f => !f.includes('.ngram') && !f.includes('.autocomplete'));
        const filterClauses = this._buildFilters(filters);

        const authorOnly = search_in?.length === 1 && search_in[0] === 'author';
        const useAuthorRefine = authorRefineNarrow && authorOnly && refine_within?.trim();

        const fuzzyMust = useAuthorRefine
            ? this._buildAuthorRefineNarrowMust(query, refine_within, facultyAuthorIds, { fuzziness: 2 }, facultyKerberosIds)
            : search_in && search_in.length > 0
            ? this._buildConstrainedSearchInClause(query, search_in, { fuzziness: 2 }, facultyAuthorIds, facultyKerberosIds)
            : this._buildStrictBm25Must(query, searchFields, { fuzziness: 2 });

        const fallbackQuery = {
            size: per_page,
            from,
            track_total_hits: true,
            _source: ['mongo_id'],
            query: {
                bool: {
                    must: [fuzzyMust],
                    should: [
                        {
                            knn: {
                                embedding: {
                                    vector: embedding,
                                    k: 50
                                }
                            }
                        }
                    ],
                    filter: filterClauses
                }
            },
            aggs: this._getAggregations()
        };

        try {
            const osResponse = await this.opensearch.search({
                index: this.indexName,
                body: fallbackQuery
            });

            const hits = osResponse.body.hits.hits;
            const total = osResponse.body.hits.total.value;
            const results = await this._hydrateFromMongoDB(hits);
            await this._applyFacultyDisplayNamesForBasicSearch(results);
            const related_faculty = await this._extractRelatedFaculty(results);
            const suggestions = await this._getSuggestions(query);

            return {
                results,
                related_faculty,
                suggestions,
                fuzzy_fallback: true,
                facets: this._parseFacets(osResponse.body.aggregations),
                pagination: {
                    page,
                    per_page,
                    total,
                    total_pages: Math.ceil(total / per_page)
                },
                mode: 'advanced',
                message: total > 0
                    ? 'Showing approximate matches for your query'
                    : 'No results found. Try different keywords.',
                cacheHit: false
            };
        } catch (err) {
            this.logger.error({ err, query }, 'Fuzzy fallback search failed');
            return {
                results: [],
                related_faculty: [],
                facets: {},
                suggestions: [],
                fuzzy_fallback: true,
                pagination: { page, per_page, total: 0, total_pages: 0 },
                mode: 'advanced',
                message: 'No relevant results found for your query',
                cacheHit: false
            };
        }
    }

    /**
     * Get "Did you mean?" suggestions using OpenSearch term suggest
     */
    async _getSuggestions(query) {
        try {
            const suggestQuery = {
                size: 0,
                suggest: {
                    title_suggest: {
                        text: query,
                        term: {
                            field: 'title',
                            suggest_mode: 'popular',
                            sort: 'frequency',
                            size: 3,
                            max_edits: 2,
                            prefix_length: 1,
                            min_word_length: 3
                        }
                    },
                    author_suggest: {
                        text: query,
                        term: {
                            field: 'author_names',
                            suggest_mode: 'popular',
                            sort: 'frequency',
                            size: 3,
                            max_edits: 2,
                            prefix_length: 1,
                            min_word_length: 3
                        }
                    }
                }
            };

            const suggestResponse = await this.opensearch.search({
                index: this.indexName,
                body: suggestQuery
            });

            const suggestions = new Set();
            const suggestData = suggestResponse.body.suggest;

            // Collect title suggestions
            if (suggestData?.title_suggest) {
                for (const entry of suggestData.title_suggest) {
                    for (const option of entry.options) {
                        suggestions.add(option.text);
                    }
                }
            }

            // Collect author suggestions
            if (suggestData?.author_suggest) {
                for (const entry of suggestData.author_suggest) {
                    for (const option of entry.options) {
                        suggestions.add(option.text);
                    }
                }
            }

            // Build corrected query from best suggestions
            if (suggestions.size > 0) {
                const words = query.trim().split(/\s+/);
                const correctedWords = words.map(word => {
                    const titleSuggest = suggestData?.title_suggest?.find(s => s.text === word);
                    if (titleSuggest?.options?.length > 0) {
                        return titleSuggest.options[0].text;
                    }
                    return word;
                });
                const correctedQuery = correctedWords.join(' ');
                if (correctedQuery !== query) {
                    return [correctedQuery, ...Array.from(suggestions).slice(0, 4)];
                }
            }

            return Array.from(suggestions).slice(0, 5);
        } catch (err) {
            this.logger.warn({ err }, 'Suggestion query failed');
            return [];
        }
    }

    /**
     * Find semantically similar papers using k-NN on existing embeddings
     */
    async findSimilar(documentId, limit = 10) {
        // Get the source document's embedding from OpenSearch
        const sourceQuery = await this.opensearch.search({
            index: this.indexName,
            body: {
                query: { term: { mongo_id: documentId } },
                _source: ['embedding', 'title', 'subject_area']
            }
        });

        if (!sourceQuery.body.hits.hits.length) {
            throw new Error('Document not found in search index');
        }

        const source = sourceQuery.body.hits.hits[0]._source;
        const embedding = source.embedding;

        // k-NN search excluding the source document
        const similarQuery = await this.opensearch.search({
            index: this.indexName,
            body: {
                size: limit,
                _source: ['mongo_id'],
                query: {
                    bool: {
                        must: [{
                            knn: {
                                embedding: { vector: embedding, k: limit + 5 }
                            }
                        }],
                        must_not: [{ term: { mongo_id: documentId } }]
                    }
                }
            }
        });

        // Hydrate from MongoDB
        const results = await this._hydrateFromMongoDB(similarQuery.body.hits.hits);

        // Include similarity scores
        const scoreMap = new Map(
            similarQuery.body.hits.hits.map(h => [h._source.mongo_id, h._score])
        );

        return {
            source: { id: documentId, title: source.title, subject_areas: source.subject_area },
            similar: results.map(r => ({
                ...r,
                similarity_score: scoreMap.get(r._id.toString())
            }))
        };
    }

    /**
     * Author-scoped search: rank an author's papers for a query (e.g. Explore sidebar click).
     *
     * Phase 1: Resolve author via MongoDB Faculty (expert_id / scopus_id) or raw id; collect open_search_id for their papers.
     * Phase 2: OpenSearch on that ID filter — basic: strict BM25 only (no embeddings, no fuzziness); refine_within adds a second strict multi_match.
     *   Advanced: fuzzy BM25 + kNN; refine_within uses the same fuzzy multi_match rules.
     * Phase 3: Hydrate from MongoDB by hit order; basic applies Faculty display names on authors.
     *
     * @param {Object} params
     * @param {string} params.query - The search query text
     * @param {string} params.author_id - Scopus author ID
     * @param {number} [params.page=1]
     * @param {number} [params.per_page=20]
     * @param {string[]} [params.search_in] - Same as main search; e.g. ['author'] = match query only in author names (basic strict, advanced fuzzy).
     */
    async authorScopedSearch({ query, author_id, page = 1, per_page = 20, mode = 'advanced', refine_within = null, search_in = null }) {
        const searchInNorm = this._normalizeSearchIn(search_in);
        // Cache key
        const queryHash = crypto.createHash('sha256')
            .update(JSON.stringify({ query, author_id, page, per_page, mode, refine_within, search_in: searchInNorm }))
            .digest('hex').slice(0, 16);
        const cacheKey = `author_scope:${queryHash}`;

        // Check cache
        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                this.logger.info({ cacheKey, author_id, query, mode }, 'Author-scoped search cache HIT');
                return { ...JSON.parse(cached), cacheHit: true };
            }
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed for author-scoped search');
        }

        // Phase 1: Resolve author identity and build OpenSearch-native author filter.
        // Uses the SAME filter methodology as getAllFacultyForQuery aggregations,
        // ensuring consistent paper counts between People section and author-scoped search.
        let authorName, totalAuthorPapers, authorFilter;
        try {
            const Faculty = this.mongoose.model('Faculty');

            const facultyMatch = await Faculty.findOne({
                $or: [{ expert_id: author_id }, { scopus_id: author_id }]
            }).lean();

            const scopusAuthorIds = facultyMatch?.scopus_id?.length
                ? facultyMatch.scopus_id.map(String)
                : [author_id];

            const kerberosId = facultyMatch?.email
                ? facultyMatch.email.split('@')[0].toLowerCase()
                : null;

            // OpenSearch-native author filter (same data source as aggregations)
            const authorShouldClauses = [
                { nested: { path: 'authors', query: { terms: { 'authors.author_id': scopusAuthorIds } } } }
            ];
            if (kerberosId) {
                authorShouldClauses.push({ term: { kerberos: kerberosId } });
            }
            authorFilter = { bool: { should: authorShouldClauses, minimum_should_match: 1 } };

            // Total papers for this author from OpenSearch
            const countResult = await this.opensearch.search({
                index: this.indexName,
                body: { size: 0, query: authorFilter, track_total_hits: true }
            });
            totalAuthorPapers = countResult.body.hits.total.value;

            this.logger.info({
                author_id,
                totalPapers: totalAuthorPapers,
                scopusIds: scopusAuthorIds.length,
                hasKerberos: !!kerberosId
            }, 'Author-scoped search: Phase 1 - resolved author identity');

            if (totalAuthorPapers === 0) {
                return {
                    results: [],
                    author: { author_id, name: 'Unknown', total_papers: 0 },
                    pagination: { page, per_page, total: 0, total_pages: 0 },
                    cacheHit: false
                };
            }

            if (facultyMatch) {
                authorName = `${facultyMatch.firstName} ${facultyMatch.lastName}`.trim();
            } else {
                const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');
                const authorNameDoc = await ResearchDocument.findOne(
                    { 'authors.author_id': author_id },
                    { 'authors.$': 1 }
                ).lean();
                authorName = authorNameDoc?.authors?.[0]?.author_name || 'Unknown';
            }
        } catch (err) {
            this.logger.error({ err, author_id }, 'Author-scoped search: Phase 1 FAILED');
            throw err;
        }

        let facultyAuthorIds = null;
        let facultyKerberosIds = null;
        let refineFacultyIds = null;
        let refineKerberosIds = null;
        let authorRefineNarrow = false;
        if (searchInNorm?.length === 1 && searchInNorm[0] === 'author') {
            if (refine_within?.trim()) {
                const resolved = await this._resolveFacultyScopusIdsForAuthorQuery(refine_within.trim());
                facultyAuthorIds = resolved.scopusIds;
                facultyKerberosIds = resolved.kerberosIds;
                authorRefineNarrow = true;
            } else {
                const resolved = await this._resolveFacultyScopusIdsForAuthorQuery(query);
                facultyAuthorIds = resolved.scopusIds;
                facultyKerberosIds = resolved.kerberosIds;
            }
        }

        // When search_in is author-only AND we couldn't resolve Faculty Scopus IDs for the query,
        // text-matching the query against author name fields inside the clicked author's corpus
        // often yields 0 hits (name tokens ≠ indexed strings).  Fall back to match_all only then.
        // When Scopus IDs ARE resolved, use them as an exact terms filter so clicking a coworker
        // correctly narrows to co-authored papers instead of showing the entire corpus.
        const skipAuthorMustForScoped =
            searchInNorm?.length === 1 && searchInNorm[0] === 'author' && !authorRefineNarrow
            && (!facultyAuthorIds || facultyAuthorIds.length === 0)
            && (!facultyKerberosIds || facultyKerberosIds.length === 0);

        // Phase 2: Build query using the SAME builders as main search + author filter.
        // This ensures the paper count is consistent with getAllFacultyForQuery (People section).
        let hits, total;
        try {
            const from = (page - 1) * per_page;
            const isBasic = mode === 'basic';
            let osQuery;

            if (isBasic) {
                // Reuse _buildBasicQuery to guarantee identical matching logic
                const base = this._buildBasicQuery(
                    query, {}, page, per_page, 'relevance',
                    searchInNorm, refine_within,
                    facultyAuthorIds, refineFacultyIds, authorRefineNarrow,
                    facultyKerberosIds, refineKerberosIds
                );

                // For author-only search_in where Faculty IDs couldn't be resolved,
                // fall back to match_all (author name tokens don't match indexed strings).
                if (skipAuthorMustForScoped) {
                    base.query.bool.must = [{ match_all: {} }];
                    if (refine_within) {
                        base.query.bool.must.push(
                            this._buildConstrainedSearchInClause(refine_within, searchInNorm, {}, refineFacultyIds, refineKerberosIds)
                        );
                    }
                }

                // Scope to this author's papers via OpenSearch-native filter
                const filterClauses = base.query.bool.filter || [];
                filterClauses.push(authorFilter);
                base.query.bool.filter = filterClauses;
                delete base.aggs;
                osQuery = base;
            } else {
                const embedding = await this.embeddingService.embedQuery(query);
                // Reuse _buildHybridQuery to guarantee identical matching logic
                const base = this._buildHybridQuery(
                    query, embedding, {}, page, per_page, 'relevance',
                    searchInNorm, facultyAuthorIds, authorRefineNarrow,
                    refine_within, facultyKerberosIds
                );

                if (skipAuthorMustForScoped) {
                    const mustArray = base.query?.bool?.must
                        || base.query?.script_score?.query?.bool?.must
                        || base.query?.function_score?.query?.bool?.must;
                    if (mustArray) {
                        mustArray.splice(0, mustArray.length, { match_all: {} });
                        if (refine_within) {
                            mustArray.push(
                                this._buildConstrainedSearchInClause(
                                    refine_within, searchInNorm,
                                    { fuzziness: 'AUTO' },
                                    refineFacultyIds, refineKerberosIds
                                )
                            );
                        }
                    }
                }

                // Handle refine_within for non-author-refine-narrow cases
                if (refine_within && !authorRefineNarrow) {
                    const refineSearchFields = this._getSearchFields(searchInNorm)
                        .filter(f => !f.includes('.ngram') && !f.includes('.autocomplete'));
                    const refineClause =
                        searchInNorm && searchInNorm.length > 0
                            ? this._buildConstrainedSearchInClause(
                                refine_within, searchInNorm,
                                { fuzziness: 'AUTO' },
                                refineFacultyIds, refineKerberosIds
                            )
                            : this._buildStrictBm25Must(refine_within, refineSearchFields);
                    const mustArrays = [
                        base.query?.bool?.must,
                        base.query?.script_score?.query?.bool?.must,
                        base.query?.function_score?.query?.bool?.must
                    ].filter(Boolean);
                    if (mustArrays.length) mustArrays[0].push(refineClause);
                }

                // Scope to this author's papers via OpenSearch-native filter
                const filterTargets = [
                    base.query?.bool?.filter,
                    base.query?.script_score?.query?.bool?.filter,
                    base.query?.function_score?.query?.bool?.filter
                ].filter(Boolean);
                for (const filterArr of filterTargets) {
                    if (Array.isArray(filterArr)) filterArr.push(authorFilter);
                }

                delete base.aggs;
                delete base.min_score;
                osQuery = base;
            }

            this.logger.info({
                author_id,
                query,
                totalAuthorPapers,
                mode: isBasic ? 'basic' : 'advanced',
                refine_within: !!refine_within,
                search_in: searchInNorm
            }, 'Author-scoped search: Phase 2 - querying OpenSearch');

            const osResponse = await this.opensearch.search({
                index: this.indexName,
                body: osQuery
            });

            hits = osResponse.body.hits.hits;
            total = osResponse.body.hits.total.value;

            this.logger.info({
                hitsCount: hits.length,
                total
            }, 'Author-scoped search: Phase 2 - OpenSearch results');
        } catch (err) {
            this.logger.error({ err, author_id, query }, 'Author-scoped search: Phase 2 FAILED (OpenSearch)');
            throw err;
        }

        // Phase 3: Hydrate from MongoDB
        let scoredResults;
        try {
            const results = await this._hydrateFromMongoDB(hits);

            // Attach similarity scores to results
            const scoreMap = new Map(
                hits.map(h => [h._source.mongo_id, h._score])
            );
            scoredResults = results.map(r => ({
                ...r,
                similarity_score: scoreMap.get(r._id.toString())
            }));
            await this._applyFacultyDisplayNamesForBasicSearch(scoredResults);
        } catch (err) {
            this.logger.error({ err, author_id }, 'Author-scoped search: Phase 3 FAILED (Hydration)');
            throw err;
        }

        const response = {
            results: scoredResults,
            author: {
                name: authorName,
                author_id,
                total_papers: totalAuthorPapers
            },
            pagination: {
                page,
                per_page,
                total,
                total_pages: Math.ceil(total / per_page)
            }
        };

        // Cache results
        try {
            await this.redis.setex(
                cacheKey,
                this.redisTTL.searchResults,
                JSON.stringify(response)
            );
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache write failed for author-scoped search');
        }

        this.logger.info({
            author_id,
            authorName,
            query,
            totalPapers: totalAuthorPapers,
            matchedResults: total
        }, 'Author-scoped search complete');

        return { ...response, cacheHit: false };
    }

    /**
     * Get co-authors for a specific author.
     * Uses BOTH scopus author_id (nested) and kerberos (top-level) to find all papers
     * for the given faculty, then aggregates co-authors from those papers.
     */
    async getCoAuthors(authorId) {
        const Faculty = this.mongoose.model('Faculty');
        let faculty = await Faculty.findOne({ scopus_id: authorId })
            .select('email scopus_id')
            .lean();
        if (!faculty) {
            faculty = await Faculty.findOne({ expert_id: authorId })
                .select('email scopus_id')
                .lean();
        }

        const kerberosId = faculty?.email
            ? faculty.email.split('@')[0].trim().toLowerCase()
            : null;
        const allScopusIds = (faculty?.scopus_id || [authorId]).map(String);

        const shouldClauses = [
            { nested: { path: 'authors', query: { terms: { 'authors.author_id': allScopusIds } } } }
        ];
        if (kerberosId) {
            shouldClauses.push({ term: { kerberos: kerberosId } });
        }

        const result = await this.opensearch.search({
            index: this.indexName,
            body: {
                size: 0,
                query: {
                    bool: { should: shouldClauses, minimum_should_match: 1 }
                },
                aggs: {
                    author_papers: {
                        nested: { path: 'authors' },
                        aggs: {
                            coauthors: {
                                terms: {
                                    field: 'authors.author_id',
                                    size: 50,
                                    exclude: allScopusIds
                                },
                                aggs: {
                                    author_info: {
                                        top_hits: {
                                            size: 1,
                                            _source: ['authors.author_name']
                                        }
                                    }
                                }
                            }
                        }
                    },
                    total_papers: { value_count: { field: 'mongo_id' } }
                }
            }
        });

        const coauthors = result.body.aggregations?.author_papers?.coauthors?.buckets || [];

        return {
            author_id: authorId,
            total_papers: result.body.aggregations?.total_papers?.value || 0,
            collaborators: coauthors.map(c => ({
                author_id: c.key,
                collaboration_count: c.doc_count,
                name: c.author_info?.hits?.hits?.[0]?._source?.authors?.author_name
            }))
        };
    }

    /**
     * Get single document by ID
     */
    async getDocument(id) {
        const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');

        let doc = null;

        if (id.match(/^[0-9a-fA-F]{24}$/)) {
            doc = await ResearchDocument.findById(id).lean();
        }

        if (!doc) {
            doc = await ResearchDocument.findOne({ open_search_id: id }).lean();
        }

        if (doc) {
            await this._filterAuthorsToFacultyRoster([doc]);
        }

        return doc;
    }

    /**
     * Merge terms buckets from flat `author_ids` and nested `authors.author_id` (same Scopus id).
     * Both aggregations count the same underlying documents, so we take the MAX of doc_count
     * (not sum) to avoid double-counting papers that appear in both flat and nested fields.
     */
    _mergeFacultyAuthorAggBuckets(flatBuckets, nestedBuckets) {
        const byKey = new Map();
        const accumulate = (buckets) => {
            for (const bucket of buckets) {
                const key = bucket.key == null ? '' : String(bucket.key).trim();
                if (!key) continue;
                const dc = bucket.doc_count || 0;
                const maxRel = bucket.max_relevance?.value || 0;
                const avgRel = bucket.avg_relevance?.value || 0;
                const prev = byKey.get(key);
                if (!prev) {
                    byKey.set(key, {
                        key,
                        doc_count: dc,
                        max_relevance: { value: maxRel },
                        avg_relevance: { value: avgRel }
                    });
                } else {
                    prev.doc_count = Math.max(prev.doc_count, dc);
                    prev.max_relevance = { value: Math.max(prev.max_relevance.value, maxRel) };
                    prev.avg_relevance = { value: Math.max(prev.avg_relevance.value, avgRel) };
                }
            }
        };
        accumulate(flatBuckets);
        accumulate(nestedBuckets);
        return [...byKey.values()].map((b) => ({
            key: b.key,
            doc_count: b.doc_count,
            max_relevance: b.max_relevance,
            avg_relevance: b.avg_relevance
        }));
    }

    /**
     * Aggregations for GET /search/faculty-for-query (Scopus author buckets + score stats).
     */
    _facultyForQueryAggregations() {
        return {
            from_author_ids: {
                filter: { exists: { field: 'author_ids' } },
                aggs: {
                    by_scopus_author: {
                        terms: {
                            field: 'author_ids',
                            size: 200,
                            min_doc_count: 1
                        },
                        aggs: {
                            max_relevance: { max: { script: '_score' } },
                            avg_relevance: { avg: { script: '_score' } }
                        }
                    }
                }
            },
            from_nested_authors: {
                nested: { path: 'authors' },
                aggs: {
                    by_scopus_author: {
                        terms: {
                            field: 'authors.author_id',
                            size: 200,
                            min_doc_count: 1
                        },
                        aggs: {
                            max_relevance: { max: { script: '_score' } },
                            avg_relevance: { avg: { script: '_score' } }
                        }
                    }
                }
            },
            from_kerberos: {
                terms: {
                    field: 'kerberos',
                    size: 200,
                    min_doc_count: 1
                },
                aggs: {
                    max_relevance: { max: { script: '_score' } },
                    avg_relevance: { avg: { script: '_score' } }
                }
            }
        };
    }

    /**
     * Get all IITD faculty for a query across the entire result set.
     * Uses OpenSearch nested aggregation (size: 0, no docs fetched).
     *
     * Query body matches POST /search (including search_in / refine_within) so Explore "Show all"
     * does not disagree with the main result set (e.g. author-only name search vs cross_fields on all text).
     *
     * Returns faculty grouped by department, sorted by relevance.
     */
    async getAllFacultyForQuery(query, mode = 'advanced', search_in = null, refine_within = null) {
        const searchInNorm = this._normalizeSearchIn(search_in);
        // Cache key
        const queryHash = crypto.createHash('sha256')
            .update(JSON.stringify({
                query,
                type: 'faculty_for_query_nested',
                mode,
                search_in: searchInNorm,
                refine_within: refine_within || null
            }))
            .digest('hex').slice(0, 16);
        const cacheKey = `faculty_query:${queryHash}`;

        // Check cache
        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                this.logger.info({ cacheKey, query, mode }, 'Faculty-for-query cache HIT');
                return { ...JSON.parse(cached), cacheHit: true };
            }
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed for faculty-for-query');
        }

        let facultyAuthorIds = null;
        let facultyKerberosIds = null;
        let refineFacultyIds = null;
        let refineKerberosIds = null;
        let authorRefineNarrow = false;
        if (searchInNorm?.length === 1 && searchInNorm[0] === 'author') {
            if (refine_within?.trim()) {
                const resolved = await this._resolveFacultyScopusIdsForAuthorQuery(refine_within.trim());
                facultyAuthorIds = resolved.scopusIds;
                facultyKerberosIds = resolved.kerberosIds;
                authorRefineNarrow = true;
            } else {
                const resolved = await this._resolveFacultyScopusIdsForAuthorQuery(query);
                facultyAuthorIds = resolved.scopusIds;
                facultyKerberosIds = resolved.kerberosIds;
            }
        }

        const facultyAggs = this._facultyForQueryAggregations();
        const emptyFilters = {};

        const patchFacultyAggBody = (base) => {
            const body = { ...base };
            body.size = 0;
            body.from = 0;
            body.track_total_hits = true;
            body._source = false;
            body.aggs = facultyAggs;
            if (mode === 'advanced') {
                body.min_score = this.searchConfig.minScore.impact;
            } else {
                delete body.min_score;
            }
            delete body.sort;
            return body;
        };

        let osQuery;
        if (mode === 'basic') {
            const base = this._buildBasicQuery(
                query,
                emptyFilters,
                1,
                1,
                'relevance',
                searchInNorm,
                refine_within,
                facultyAuthorIds,
                refineFacultyIds,
                authorRefineNarrow,
                facultyKerberosIds,
                refineKerberosIds
            );
            osQuery = patchFacultyAggBody(base);
        } else {
            const embedding = await this.embeddingService.embedQuery(query);
            let base = this._buildHybridQuery(
                query,
                embedding,
                emptyFilters,
                1,
                1,
                'relevance',
                searchInNorm,
                facultyAuthorIds,
                authorRefineNarrow,
                refine_within,
                facultyKerberosIds
            );
            if (refine_within && !authorRefineNarrow) {
                const refineSearchFields = this._getSearchFields(searchInNorm)
                    .filter(f => !f.includes('.ngram') && !f.includes('.autocomplete'));
                const refineClause =
                    searchInNorm && searchInNorm.length > 0
                        ? this._buildConstrainedSearchInClause(
                            refine_within,
                            searchInNorm,
                            { fuzziness: 'AUTO' },
                            refineFacultyIds,
                            refineKerberosIds
                        )
                        : this._buildStrictBm25Must(refine_within, refineSearchFields);
                const mustArrays = [
                    base.query?.bool?.must,
                    base.query?.script_score?.query?.bool?.must,
                    base.query?.function_score?.query?.bool?.must
                ].filter(Boolean);
                if (mustArrays.length) {
                    mustArrays[0].push(refineClause);
                }
            }
            osQuery = patchFacultyAggBody(base);
        }

        this.logger.info({ query, mode, search_in: searchInNorm }, 'Faculty-for-query: querying OpenSearch aggregation');

        const osResponse = await this.opensearch.search({
            index: this.indexName,
            body: osQuery
        });

        const totalDocs = osResponse.body.hits.total.value;
        const flatBuckets = osResponse.body.aggregations
            ?.from_author_ids
            ?.by_scopus_author
            ?.buckets || [];
        const nestedBuckets = osResponse.body.aggregations
            ?.from_nested_authors
            ?.by_scopus_author
            ?.buckets || [];
        const expertBuckets = this._mergeFacultyAuthorAggBuckets(flatBuckets, nestedBuckets);
        const kerberosBuckets = osResponse.body.aggregations
            ?.from_kerberos
            ?.buckets || [];

        this.logger.info({
            query,
            totalDocs,
            uniqueScopusAuthors: expertBuckets.length,
            uniqueKerberos: kerberosBuckets.length
        }, 'Faculty-for-query: aggregation results');

        if (expertBuckets.length === 0 && kerberosBuckets.length === 0) {
            const emptyResult = {
                departments: [],
                total_faculty: 0,
                total_matching_papers: totalDocs,
                cacheHit: false
            };
            return emptyResult;
        }

        // Bucket key = Scopus author_id (matches Faculty.scopus_id elements)
        let authorInfos = expertBuckets.map(bucket => {
            const maxRel = bucket.max_relevance?.value || 0;
            const avgRel = bucket.avg_relevance?.value || 0;
            const paperCount = bucket.doc_count;
            const authorScore = 0.6 * maxRel + 0.3 * avgRel + 0.1 * Math.log2(1 + paperCount);
            return {
                scopus_author_id: bucket.key,
                paper_count: paperCount,
                max_relevance: maxRel,
                avg_relevance: avgRel,
                author_score: authorScore
            };
        });

        // Apply dynamic relevance thresholding logic
        if (authorInfos.length > 0) {
            const maxAuthorScore = Math.max(...authorInfos.map(a => a.author_score));
            const scoreThreshold = maxAuthorScore * 0.25;

            const initialCount = authorInfos.length;
            authorInfos = authorInfos.filter(a => a.author_score >= scoreThreshold);

            this.logger.info({
                maxAuthorScore,
                scoreThreshold,
                keptAuthors: authorInfos.length,
                droppedAuthors: initialCount - authorInfos.length
            }, 'Faculty-for-query: applied dynamic relevance threshold');
        }

        const scopusIds = authorInfos.map(a => a.scopus_author_id);
        const Faculty = this.mongoose.model('Faculty');

        // Batch lookup by scopus_id
        let facultyDocs = [];
        if (scopusIds.length > 0) {
            facultyDocs = await Faculty.find({ scopus_id: { $in: scopusIds } })
                .populate('department', 'name')
                .select('firstName lastName expert_id department scopus_id email')
                .lean();
        }

        // Batch lookup by kerberos (email prefix match) for primary faculty
        const kerberosValues = kerberosBuckets
            .map(b => String(b.key).trim())
            .filter(Boolean);
        let kerberosFacultyDocs = [];
        if (kerberosValues.length > 0) {
            const kerberosRegexes = kerberosValues.map(k => new RegExp(`^${k}@`, 'i'));
            kerberosFacultyDocs = await Faculty.find({ email: { $in: kerberosRegexes } })
                .populate('department', 'name')
                .select('firstName lastName expert_id department scopus_id email')
                .lean();
        }

        const facultyByScopusId = new Map();
        for (const f of facultyDocs) {
            for (const sid of f.scopus_id || []) {
                facultyByScopusId.set(String(sid), f);
            }
        }

        // Map kerberos -> faculty
        const facultyByKerberos = new Map();
        for (const f of kerberosFacultyDocs) {
            const k = (f.email || '').split('@')[0].toLowerCase();
            if (k) facultyByKerberos.set(k, f);
        }

        this.logger.info({
            totalBuckets: scopusIds.length,
            matchedFaculty: facultyDocs.length,
            kerberosFaculty: kerberosFacultyDocs.length
        }, 'Faculty-for-query: scopus_id + kerberos lookup');

        const facultyDedup = new Map();

        // Merge scopus_id-resolved faculty
        for (const author of authorInfos) {
            const faculty = facultyByScopusId.get(String(author.scopus_author_id));
            if (!faculty) continue;

            const facultyName = `${faculty.firstName} ${faculty.lastName}`.trim();
            const key = faculty.expert_id;
            if (facultyDedup.has(key)) {
                const existing = facultyDedup.get(key);
                existing.paper_count += author.paper_count;
                existing.author_score = Math.max(existing.author_score, author.author_score);
            } else {
                facultyDedup.set(key, {
                    name: facultyName,
                    expert_id: faculty.expert_id,
                    paper_count: author.paper_count,
                    author_score: author.author_score,
                    deptName: faculty?.department?.name || 'Other'
                });
            }
        }

        // Merge kerberos-resolved primary faculty (ensures primary faculty always appear).
        // Build a set of scopus_ids that already contributed to each expert_id's paper_count
        // so we can avoid double-counting papers that appear in BOTH scopus and kerberos aggs.
        const expertScopusIds = new Map();
        for (const author of authorInfos) {
            const faculty = facultyByScopusId.get(String(author.scopus_author_id));
            if (!faculty) continue;
            if (!expertScopusIds.has(faculty.expert_id)) expertScopusIds.set(faculty.expert_id, new Set());
            expertScopusIds.get(faculty.expert_id).add(String(author.scopus_author_id));
        }

        for (const bucket of kerberosBuckets) {
            const k = String(bucket.key).trim().toLowerCase();
            const faculty = facultyByKerberos.get(k);
            if (!faculty) continue;

            const maxRel = bucket.max_relevance?.value || 0;
            const avgRel = bucket.avg_relevance?.value || 0;
            const paperCount = bucket.doc_count;
            const authorScore = 0.6 * maxRel + 0.3 * avgRel + 0.1 * Math.log2(1 + paperCount);

            const key = faculty.expert_id;
            if (facultyDedup.has(key)) {
                const existing = facultyDedup.get(key);
                existing.paper_count = Math.max(existing.paper_count, paperCount);
                existing.author_score = Math.max(existing.author_score, authorScore);
            } else {
                facultyDedup.set(key, {
                    name: `${faculty.firstName} ${faculty.lastName}`.trim(),
                    expert_id: faculty.expert_id,
                    paper_count: paperCount,
                    author_score: authorScore,
                    deptName: faculty?.department?.name || 'Other'
                });
            }
        }

        // MongoDB correction: OpenSearch aggregations count scopus_id and kerberos independently,
        // so neither alone captures the union. Fetch the matching mongo_ids from OpenSearch,
        // then count per-faculty using $or scoped to those IDs.
        if (facultyDedup.size > 0) {
            try {
                // Fetch all matching mongo_ids from the same OpenSearch query (lightweight: _source only mongo_id)
                const idsQuery = { ...osQuery, size: totalDocs, _source: ['mongo_id'], aggs: undefined };
                delete idsQuery.aggs;
                const idsResponse = await this.opensearch.search({
                    index: this.indexName,
                    body: idsQuery
                });
                const mongoIds = idsResponse.body.hits.hits
                    .map(h => h._source?.mongo_id)
                    .filter(Boolean);

                if (mongoIds.length > 0) {
                    const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');
                    const facultyLookup = new Map();
                    for (const f of [...facultyDocs, ...kerberosFacultyDocs]) {
                        facultyLookup.set(f.expert_id, f);
                    }

                    const { ObjectId } = this.mongoose.Types;
                    const objectIds = mongoIds
                        .filter(id => ObjectId.isValid(id))
                        .map(id => new ObjectId(id));

                    await Promise.all([...facultyDedup.values()].map(async (merged) => {
                        const f = facultyLookup.get(merged.expert_id);
                        if (!f) return;

                        const kerbId = (f.email || '').split('@')[0].toLowerCase();
                        const sids = (f.scopus_id || []).map(String);

                        const orClauses = [];
                        if (kerbId) orClauses.push({ kerberos: kerbId });
                        if (sids.length > 0) orClauses.push({ 'authors.author_id': { $in: sids } });
                        if (orClauses.length === 0) return;

                        const count = await ResearchDocument.countDocuments({
                            _id: { $in: objectIds },
                            $or: orClauses
                        });
                        if (count > merged.paper_count) {
                            this.logger.info({
                                faculty: merged.name,
                                oldCount: merged.paper_count,
                                newCount: count
                            }, 'Faculty-for-query: MongoDB union correction applied');
                            merged.paper_count = count;
                        }
                    }));
                }
            } catch (correctionErr) {
                this.logger.warn({
                    err: correctionErr?.message || String(correctionErr),
                    stack: correctionErr?.stack
                }, 'Faculty-for-query: MongoDB correction failed, using aggregation counts');
            }
        }

        const deptMap = new Map();
        let includedCount = 0;

        for (const [, merged] of facultyDedup) {
            const deptName = merged.deptName;

            if (!deptMap.has(deptName)) {
                deptMap.set(deptName, { name: deptName, faculty: [], facultyScores: [], totalPaperCount: 0 });
            }

            const dept = deptMap.get(deptName);
            dept.faculty.push({
                name: merged.name,
                author_id: merged.expert_id,
                paper_count: merged.paper_count,
                relevance_score: Math.round(merged.author_score * 100) / 100
            });
            dept.facultyScores.push(merged.author_score);
            dept.totalPaperCount += merged.paper_count;
            includedCount++;
        }

        // Score departments by average of their top-3 faculty scores
        // This prevents large departments with many low-relevance faculty from winning
        // Small bonus for having more relevant faculty: × (1 + 0.1 × log2(count))
        const departments = Array.from(deptMap.values())
            .map(dept => {
                // Sort faculty scores descending, take top 3
                const topScores = dept.facultyScores.sort((a, b) => b - a).slice(0, 3);
                const avgTopScore = topScores.reduce((s, v) => s + v, 0) / topScores.length;
                const deptScore = avgTopScore * (1 + 0.1 * Math.log2(dept.facultyScores.length));
                return {
                    name: dept.name,
                    faculty: dept.faculty.sort((a, b) => b.relevance_score - a.relevance_score),
                    total_paper_count: dept.totalPaperCount,
                    _deptScore: deptScore
                };
            })
            .sort((a, b) => {
                if (a.name === 'Other') return 1;
                if (b.name === 'Other') return -1;
                return b._deptScore - a._deptScore;
            })
            .map(({ _deptScore, ...dept }) => dept); // Strip internal scoring field

        const response = {
            departments,
            total_faculty: includedCount,
            total_matching_papers: totalDocs
        };

        // Cache for 10 minutes (this is a heavy query)
        try {
            await this.redis.setex(cacheKey, 600, JSON.stringify(response));
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache write failed for faculty-for-query');
        }

        this.logger.info({
            query,
            totalFaculty: authorInfos.length,
            totalDepts: departments.length
        }, 'Faculty-for-query complete');

        return { ...response, cacheHit: false };
    }
}
