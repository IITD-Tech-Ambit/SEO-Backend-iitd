import { resolveFacultyByAuthorId } from '../utils/facultyIdentity.js';
import ResultHydrator from './search/ResultHydrator.js';

/**
 * Document lookups and author-graph queries (co-authors, similar papers).
 * Kept separate from SearchService so search orchestration stays focused on
 * cache → basic/advanced → hydrate/rerank.
 */
export default class DocumentService {
    constructor({ opensearch, opensearchIndex, redis, redisTTL, mongoose, logger }) {
        this.opensearch = opensearch;
        this.indexName = opensearchIndex;
        this.redis = redis;
        this.redisTTL = redisTTL;
        this.mongoose = mongoose;
        this.logger = logger;
        this.hydrator = new ResultHydrator({ mongoose, logger });
    }

    /**
     * Find semantically similar papers using k-NN on an existing document's embedding.
     */
    async findSimilar(documentId, limit = 10) {
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

        const similarQuery = await this.opensearch.search({
            index: this.indexName,
            body: {
                size: limit,
                _source: ['mongo_id'],
                query: {
                    bool: {
                        must: [{ knn: { embedding: { vector: embedding, k: limit + 5 } } }],
                        must_not: [{ term: { mongo_id: documentId } }]
                    }
                }
            }
        });

        const results = await this.hydrator.hydrateFromMongoDB(similarQuery.body.hits.hits);
        const scoreMap = new Map(similarQuery.body.hits.hits.map(h => [h._source.mongo_id, h._score]));

        return {
            source: { id: documentId, title: source.title, subject_areas: source.subject_area },
            similar: results.map(r => ({ ...r, similarity_score: scoreMap.get(r._id.toString()) }))
        };
    }

    /**
     * Co-authors for a faculty member, found via both nested Scopus author_id and kerberos.
     */
    async getCoAuthors(authorId) {
        const cacheKey = `coauthors:${authorId}`;
        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) return JSON.parse(cached);
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed (getCoAuthors)');
        }

        const Faculty = this.mongoose.model('Faculty');
        const { kerberos: kerberosId, scopusIds } = await resolveFacultyByAuthorId(Faculty, authorId);
        const allScopusIds = scopusIds.length > 0 ? scopusIds : [authorId];

        const shouldClauses = [
            { nested: { path: 'authors', query: { terms: { 'authors.author_id': allScopusIds } } } }
        ];
        if (kerberosId) shouldClauses.push({ term: { kerberos: kerberosId } });

        const result = await this.opensearch.search({
            index: this.indexName,
            body: {
                size: 0,
                query: { bool: { should: shouldClauses, minimum_should_match: 1 } },
                aggs: {
                    author_papers: {
                        nested: { path: 'authors' },
                        aggs: {
                            coauthors: {
                                terms: { field: 'authors.author_id', size: 50, exclude: allScopusIds },
                                aggs: {
                                    author_info: { top_hits: { size: 1, _source: ['authors.author_name'] } }
                                }
                            }
                        }
                    },
                    total_papers: { value_count: { field: 'mongo_id' } }
                }
            }
        });

        const coauthors = result.body.aggregations?.author_papers?.coauthors?.buckets || [];

        const response = {
            author_id: authorId,
            total_papers: result.body.aggregations?.total_papers?.value || 0,
            collaborators: coauthors.map(c => ({
                author_id: c.key,
                collaboration_count: c.doc_count,
                name: c.author_info?.hits?.hits?.[0]?._source?.authors?.author_name
            }))
        };

        try {
            await this.redis.setex(cacheKey, this.redisTTL.coAuthors, JSON.stringify(response));
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache write failed (getCoAuthors)');
        }

        return response;
    }

    /**
     * Single document by Mongo `_id` or `open_search_id`.
     */
    async getDocument(id) {
        const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');
        let doc = null;
        if (id.match(/^[0-9a-fA-F]{24}$/)) doc = await ResearchDocument.findById(id).lean();
        if (!doc) doc = await ResearchDocument.findOne({ open_search_id: id }).lean();
        if (doc) await this.hydrator.filterAuthorsToFacultyRoster([doc]);
        return doc;
    }

    /**
     * All documents for a faculty member, paginated. Resolves via BOTH kerberos
     * (Faculty.email prefix) and scopus_id so callers can pass an expert_id or a
     * scopus_id — the dual-mapping strategy used across the service. Shared by
     * REST and gRPC GetDocumentsByAuthor so both planes use one cache key.
     */
    async getDocumentsByAuthor(authorId, { page = 1, per_page = 20 } = {}) {
        const cacheKey = `author-docs:${authorId}:${page}:${per_page}`;

        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) return JSON.parse(cached);
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed (getDocumentsByAuthor)');
        }

        const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');
        const Faculty = this.mongoose.model('Faculty');
        const skip = (page - 1) * per_page;

        const { kerberos, scopusIds } = await resolveFacultyByAuthorId(Faculty, authorId);

        const orClauses = [];
        if (kerberos) orClauses.push({ kerberos });
        if (scopusIds.length > 0) {
            orClauses.push({ 'authors.author_id': { $in: scopusIds } });
        } else {
            orClauses.push({ 'authors.author_id': authorId });
        }

        const filter = orClauses.length > 1 ? { $or: orClauses } : orClauses[0];

        const [documents, total] = await Promise.all([
            ResearchDocument.find(filter)
                .select('-__v')
                .sort({ publication_year: -1 })
                .skip(skip)
                .limit(per_page)
                .lean(),
            ResearchDocument.countDocuments(filter)
        ]);

        const response = {
            documents,
            pagination: {
                page,
                per_page,
                total,
                total_pages: Math.ceil(total / per_page)
            }
        };

        try {
            await this.redis.setex(cacheKey, this.redisTTL.authorDocuments, JSON.stringify(response));
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache write failed (getDocumentsByAuthor)');
        }

        return response;
    }
}
