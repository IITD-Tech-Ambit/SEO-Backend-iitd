import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import 'dotenv/config';

import config from './config/index.js';
import metricsPlugin from './plugins/metrics.js';
import mongodbPlugin from './plugins/mongodb.js';
import opensearchPlugin from './plugins/opensearch.js';
import redisPlugin from './plugins/redis.js';
import EmbeddingService from './services/embeddingService.js';
import SearchService from './services/searchService.js';
import SuggestService from './services/suggestService.js';
import TaxonomyService from './services/taxonomy/TaxonomyService.js';
import searchRoutes from './routes/search.js';
import documentRoutes from './routes/documents.js';
import taxonomyRoutes from './routes/taxonomy.js';

// Import MongoDB models
import './models/index.js';

const fastify = Fastify({
    logger: {
        level: process.env.LOG_LEVEL || 'info',
        transport: process.env.NODE_ENV !== 'production' ? {
            target: 'pino-pretty',
            options: { colorize: true }
        } : undefined
    },
    requestTimeout: config.timeouts.total,
    bodyLimit: 1048576 // 1MB
});

// Global error handler
fastify.setErrorHandler((error, request, reply) => {
    // Validation errors
    if (error.validation) {
        return reply.status(400).send({
            error: 'Validation Error',
            message: error.message,
            details: error.validation,
            statusCode: 400
        });
    }

    // Timeout errors
    if (error.code === 'FST_ERR_TIMEOUT') {
        return reply.status(504).send({
            error: 'Gateway Timeout',
            message: 'Request took too long',
            statusCode: 504
        });
    }

    // Log and return generic 500 for unexpected errors
    request.log.error(error);
    return reply.status(500).send({
        error: 'Internal Server Error',
        message: error.message,
        statusCode: 500
    });
});

// Register plugins
async function registerPlugins() {
    // CORS
    await fastify.register(cors, {
        origin: true,
        methods: ['GET', 'POST', 'OPTIONS']
    });

    // Sensible (adds httpErrors, etc.)
    await fastify.register(sensible);

    // Prometheus metrics (RED + domain) on a dedicated internal port
    await fastify.register(metricsPlugin);

    // MongoDB
    await fastify.register(mongodbPlugin, config.mongodb);

    // OpenSearch
    await fastify.register(opensearchPlugin, config.opensearch);

    // Redis
    await fastify.register(redisPlugin, config.redis);
}

// Initialize services
async function initializeServices() {
    // Embedding service client
    const embeddingService = new EmbeddingService(
        config.embeddingService,
        fastify.redis,
        fastify.redisTTL,
        fastify.log
    );
    fastify.decorate('embeddingService', embeddingService);

    // Search service
    const searchService = new SearchService(fastify, config);
    fastify.decorate('searchService', searchService);

    // Suggest service (blended typeahead). Kick off the faculty token-set loader
    // used as an intent signal (refreshes periodically inside the service).
    const suggestService = new SuggestService(fastify, config);
    suggestService.init();
    fastify.decorate('suggestService', suggestService);

    // Taxonomy browse service (Explore section) — loads the node/department
    // catalog into memory before routes come up.
    const taxonomyService = new TaxonomyService(fastify, config);
    await taxonomyService.init();
    fastify.decorate('taxonomyService', taxonomyService);
    fastify.addHook('onClose', async () => taxonomyService.close());
}

// Register routes
async function registerRoutes() {
    // API prefix
    await fastify.register(async (instance) => {
        await instance.register(searchRoutes, {
            searchService: fastify.searchService,
            config
        });
        await instance.register(documentRoutes, {
            searchService: fastify.searchService
        });
        await instance.register(taxonomyRoutes);
    }, { prefix: '/api/v1' });

    // Root health check
    fastify.get('/health', async () => ({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    }));
}

// Start server
async function start() {
    try {
        await registerPlugins();
        await initializeServices();
        await registerRoutes();

        await fastify.listen({
            port: config.port,
            host: config.host
        });

        fastify.log.info(`Search API running on http://${config.host}:${config.port}`);

    } catch (error) {
        fastify.log.error(error);
        process.exit(1);
    }
}

// Graceful shutdown
const signals = ['SIGINT', 'SIGTERM'];
signals.forEach(signal => {
    process.on(signal, async () => {
        fastify.log.info(`Received ${signal}, shutting down...`);
        await fastify.close();
        process.exit(0);
    });
});

start();
