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
        indexName: process.env.OPENSEARCH_INDEX || 'research_documents'
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
