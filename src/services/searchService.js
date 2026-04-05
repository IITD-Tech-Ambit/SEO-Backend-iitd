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

        // Nested author filters (Phase 2 - will work after reindexing)
        if (filters?.author_id) {
            mustFilters.push({
                nested: {
                    path: 'authors',
                    query: { term: { 'authors.author_id': filters.author_id } }
                }
            });
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

    /**
     * Build BM25-only query (Basic mode) — no embeddings, no ML
     * STRICT keyword matching: no fuzziness on the primary match.
     * Uses cross_fields + operator:and for precise multi-word matching.
     * Fuzziness is reserved for the fallback path only.
     * Supports refine_within for search-on-search narrowing
     */
    _buildBasicQuery(query, filters, page, perPage, sort, searchIn = null, refineWithin = null) {
        const from = (page - 1) * perPage;
        const filterClauses = this._buildFilters(filters);
        
        // Remove ngram and autocomplete fields to enforce exact word matching
        const searchFields = this._getSearchFields(searchIn)
            .filter(f => !f.includes('.ngram') && !f.includes('.autocomplete'));

        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;

        // Primary MUST clause: strict BM25 keyword match — NO fuzziness
        // Uses cross_fields so "carbon nanofibre" matches even if "carbon" is in title
        // and "nanofibre" is in abstract. operator:and ensures ALL terms must appear.
        const mustClauses = [
            {
                multi_match: {
                    query: query,
                    fields: searchFields,
                    type: 'cross_fields',
                    operator: 'and'
                }
            }
        ];

        // If refining within a prior query, add the original query as another MUST
        if (refineWithin) {
            mustClauses.push({
                multi_match: {
                    query: refineWithin,
                    fields: searchFields,
                    type: 'cross_fields',
                    operator: 'and'
                }
            });
        }

        // SHOULD (boost-only): phrase match + subject area + field
        const boostClauses = [];

        if (isMultiWord) {
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

        boostClauses.push({
            match: { 'subject_area': { query: query, boost: 2.0 } }
        });

        boostClauses.push({
            match: { 'field_associated': { query: query, boost: 1.5 } }
        });

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
         _buildHybridQuery(query, embedding, filters, page, perPage, sort, searchIn = null) {
        const from = (page - 1) * perPage;
        const filterClauses = this._buildFilters(filters);
        // For advanced search fuzzy matching, n-gram fields generate too much noise. Filter them out.
        const searchFields = this._getSearchFields(searchIn)
            .filter(f => !f.includes('.ngram') && !f.includes('.autocomplete'));

        // Detect multi-word query for phrase boosting
        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;

        // Determine minimum_should_match for multi-word convergence
        // For 2 words, require both (100%). For 3+ words, require 75%.
        const minShouldMatch = isMultiWord ? (words.length === 2 ? '2' : '2<75%') : '1';

        // Build BOOST-only should clauses (ranking, not matching)
        const boostClauses = [];

        // Phrase boost for multi-word queries
        if (isMultiWord) {
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

        // Subject area match boost
        boostClauses.push({
            match: {
                'subject_area': {
                    query: query,
                    boost: 2.0
                }
            }
        });

        // Field associated match boost
        boostClauses.push({
            match: {
                'field_associated': {
                    query: query,
                    boost: 1.5
                }
            }
        });

        // k-NN vector search as BOOST ONLY (improves ranking, doesn't expand result set)
        boostClauses.push({
            knn: {
                embedding: {
                    vector: embedding,
                    k: 100
                }
            }
        });

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
            track_total_hits: true,  // Get accurate total count
            min_score: this.searchConfig.minScore.hybrid,  // Filter low-confidence results
            _source: ['mongo_id'],
            query: {
                bool: {
                    // MUST: BM25 keyword match required (controls result set size)
                    must: [
                        {
                            multi_match: {
                                query: query,
                                fields: searchFields,
                                type: 'best_fields',
                                tie_breaker: 0.3,
                                fuzziness: 'AUTO',
                                minimum_should_match: minShouldMatch
                            }
                        }
                    ],
                    // SHOULD: Boost clauses improve ranking but don't expand results
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
    _buildImpactQuery(query, embedding, filters, page, perPage, searchIn = null) {
        const from = (page - 1) * perPage;
        const filterClauses = this._buildFilters(filters);
        const searchFields = this._getSearchFields(searchIn);
        const currentYear = new Date().getFullYear();

        // Detect multi-word query
        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;
        const minShouldMatch = isMultiWord ? '75%' : '1';

        // Build boost-only should clauses
        const boostClauses = [
            // Subject area boost
            {
                match: {
                    'subject_area': { query: query, boost: 2.0 }
                }
            }
        ];

        // Add phrase boost
        if (isMultiWord) {
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
            min_score: this.searchConfig.minScore.impact,  // Filter low-confidence results
            _source: ['mongo_id'],
            query: {
                function_score: {
                    query: {
                        bool: {
                            must: [
                                // Require keyword match with multi-word convergence
                                {
                                    multi_match: {
                                        query: query,
                                        fields: searchFields,
                                        type: 'best_fields',
                                        tie_breaker: 0.3,
                                        fuzziness: 'AUTO',
                                        minimum_should_match: minShouldMatch
                                    }
                                }
                            ],
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
    _buildNormalizedHybridQuery(query, embedding, filters, page, perPage, searchIn = null) {
        const from = (page - 1) * perPage;
        const filterClauses = this._buildFilters(filters);
        const searchFields = this._getSearchFields(searchIn);
        const weights = this.searchConfig.hybridWeights;

        // Detect multi-word query
        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;
        const minShouldMatch = isMultiWord ? '75%' : '1';

        // BM25 must clause with convergence
        const bm25Must = {
            multi_match: {
                query: query,
                fields: searchFields,
                type: 'best_fields',
                tie_breaker: 0.3,
                fuzziness: 'AUTO',
                minimum_should_match: minShouldMatch
            }
        };

        // Boost-only clauses
        const boostClauses = [
            {
                match: {
                    'subject_area': { query: query, boost: 2.0 }
                }
            }
        ];

        if (isMultiWord) {
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
        return mongoIds
            .map(id => docMap.get(id))
            .filter(Boolean);
    }

    /**
     * Extract related faculty from search results
     * Finds university faculty linked to matching papers via expert_id
     */
    async _extractRelatedFaculty(results) {
        if (!results.length) return [];

        const Faculty = this.mongoose.model('Faculty');

        // Collect unique expert_ids from results
        const expertIds = new Set();
        const expertPaperCount = new Map();

        for (const doc of results) {
            if (doc.expert_id) {
                expertIds.add(doc.expert_id);
                expertPaperCount.set(doc.expert_id, (expertPaperCount.get(doc.expert_id) || 0) + 1);
            }
        }

        this.logger.info({
            uniqueExperts: expertIds.size
        }, 'Expert IDs collected from results');

        let facultyDocs = [];

        if (expertIds.size > 0) {
            facultyDocs = await Faculty.find({
                expert_id: { $in: Array.from(expertIds) }
            })
                .populate('department', 'name')
                .select('firstName lastName email expert_id department')
                .limit(20)
                .lean();

            this.logger.info({ foundCount: facultyDocs.length }, 'Faculty found by expert_id match');
        }

        // Return faculty
        return facultyDocs.map(f => ({
            _id: f._id,
            name: `${f.firstName} ${f.lastName}`.trim(),
            email: f.email,
            expert_id: f.expert_id,
            department: f.department,
            paperCount: expertPaperCount.get(f.expert_id) || 1
        }));
    }

    /**
     * Execute search with caching
     * Supports mode='basic' (BM25-only) and mode='advanced' (hybrid BM25+kNN)
     * Supports refine_within for search-on-search narrowing
     */
    async search({ query, filters, sort = 'relevance', page = 1, per_page = 20, search_in = null, mode = 'advanced', refine_within = null }) {
        // Include mode and refine_within in cache key
        const cachePayload = JSON.stringify({
            query, filters, sort, page, per_page, search_in, mode, refine_within
        });
        const cacheKey = `search:${crypto.createHash('sha256').update(cachePayload).digest('hex').slice(0, 16)}`;

        this.logger.info({ cacheKey, query, filters, sort, search_in, mode, refine_within }, 'Search request');

        // TEMPORARY: Bypass cache for debugging
        const bypassCache = true;

        // Check cache
        try {
            if (!bypassCache) {
                const cached = await this.redis.get(cacheKey);
                if (cached) {
                    this.logger.info({ cacheKey, query }, 'Search cache HIT');
                    return { ...JSON.parse(cached), cacheHit: true };
                }
            }
            this.logger.info({ cacheKey, bypassCache }, 'Search cache MISS or bypassed');
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed');
        }

        // ── BASIC MODE: Pure BM25, no embeddings ──
        if (mode === 'basic') {
            this.logger.info({ query, mode }, 'Running BASIC (BM25-only) search');

            const osQuery = this._buildBasicQuery(query, filters, page, per_page, sort, search_in, refine_within);
            // No min_score for basic: operator:'and' ensures all terms must match, no need for score threshold

            this.logger.info({ mode: 'basic', refine_within: !!refine_within }, 'Basic query built');

            let osResponse = await this.opensearch.search({
                index: this.indexName,
                body: osQuery
            });

            let hits = osResponse.body.hits.hits;
            let total = osResponse.body.hits.total.value;

            // If exact matching gives zero results, try the fuzzy fallback
            if (total === 0) {
                this.logger.info({ query }, 'Basic exact search returned 0 results, attempting fuzzy fallback');
                return await this._basicFuzzyFallback(query, filters, sort, page, per_page, search_in, refine_within);
            }
            const results = await this._hydrateFromMongoDB(hits);
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
        const bm25Matches = await this._bm25PreCheck(query);

        // If no BM25 matches even with fuzziness, try fuzzy fallback
        if (bm25Matches === 0) {
            this.logger.info({ query }, 'No BM25 matches even with fuzziness, attempting fuzzy fallback');
            return await this._fuzzyFallbackSearch(query, embedding, filters, sort, page, per_page, search_in);
        }

        // Dynamic min_score
        const dynamicMinScore = 0.5;

        // Build query based on sort option
        let osQuery;
        if (sort === 'impact') {
            osQuery = this._buildImpactQuery(query, embedding, filters, page, per_page, search_in);
        } else if (sort === 'normalized') {
            osQuery = this._buildNormalizedHybridQuery(query, embedding, filters, page, per_page, search_in);
        } else {
            osQuery = this._buildHybridQuery(query, embedding, filters, page, per_page, sort, search_in);
        }

        // If refining within a prior query, add the original query as an additional BM25 MUST clause
        if (refine_within) {
            const searchFields = this._getSearchFields(search_in);
            const refineWords = refine_within.trim().split(/\s+/);
            const refineMinMatch = refineWords.length >= 2 ? '75%' : '1';

            // Inject the original query into the bool.must array
            if (osQuery.query?.bool?.must) {
                osQuery.query.bool.must.push({
                    multi_match: {
                        query: refine_within,
                        fields: searchFields,
                        type: 'best_fields',
                        tie_breaker: 0.3,
                        fuzziness: 'AUTO',
                        minimum_should_match: refineMinMatch
                    }
                });
            } else if (osQuery.query?.function_score?.query?.bool?.must) {
                // For impact/normalized queries that use function_score wrapper
                osQuery.query.function_score.query.bool.must.push({
                    multi_match: {
                        query: refine_within,
                        fields: searchFields,
                        type: 'best_fields',
                        tie_breaker: 0.3,
                        fuzziness: 'AUTO',
                        minimum_should_match: refineMinMatch
                    }
                });
            }
            this.logger.info({ refine_within }, 'Added refine_within constraint to advanced query');
        }

        // Apply dynamic min_score
        osQuery.min_score = dynamicMinScore;

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
            return await this._fuzzyFallbackSearch(query, embedding, filters, sort, page, per_page, search_in);
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
    async _bm25PreCheck(query) {
        const bm25CheckQuery = {
            size: 0,
            query: {
                bool: {
                    should: [
                        {
                            multi_match: {
                                query: query,
                                fields: ['title', 'abstract', 'author_names', 'subject_area'],
                                fuzziness: 'AUTO'
                            }
                        },
                        {
                            multi_match: {
                                query: query,
                                fields: [
                                    'author_names.ngram',
                                    'subject_area.ngram',
                                    'field_associated.ngram'
                                ]
                            }
                        }
                    ],
                    minimum_should_match: 1
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
     * Basic mode fuzzy fallback — BM25-only with high fuzziness, no embeddings
     */
    async _basicFuzzyFallback(query, filters, sort, page, per_page, search_in, refine_within) {
        const from = (page - 1) * per_page;
        const searchFields = this._getSearchFields(search_in);
        const filterClauses = this._buildFilters(filters);

        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;
        const minShouldMatch = isMultiWord ? '75%' : '1';

        const mustClauses = [
            {
                multi_match: {
                    query: query,
                    fields: searchFields,
                    type: 'cross_fields',
                    operator: 'and',
                    fuzziness: 2
                }
            }
        ];

        // Add refine_within constraint if present
        if (refine_within) {
            mustClauses.push({
                multi_match: {
                    query: refine_within,
                    fields: searchFields,
                    type: 'cross_fields',
                    operator: 'and',
                    fuzziness: 2
                }
            });
        }

        const fallbackQuery = {
            size: per_page,
            from,
            track_total_hits: true,
            _source: ['mongo_id'],
            query: {
                bool: {
                    must: mustClauses,
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
            const related_faculty = await this._extractRelatedFaculty(results);

            return {
                results,
                related_faculty,
                suggestions: [],
                facets: this._parseFacets(osResponse.body.aggregations),
                pagination: { page, per_page, total, total_pages: Math.ceil(total / per_page) },
                mode: 'basic',
                fuzzy_fallback: true,
                cacheHit: false
            };
        } catch (err) {
            this.logger.error({ err, query }, 'Basic fuzzy fallback search failed');
            return {
                results: [],
                related_faculty: [],
                suggestions: [],
                facets: {},
                pagination: { page, per_page, total: 0, total_pages: 0 },
                mode: 'basic',
                fuzzy_fallback: true,
                cacheHit: false
            };
        }
    }

    /**
     * Fuzzy fallback search — used when primary search/pre-check returns 0 results
     * Runs with higher fuzziness tolerance and no min_score to catch typos
     */
    async _fuzzyFallbackSearch(query, embedding, filters, sort, page, per_page, search_in) {
        const from = (page - 1) * per_page;
        const searchFields = this._getSearchFields(search_in);
        const filterClauses = this._buildFilters(filters);

        const fallbackQuery = {
            size: per_page,
            from,
            track_total_hits: true,
            _source: ['mongo_id'],
            query: {
                bool: {
                    must: [
                        {
                            multi_match: {
                                query: query,
                                fields: searchFields,
                                type: 'best_fields',
                                tie_breaker: 0.3,
                                fuzziness: 2  // Higher fuzziness for fallback
                            }
                        }
                    ],
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
            const suggestions = await this._getSuggestions(query);

            return {
                results,
                related_faculty: [],
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
     * Author-scoped search: find an author's papers most relevant to a query.
     * 
     * Phase 1: Fetch all paper IDs for the author from MongoDB (indexed).
     * Phase 2: Run cosine similarity between query embedding and those papers in OpenSearch.
     * Phase 3: Hydrate results from MongoDB.
     *
     * @param {Object} params
     * @param {string} params.query - The search query text
     * @param {string} params.author_id - Scopus author ID
     * @param {number} [params.page=1]
     * @param {number} [params.per_page=20]
     */
    async authorScopedSearch({ query, author_id, page = 1, per_page = 20, mode = 'advanced', refine_within = null }) {
        // Cache key
        const queryHash = crypto.createHash('sha256')
            .update(JSON.stringify({ query, author_id, page, per_page, mode, refine_within }))
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

        // Phase 1: Get author's paper OpenSearch IDs from MongoDB
        // The author_id may be an expert_id (from faculty sidebar) or a Scopus author_id.
        // Try expert_id first (indexed, direct link), fall back to authors.author_id.
        let osIds, authorName;
        try {
            const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');
            const Faculty = this.mongoose.model('Faculty');

            // Try expert_id first (covers faculty sidebar clicks)
            let authorDocs = await ResearchDocument.find(
                { expert_id: author_id },
                { open_search_id: 1, _id: 0 }
            ).lean();

            // Fall back to Scopus author_id if expert_id matched nothing
            if (authorDocs.length === 0) {
                authorDocs = await ResearchDocument.find(
                    { 'authors.author_id': author_id },
                    { open_search_id: 1, _id: 0 }
                ).lean();
            }

            osIds = authorDocs
                .map(d => d.open_search_id)
                .filter(Boolean);

            this.logger.info({
                author_id,
                totalPapers: osIds.length,
                sampleIds: osIds.slice(0, 3)
            }, 'Author-scoped search: Phase 1 - fetched paper IDs from MongoDB');

            if (osIds.length === 0) {
                return {
                    results: [],
                    author: { author_id, name: 'Unknown', total_papers: 0 },
                    pagination: { page, per_page, total: 0, total_pages: 0 },
                    cacheHit: false
                };
            }

            // Get author name: try Faculty collection first (for expert_id), then from paper authors
            const faculty = await Faculty.findOne({ expert_id: author_id }).lean();
            if (faculty) {
                authorName = `${faculty.firstName} ${faculty.lastName}`.trim();
            } else {
                const authorNameDoc = await ResearchDocument.findOne(
                    { 'authors.author_id': author_id },
                    { 'authors.$': 1 }
                ).lean();
                authorName = authorNameDoc?.authors?.[0]?.author_name || 'Unknown';
            }
        } catch (err) {
            this.logger.error({ err, author_id }, 'Author-scoped search: Phase 1 FAILED (MongoDB)');
            throw err;
        }

        // Phase 2: Semantic similarity search restricted to author's papers
        let hits, total;
        try {
            const embedding = await this.embeddingService.embedQuery(query);
            const from = (page - 1) * per_page;

            const isBasic = mode === 'basic';
            let searchFields = this._getSearchFields(null);
            let osQuery;

            if (isBasic) {
                searchFields = searchFields.filter(f => !f.includes('.ngram') && !f.includes('.autocomplete'));
                const multiMatchConfig = {
                    type: 'cross_fields',
                    operator: 'and'
                };
                osQuery = {
                    size: per_page,
                    from,
                    track_total_hits: true,
                    _source: ['mongo_id'],
                    query: {
                        script_score: {
                            query: {
                                bool: {
                                    filter: [
                                        { ids: { values: osIds } }
                                    ],
                                    must: [
                                        {
                                            multi_match: {
                                                query: query,
                                                fields: searchFields,
                                                ...multiMatchConfig
                                            }
                                        },
                                        ...(refine_within ? [{
                                            multi_match: {
                                                query: refine_within,
                                                fields: searchFields,
                                                ...multiMatchConfig
                                            }
                                        }] : [])
                                    ]
                                }
                            },
                            script: {
                                lang: 'knn',
                                source: 'knn_score',
                                params: {
                                    field: 'embedding',
                                    query_value: embedding,
                                    space_type: 'cosinesimil'
                                }
                            }
                        }
                    }
                };
            } else {
                searchFields = searchFields.filter(f => !f.includes('.ngram') && !f.includes('.autocomplete'));
                const words = query.trim().split(/\s+/);
                const isMultiWord = words.length >= 2;
                const minShouldMatch = isMultiWord ? (words.length === 2 ? '2' : '2<75%') : '1';
                
                const boostClauses = [];

                if (isMultiWord) {
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

                boostClauses.push({
                    match: {
                        'subject_area': {
                            query: query,
                            boost: 2.0
                        }
                    }
                });

                boostClauses.push({
                    match: {
                        'field_associated': {
                            query: query,
                            boost: 1.5
                        }
                    }
                });

                boostClauses.push({
                    knn: {
                        embedding: {
                            vector: embedding,
                            k: 100
                        }
                    }
                });

                osQuery = {
                    size: per_page,
                    from,
                    track_total_hits: true,
                    min_score: this.searchConfig.minScore.hybrid,
                    _source: ['mongo_id'],
                    query: {
                        bool: {
                            filter: [
                                { ids: { values: osIds } }
                            ],
                            must: [
                                {
                                    multi_match: {
                                        query: query,
                                        fields: searchFields,
                                        type: 'best_fields',
                                        tie_breaker: 0.3,
                                        fuzziness: 'AUTO',
                                        minimum_should_match: minShouldMatch
                                    }
                                },
                                ...(refine_within ? [{
                                    multi_match: {
                                        query: refine_within,
                                        fields: searchFields,
                                        type: 'best_fields',
                                        tie_breaker: 0.3,
                                        fuzziness: 'AUTO',
                                        minimum_should_match: refine_within.trim().split(/\s+/).length >= 2 ? '75%' : '1'
                                    }
                                }] : [])
                            ],
                            should: boostClauses
                        }
                    }
                };
            }

            this.logger.info({
                author_id,
                query,
                osIdsCount: osIds.length,
                embeddingLength: embedding.length
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
        } catch (err) {
            this.logger.error({ err, author_id }, 'Author-scoped search: Phase 3 FAILED (Hydration)');
            throw err;
        }

        const response = {
            results: scoredResults,
            author: {
                name: authorName,
                author_id,
                total_papers: osIds.length
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
            totalPapers: osIds.length,
            matchedResults: total
        }, 'Author-scoped search complete');

        return { ...response, cacheHit: false };
    }

    /**
     * Get co-authors for a specific author (Phase 2 - after reindexing)
     */
    async getCoAuthors(authorId) {
        const result = await this.opensearch.search({
            index: this.indexName,
            body: {
                size: 0,
                query: {
                    nested: {
                        path: 'authors',
                        query: { term: { 'authors.author_id': authorId } }
                    }
                },
                aggs: {
                    author_papers: {
                        nested: { path: 'authors' },
                        aggs: {
                            coauthors: {
                                terms: {
                                    field: 'authors.author_id',
                                    size: 50,
                                    exclude: authorId
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

        return doc;
    }

    /**
     * Get all IITD faculty for a query across the entire result set.
     * Uses OpenSearch nested aggregation (size: 0, no docs fetched).
     *
     * Returns faculty grouped by department, sorted by relevance.
     */
    async getAllFacultyForQuery(query, mode = 'advanced') {
        // Cache key
        const queryHash = crypto.createHash('sha256')
            .update(JSON.stringify({ query, type: 'faculty_for_query', mode }))
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

        // Build BM25 query with size: 0
        const isBasic = mode === 'basic';
        let searchFields = this._getSearchFields(null);
        let multiMatchConfig = {};

        if (isBasic) {
            // Strict exact-matching fields
            searchFields = searchFields.filter(f => !f.includes('.ngram') && !f.includes('.autocomplete'));
            multiMatchConfig = {
                type: 'cross_fields',
                operator: 'and'
            };
        } else {
            // Fuzzy, backwards-compatible "advanced" search.
            // Filter n-grams to prevent 35k result explosions
            searchFields = searchFields.filter(f => !f.includes('.ngram') && !f.includes('.autocomplete'));
            const words = query.trim().split(/\s+/);
            const isMultiWord = words.length >= 2;
            // For 2 words, require both (100%). For 3+ words, require 75%.
            const minShouldMatch = isMultiWord ? (words.length === 2 ? '2' : '2<75%') : '1';
            
            multiMatchConfig = {
                type: 'best_fields',
                tie_breaker: 0.3,
                fuzziness: 'AUTO',
                minimum_should_match: minShouldMatch
            };
        }

        const osQuery = {
            size: 0,
            track_total_hits: true,
            min_score: this.searchConfig.minScore.impact, // Drop noisy fuzzy papers from the aggregation pool
            query: {
                multi_match: {
                    query: query,
                    fields: searchFields,
                    ...multiMatchConfig
                }
            },
            aggs: {
                // Filter to only documents with an expert_id (linked to IITD faculty)
                with_expert: {
                    filter: { exists: { field: 'expert_id' } },
                    aggs: {
                        // Group by expert_id to find relevant faculty
                        by_expert: {
                            terms: {
                                field: 'expert_id',
                                size: 200
                            },
                            aggs: {
                                max_relevance: {
                                    max: { script: '_score' }
                                },
                                avg_relevance: {
                                    avg: { script: '_score' }
                                }
                            }
                        }
                    }
                }
            }
        };

        this.logger.info({ query }, 'Faculty-for-query: querying OpenSearch aggregation');

        const osResponse = await this.opensearch.search({
            index: this.indexName,
            body: osQuery
        });

        const totalDocs = osResponse.body.hits.total.value;
        const expertBuckets = osResponse.body.aggregations
            ?.with_expert
            ?.by_expert
            ?.buckets || [];

        this.logger.info({
            query,
            totalDocs,
            uniqueExperts: expertBuckets.length
        }, 'Faculty-for-query: aggregation results');

        if (expertBuckets.length === 0) {
            const emptyResult = {
                departments: [],
                total_faculty: 0,
                total_matching_papers: totalDocs,
                cacheHit: false
            };
            return emptyResult;
        }

        // Extract expert info from aggregation (with relevance scores)
        let authorInfos = expertBuckets.map(bucket => {
            const maxRel = bucket.max_relevance?.value || 0;
            const avgRel = bucket.avg_relevance?.value || 0;
            const paperCount = bucket.doc_count;
            // Hybrid score: 60% best-paper-match + 30% consistency + 10% volume (log-dampened)
            const authorScore = 0.6 * maxRel + 0.3 * avgRel + 0.1 * Math.log2(1 + paperCount);
            return {
                expert_id: bucket.key,
                paper_count: paperCount,
                max_relevance: maxRel,
                avg_relevance: avgRel,
                author_score: authorScore
            };
        });

        // Apply dynamic relevance thresholding logic
        if (authorInfos.length > 0) {
            const maxAuthorScore = Math.max(...authorInfos.map(a => a.author_score));
            const scoreThreshold = maxAuthorScore * 0.25; // Keep authors with at least 25% of the top profile's score

            const initialCount = authorInfos.length;
            authorInfos = authorInfos.filter(a => a.author_score >= scoreThreshold);

            this.logger.info({
                maxAuthorScore,
                scoreThreshold,
                keptAuthors: authorInfos.length,
                droppedAuthors: initialCount - authorInfos.length
            }, 'Faculty-for-query: applied dynamic relevance threshold');
        }

        // Look up Faculty + Department using expert_ids directly from aggregation
        const expertIds = authorInfos.map(a => a.expert_id);
        const Faculty = this.mongoose.model('Faculty');

        let facultyDocs = [];
        if (expertIds.length > 0) {
            facultyDocs = await Faculty.find({ expert_id: { $in: expertIds } })
                .populate('department', 'name')
                .select('firstName lastName expert_id department')
                .lean();
        }

        const facultyByExpertId = new Map(
            facultyDocs.map(f => [f.expert_id, f])
        );

        this.logger.info({
            totalExperts: expertIds.length,
            matchedFaculty: facultyDocs.length
        }, 'Faculty-for-query: expert_id lookup');

        // Build department-grouped response with RELEVANCE ordering
        // Only include experts that match a real IITD faculty
        const facultyDedup = new Map(); // expert_id -> merged faculty info

        for (const author of authorInfos) {
            const faculty = facultyByExpertId.get(author.expert_id);
            if (!faculty) continue;

            const facultyName = `${faculty.firstName} ${faculty.lastName}`.trim();
            const key = author.expert_id;
            if (facultyDedup.has(key)) {
                const existing = facultyDedup.get(key);
                existing.paper_count += author.paper_count;
                existing.author_score = Math.max(existing.author_score, author.author_score);
            } else {
                facultyDedup.set(key, {
                    name: facultyName,
                    expert_id: author.expert_id,
                    paper_count: author.paper_count,
                    author_score: author.author_score,
                    deptName: faculty?.department?.name || 'Other'
                });
            }
        }

        const deptMap = new Map(); // dept_name -> { name, faculty[], facultyScores[] }
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
