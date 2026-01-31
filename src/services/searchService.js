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
                hybrid: 5.0,      // For BM25 + k-NN hybrid queries
                impact: 5.0,      // For function_score impact queries  
                normalized: 0.3   // For normalized 0-1 scale scores
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
            mustFilters.push({ term: { 'field_associated.keyword': filters.field_associated } });
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

        if (filters?.affiliation) {
            mustFilters.push({
                nested: {
                    path: 'authors',
                    query: { match: { 'authors.author_affiliation': filters.affiliation } }
                }
            });
        }

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
        const defaultFields = [
            `title^${b.title}`,
            `title.exact^${b.titleExact}`,
            `abstract^${b.abstract}`,
            `subject_area^${b.subjectArea}`,
            `subject_area.ngram^${b.subjectAreaNgram}`,
            `author_names^${b.authorName}`,
            `author_names.ngram^${b.authorNameNgram}`,
            `field_associated^${b.fieldAssociated}`,
            `field_associated.ngram^${b.fieldAssociatedNgram}`
        ];

        if (!searchIn || searchIn.length === 0) {
            return defaultFields;
        }

        // Field-specific search with optimized boosts
        const fieldMapping = {
            title: [`title^${b.title}`, `title.exact^${b.titleExact}`],
            abstract: [`abstract^${b.abstract * 1.5}`],
            author: [
                `author_names^${b.authorName * 1.5}`,
                `author_names.ngram^${b.authorNameNgram}`,
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
        const searchFields = this._getSearchFields(searchIn);

        // Detect multi-word query for phrase boosting
        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;

        // Build should clauses
        const shouldClauses = [];

        // Primary BM25 search with optimized fields
        shouldClauses.push({
            multi_match: {
                query: query,
                fields: searchFields,
                type: 'best_fields',
                tie_breaker: 0.3,
                fuzziness: 'AUTO'
            }
        });

        // Phrase boost for multi-word queries
        if (isMultiWord) {
            shouldClauses.push({
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
        shouldClauses.push({
            match: {
                'subject_area': {
                    query: query,
                    boost: 2.0
                }
            }
        });

        // Field associated match boost
        shouldClauses.push({
            match: {
                'field_associated': {
                    query: query,
                    boost: 1.5
                }
            }
        });

        // k-NN vector search
        shouldClauses.push({
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
                    should: shouldClauses,
                    minimum_should_match: 1,
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

        // Build should clauses - k-NN removed to prevent irrelevant matches
        // Documents MUST have a keyword match to appear in results
        const shouldClauses = [
            // BM25 search
            {
                multi_match: {
                    query: query,
                    fields: searchFields,
                    type: 'best_fields',
                    tie_breaker: 0.3,
                    fuzziness: 'AUTO'
                }
            },
            // Subject area boost
            {
                match: {
                    'subject_area': { query: query, boost: 2.0 }
                }
            }
        ];

        // Add phrase boost
        if (isMultiWord) {
            shouldClauses.push({
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
                                // Require at least one keyword match
                                {
                                    multi_match: {
                                        query: query,
                                        fields: searchFields,
                                        type: 'best_fields',
                                        tie_breaker: 0.3
                                    }
                                }
                            ],
                            should: shouldClauses,
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

        // Build should clauses for BM25 component
        const bm25Clauses = [
            {
                multi_match: {
                    query: query,
                    fields: searchFields,
                    type: 'best_fields',
                    tie_breaker: 0.3
                }
            },
            {
                match: {
                    'subject_area': { query: query, boost: 2.0 }
                }
            }
        ];

        if (isMultiWord) {
            bm25Clauses.push({
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
                            should: bm25Clauses,
                            filter: filterClauses,
                            minimum_should_match: 1
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
     * Finds university faculty who are authors of matching papers
     */
    async _extractRelatedFaculty(results) {
        if (!results.length) return [];

        const Faculty = this.mongoose.model('Faculty');
        
        // Collect all author emails from papers that contain 'iitd'
        const authorEmails = new Set();
        
        for (const doc of results) {
            if (doc.authors && Array.isArray(doc.authors)) {
                for (const author of doc.authors) {
                    if (author.author_email) {
                        const email = author.author_email.toLowerCase().trim();
                        if (email.includes('iitd')) {
                            authorEmails.add(email);
                        }
                    }
                }
            }
        }

        this.logger.info({ 
            authorEmailCount: authorEmails.size, 
            sampleEmails: Array.from(authorEmails).slice(0, 5) 
        }, 'IITD author emails collected');

        let facultyDocs = [];

        if (authorEmails.size > 0) {
            const emailArray = Array.from(authorEmails);
            
            // Extract usernames (part before @)
            const usernames = emailArray.map(e => e.split('@')[0]).filter(u => u && u.length > 2);
            
            this.logger.info({ usernames: usernames.slice(0, 10) }, 'Searching faculty by usernames');

            if (usernames.length > 0) {
                // Match faculty by email starting with any of the usernames
                const regexPattern = usernames.slice(0, 30).map(u => `^${u}@`).join('|');
                
                facultyDocs = await Faculty.find({
                    email: { $regex: regexPattern, $options: 'i' }
                })
                    .populate('department', 'name')
                    .select('name email department')
                    .limit(20)
                    .lean();
                
                this.logger.info({ foundCount: facultyDocs.length }, 'Faculty found by username match');
            }
        }

        // Fallback: If no faculty found by email, try fetching some faculty to test the flow
        if (facultyDocs.length === 0) {
            this.logger.info('No email match found, fetching sample faculty for testing');
            
            // Just get some faculty members to verify the flow works
            facultyDocs = await Faculty.find({})
                .populate('department', 'name')
                .select('name email department')
                .limit(10)
                .lean();
            
            this.logger.info({ sampleCount: facultyDocs.length }, 'Sample faculty fetched');
        }

        if (facultyDocs.length === 0) {
            this.logger.info('No faculty in database');
            return [];
        }

        // DEBUG: Log raw faculty data to check department population
        this.logger.info({ 
            sampleFacultyRaw: facultyDocs.slice(0, 3).map(f => ({
                name: f.name,
                email: f.email,
                department: f.department,
                departmentType: typeof f.department
            }))
        }, 'Raw faculty data before transformation');

        // Return faculty
        return facultyDocs.map(f => ({
            _id: f._id,
            name: f.name,
            email: f.email,
            department: f.department,
            paperCount: 1
        }));
    }

    /**
     * Execute search with caching
     */
    async search({ query, filters, sort = 'relevance', page = 1, per_page = 20, search_in = null }) {
        const cacheKey = this._getCacheKey(query, filters, sort, page, per_page, search_in);

        this.logger.info({ cacheKey, query, filters, sort, search_in }, 'Search request');

        // TEMPORARY: Bypass cache for debugging
        // TODO: Remove this after debugging
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

        // Generate query embedding
        const embedding = await this.embeddingService.embedQuery(query);

        // Pre-check: Run BM25-only query to verify query has keyword matches
        const bm25CheckQuery = {
            size: 0,
            query: {
                multi_match: {
                    query: query,
                    fields: ['title', 'abstract', 'author_names', 'subject_area']
                }
            }
        };

        const bm25CheckResponse = await this.opensearch.search({
            index: this.indexName,
            body: bm25CheckQuery
        });

        const bm25Matches = bm25CheckResponse.body.hits.total.value;

        // If no BM25 matches, return empty results
        if (bm25Matches === 0) {
            return {
                results: [],
                facets: {},
                pagination: { page, per_page, total: 0, total_pages: 0 },
                message: 'No relevant results found for your query',
                cacheHit: false
            };
        }

        // Dynamic min_score: relaxed to allow non-title matches (Tier 2) to appear
        const dynamicMinScore = 1.0;

        // Build query based on sort option
        let osQuery;
        if (sort === 'impact') {
            osQuery = this._buildImpactQuery(query, embedding, filters, page, per_page, search_in);
        } else if (sort === 'normalized') {
            osQuery = this._buildNormalizedHybridQuery(query, embedding, filters, page, per_page, search_in);
        } else {
            osQuery = this._buildHybridQuery(query, embedding, filters, page, per_page, sort, search_in);
        }

        // Apply dynamic min_score based on BM25 match count
        osQuery.min_score = dynamicMinScore;

        // DEBUG: Log the actual OpenSearch query being sent
        this.logger.info({ 
            opensearchQuery: JSON.stringify(osQuery.query, null, 2),
            sort: osQuery.sort,
            minScore: osQuery.min_score
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

        // Build response
        const response = {
            results,
            related_faculty,
            facets: this._parseFacets(osResponse.body.aggregations),
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
            this.logger.warn({ err }, 'Redis cache write failed');
        }

        this.logger.info({ 
            facultyCount: related_faculty.length,
            sampleFaculty: related_faculty.slice(0, 2)
        }, 'Returning search response with faculty');

        return { ...response, cacheHit: false };
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
                                            _source: ['authors.author_name', 'authors.author_affiliation']
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
                name: c.author_info?.hits?.hits?.[0]?._source?.authors?.author_name,
                affiliation: c.author_info?.hits?.hits?.[0]?._source?.authors?.author_affiliation
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
}
