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
        timeout: 10000
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

    // Chat / RAG (Groq LLM)
    chat: {
        groqApiKey: process.env.GROQ_API_KEY || '',
        groqBaseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
        groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        // Cheap/fast model used to condense follow-up questions into standalone queries
        condenseModel: process.env.GROQ_CONDENSE_MODEL || 'llama-3.1-8b-instant',
        topK: parseInt(process.env.CHAT_TOP_K || '8'),
        maxHistoryTurns: parseInt(process.env.CHAT_MAX_HISTORY_TURNS || '6'),
        maxMessageLength: 2000,
        llmTimeoutMs: parseInt(process.env.CHAT_LLM_TIMEOUT_MS || '60000'),
        maxAnswerTokens: parseInt(process.env.CHAT_MAX_ANSWER_TOKENS || '1024'),
        rateLimit: {
            windowSec: parseInt(process.env.CHAT_RATE_WINDOW_SEC || '60'),
            maxRequests: parseInt(process.env.CHAT_RATE_MAX_REQUESTS || '20')
        }
    },

    // Search defaults
    search: {
        defaultPageSize: 20,
        maxPageSize: 100,
        hybridWeights: {
            bm25: 0.4,
            vector: 0.6
        }
    }
};
