import crypto from 'crypto';

/**
 * Search Service
 * Orchestrates hybrid search across OpenSearch and MongoDB
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
    }

    /**
     * Generate cache key for search results
     * Normalizes filters to ensure consistent caching
     */
    _getCacheKey(query, filters, sort, page, perPage, searchIn = null) {
        // Normalize filters - remove undefined/null values for consistent hashing
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

        if (filters?.subject_area?.length) {
            mustFilters.push({ terms: { 'subject_area.keyword': filters.subject_area } });
        }

        return mustFilters;
    }

    /**
     * Build OpenSearch hybrid query (BM25 + Vector)
     * Uses native k-NN query for vector search
     * @param searchIn - Array of fields to search in: title, abstract, author, subject_area, field. 
     *                   If null/undefined, uses default hybrid (title, abstract, author_names)
     */
    _buildHybridQuery(query, embedding, filters, page, perPage, sort, searchIn = null) {
        const from = (page - 1) * perPage;
        const filterClauses = this._buildFilters(filters);

        // Build sort clause
        let sortClause = ['_score'];
        if (sort === 'date') {
            sortClause = [{ publication_year: 'desc' }, '_score'];
        } else if (sort === 'citations') {
            sortClause = [{ citation_count: 'desc' }, '_score'];
        }

        // Default hybrid fields (original behavior)
        let searchFields = ['title^3', 'abstract', 'author_names'];

        // Only use custom fields if explicitly specified
        if (searchIn && Array.isArray(searchIn) && searchIn.length > 0) {
            // Enhanced field mapping with N-gram and Phonetic sub-fields
            // Author: ngram for partial matching (S.K -> Sanjay Kumar), phonetic for sound-alike
            // Subject/Field: ngram for abbreviations (Chem Eng -> Chemical Engineering)
            const fieldMapping = {
                title: ['title^3'],
                abstract: ['abstract'],
                author: [
                    'author_names^2',           // Standard match
                    'author_names.ngram^1.5'    // Partial/abbreviation match
                ],
                subject_area: [
                    'subject_area^2',           // Standard match
                    'subject_area.ngram^1.5'    // Partial match
                ],
                field: [
                    'field_associated^2',       // Standard match
                    'field_associated.ngram^1.5' // Partial match
                ]
            };

            const customFields = searchIn
                .flatMap(f => fieldMapping[f] || [])
                .filter(Boolean);

            if (customFields.length > 0) {
                searchFields = customFields;
            }
        }

        return {
            size: perPage,
            from,
            _source: ['mongo_id', 'title', 'author_names', 'publication_year', 'citation_count'],
            query: {
                bool: {
                    should: [
                        // BM25 component with dynamic fields
                        {
                            multi_match: {
                                query: query,
                                fields: searchFields,
                                type: 'best_fields'
                            }
                        },
                        // k-NN component
                        {
                            knn: {
                                embedding: {
                                    vector: embedding,
                                    k: perPage
                                }
                            }
                        }
                    ],
                    minimum_should_match: 1,
                    filter: filterClauses
                }
            },
            sort: sortClause,
            // Aggregations for facets (use .keyword for text fields)
            aggs: {
                years: {
                    terms: { field: 'publication_year', size: 20, order: { _key: 'desc' } }
                },
                document_types: {
                    terms: { field: 'document_type', size: 10 }
                },
                fields: {
                    terms: { field: 'field_associated.keyword', size: 20 }
                },
                subject_areas: {
                    terms: { field: 'subject_area.keyword', size: 30 }
                }
            }
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

        // Get ResearchDocument model
        const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');

        const docs = await ResearchDocument.find({
            _id: { $in: mongoIds }
        })
            .select('-__v')
            .lean();

        // Create lookup map
        const docMap = new Map(docs.map(d => [d._id.toString(), d]));

        // Preserve OpenSearch ranking order
        return mongoIds
            .map(id => docMap.get(id))
            .filter(Boolean);
    }

    /**
     * Execute search with caching
     */
    async search({ query, filters, sort = 'relevance', page = 1, per_page = 20, search_in = null }) {
        const cacheKey = this._getCacheKey(query, filters, sort, page, per_page, search_in);

        // Debug: Log cache key and filters to diagnose caching issues
        this.logger.info({ cacheKey, query, filters, search_in }, 'Search request - cache key generated');

        // Check cache
        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                this.logger.info({ cacheKey, query }, 'Search cache HIT');
                return { ...JSON.parse(cached), cacheHit: true };
            }
            this.logger.info({ cacheKey }, 'Search cache MISS');
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed');
        }

        // Generate query embedding
        const embedding = await this.embeddingService.embedQuery(query);

        // Build and execute OpenSearch query
        const osQuery = this._buildHybridQuery(query, embedding, filters, page, per_page, sort, search_in);

        const osResponse = await this.opensearch.search({
            index: this.indexName,
            body: osQuery
        });

        const hits = osResponse.body.hits.hits;
        const total = osResponse.body.hits.total.value;

        // Hydrate from MongoDB
        const results = await this._hydrateFromMongoDB(hits);

        // Build response
        const response = {
            results,
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

        return { ...response, cacheHit: false };
    }

    /**
     * Get single document by ID
     */
    async getDocument(id) {
        const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');

        // Try as MongoDB ObjectId first
        let doc = null;

        if (id.match(/^[0-9a-fA-F]{24}$/)) {
            doc = await ResearchDocument.findById(id).lean();
        }

        // Try as OpenSearch ID
        if (!doc) {
            doc = await ResearchDocument.findOne({ open_search_id: id }).lean();
        }

        return doc;
    }
}
