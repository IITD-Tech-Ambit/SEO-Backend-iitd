/**
 * RAG Retrieval Service
 * Retrieves the most relevant research papers for a chat question:
 * embed query -> hybrid BM25 + kNN search in OpenSearch -> hydrate from MongoDB.
 */
export default class RagService {
    constructor(fastify, config) {
        this.opensearch = fastify.opensearch;
        this.indexName = fastify.opensearchIndex;
        this.mongoose = fastify.mongoose;
        this.embeddingService = fastify.embeddingService;
        this.config = config;
        this.logger = fastify.log;
    }

    /**
     * Retrieve top-k papers relevant to the query.
     * Returns hydrated documents with a stable citation index (1-based).
     */
    async retrieve(query, topK = this.config.chat.topK) {
        const embedding = await this.embeddingService.embedQuery(query);

        const osQuery = {
            index: this.indexName,
            body: {
                size: topK,
                _source: ['mongo_id'],
                query: {
                    bool: {
                        should: [
                            {
                                multi_match: {
                                    query,
                                    fields: ['title^4', 'abstract^1.5', 'subject_area^2', 'field_associated^2'],
                                    type: 'best_fields',
                                    fuzziness: 'AUTO'
                                }
                            },
                            {
                                knn: {
                                    embedding: {
                                        vector: embedding,
                                        k: Math.max(topK * 5, 50)
                                    }
                                }
                            }
                        ],
                        minimum_should_match: 1
                    }
                }
            }
        };

        const response = await this.opensearch.search(osQuery);
        const hits = response.body.hits?.hits || [];
        if (!hits.length) return [];

        const docs = await this._hydrate(hits);

        return docs.map((doc, i) => ({
            index: i + 1,
            id: doc._id.toString(),
            title: doc.title || '',
            abstract: doc.abstract || '',
            authors: (doc.authors || []).map(a => a.author_name).filter(Boolean),
            publication_year: doc.publication_year ?? null,
            document_type: doc.document_type || null,
            field_associated: doc.field_associated || null,
            citation_count: doc.citation_count ?? 0,
            link: doc.link || null
        }));
    }

    /**
     * Hydrate OpenSearch hits from MongoDB, preserving ranking order.
     */
    async _hydrate(osHits) {
        const mongoIds = osHits.map(hit => hit._source.mongo_id).filter(Boolean);
        if (!mongoIds.length) return [];

        const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');
        const docs = await ResearchDocument.find({ _id: { $in: mongoIds } })
            .select('title abstract authors publication_year document_type field_associated citation_count link')
            .lean();

        const docMap = new Map(docs.map(d => [d._id.toString(), d]));
        return mongoIds.map(id => docMap.get(id)).filter(Boolean);
    }

    /**
     * Build the numbered context block injected into the LLM prompt.
     * Abstracts are truncated to keep the prompt within budget.
     */
    buildContext(sources, maxAbstractChars = 1200) {
        return sources.map(s => {
            const authors = s.authors.length ? s.authors.join(', ') : 'Unknown authors';
            const abstract = s.abstract.length > maxAbstractChars
                ? `${s.abstract.slice(0, maxAbstractChars)}...`
                : s.abstract;
            return [
                `[${s.index}] "${s.title}"`,
                `Authors: ${authors}`,
                `Year: ${s.publication_year ?? 'N/A'} | Type: ${s.document_type ?? 'N/A'} | Citations: ${s.citation_count}`,
                s.field_associated ? `Department/Field: ${s.field_associated}` : null,
                `Abstract: ${abstract}`
            ].filter(Boolean).join('\n');
        }).join('\n\n');
    }
}
