// Environment Configuration
export default {
    // Server
    port: parseInt(process.env.PORT || '3001'),
    host: process.env.HOST || '0.0.0.0',

    // MongoDB
    mongodb: {
        uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/research_db',
        options: {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000
        }
    },

    // OpenSearch
    opensearch: {
        node: process.env.OPENSEARCH_NODE || 'http://localhost:9200',
        auth: process.env.OPENSEARCH_USER ? {
            username: process.env.OPENSEARCH_USER,
            password: process.env.OPENSEARCH_PASSWORD || ''
        } : undefined,
        ssl: {
            rejectUnauthorized: false
        },
        indexName: process.env.OPENSEARCH_INDEX || 'research_documents',
        authorsSuggestIndex: process.env.OPENSEARCH_AUTHORS_INDEX || 'authors_suggest'
    },

    // Redis
    redis: {
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        ttl: {
            searchResults: 300,
            queryEmbedding: 86400
        }
    },

    // Embedding Service
    embeddingService: {
        url: process.env.EMBEDDING_SERVICE_URL || 'http://localhost:8000',
        timeout: 10000,
        rerankTimeout: parseInt(process.env.RERANK_TIMEOUT_MS || '800')
    },

    // Timeouts
    timeouts: {
        embedding: 10000,    // 10s for embedding generation
        opensearch: 10000,  // 10s for search query
        mongodb: 5000,      // 5s for document hydration
        total: 15000        // 15s total request timeout
    },

    // Typeahead / suggest (blended autocomplete)
    suggest: {
        minPrefix: 2,           // queries shorter than this return empty groups
        defaultLimit: 8,
        maxLimit: 15,
        authorsSize: 6,         // OpenSearch size for the authors_suggest query
        papersSize: 6,          // OpenSearch size for the research_documents query
        // Per-source budget; a slow source yields partial groups. The p95<50ms target in
        // the design assumes OpenSearch co-located with the API. Here OpenSearch is remote
        // (network RTT alone is ~100ms+), so this is set higher; lower it when co-located.
        perSourceTimeoutMs: parseInt(process.env.SUGGEST_SOURCE_TIMEOUT_MS || '1200'),
        lruMax: 2000,           // hot-prefix in-process cache entries
        lruTtlMs: 60000,        // in-process cache TTL
        redisTtl: 60,           // Redis cache TTL (seconds)
        tokenRefreshMs: 600000, // faculty token-set refresh interval (~10 min)
        // Intent engine weights (tunable; no ML). Higher => stronger pull to that intent.
        // Retrieval confidence is weighted highest because it is grounded in actual matches
        // (and the paper score includes abstract), so a strong topic beats a surname collision.
        intentWeights: {
            nameTokenMatch: 0.30,   // query token(s) present in faculty token set (prefix-aware)
            nameShape: 0.12,        // 1-3 tokens / initials pattern => author-ish
            retrievalConfidence: 0.60, // normalized top-author vs top-paper score
            topicSignal: 0.35,      // stopwords / length / trailing connectors => paper
        }
    },

    // Taxonomy browse (Explore section)
    taxonomy: {
        // Rollup-backed reads change only when the offline rollup job runs,
        // so they cache long; papers-in-context is a live query, cached short.
        redisTtl: parseInt(process.env.TAXONOMY_CACHE_TTL || '3600'),
        papersRedisTtl: parseInt(process.env.TAXONOMY_PAPERS_CACHE_TTL || '300'),
        catalogRefreshMs: parseInt(process.env.TAXONOMY_CATALOG_REFRESH_MS || '600000'),
        defaultPerPage: 20,
        maxPerPage: 100
    },

    // Search defaults
    search: {
        // User-facing relevance threshold (normalized hybrid score) that defines a
        // "matching paper". Set via env so it can be tuned against the eval harness.
        // 0.12 (the old recall floor) counted the entire kNN recall pool (~corpus-sized);
        // ~1.20 keeps only documents with real BM25 and/or strong semantic similarity.
        relevantMinScore: parseFloat(process.env.RELEVANT_MIN_SCORE || '1.20'),
        defaultPageSize: 20,
        maxPageSize: 100,
        hybridWeights: {
            bm25: 0.4,
            vector: 0.6
        },
        candidateK: parseInt(process.env.CANDIDATE_K || '50'),
        rerankEnabled: (process.env.RERANK_ENABLED || 'true').toLowerCase() === 'true',
        // OpenSearch's index.max_result_window bound on `from + size`. Deep pagination
        // (pages beyond the reranked window) uses from/size, so a requested page whose
        // window would exceed this cannot be served and total_pages is clamped accordingly.
        // Keep this in sync with the index setting if you raise it for deeper navigation.
        maxResultWindow: parseInt(process.env.MAX_RESULT_WINDOW || '10000')
    },

    // Reranker
    reranker: {
        timeout: parseInt(process.env.RERANK_TIMEOUT_MS || '800'),
        modelVersion: process.env.RERANK_MODEL_VERSION || 'bge-reranker-base-v1',
        scoreCacheTTL: parseInt(process.env.RERANK_CACHE_TTL || '3600'),
        // Score fusion: final = alpha * norm(rerank) + (1 - alpha) * norm(firstStage).
        // Bumping alpha trusts the cross-encoder more; lowering it preserves lexical ranking.
        fusionAlpha: parseFloat(process.env.RERANK_FUSION_ALPHA || '0.7'),
        literalTitleBonus: parseFloat(process.env.RERANK_LITERAL_TITLE_BONUS || '0.3')
    }
};
