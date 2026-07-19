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
import HttpEmbeddingTransport from './services/embedding/HttpEmbeddingTransport.js';
import GrpcEmbeddingTransport from './services/embedding/GrpcEmbeddingTransport.js';
import { startGrpcServer } from './grpc/server.js';
import SearchService from './services/searchService.js';
import IpSearchService from './services/ipSearchService.js';
import DocumentService from './services/documentService.js';
import SuggestService from './services/suggestService.js';
import IpSuggestService from './services/ipSuggestService.js';
import TaxonomyService from './services/taxonomy/TaxonomyService.js';
import searchRoutes from './routes/search.js';
import ipSearchRoutes from './routes/ipSearch.js';
import documentRoutes from './routes/documents.js';
import taxonomyRoutes from './routes/taxonomy.js';

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

fastify.setErrorHandler((error, request, reply) => {
    if (error.validation) {
        return reply.status(400).send({
            error: 'Validation Error',
            message: error.message,
            details: error.validation,
            statusCode: 400
        });
    }

    if (error.code === 'FST_ERR_TIMEOUT') {
        return reply.status(504).send({
            error: 'Gateway Timeout',
            message: 'Request took too long',
            statusCode: 504
        });
    }

    request.log.error(error);
    return reply.status(500).send({
        error: 'Internal Server Error',
        message: error.message,
        statusCode: 500
    });
});

async function registerPlugins() {
    await fastify.register(cors, {
        origin: true,
        methods: ['GET', 'POST', 'OPTIONS']
    });

    await fastify.register(sensible);

    // Prometheus metrics (RED + domain) on a dedicated internal port
    await fastify.register(metricsPlugin);

    await fastify.register(mongodbPlugin, config.mongodb);
    await fastify.register(opensearchPlugin, config.opensearch);
    await fastify.register(redisPlugin, config.redis);
}

function infraDeps() {
    return {
        opensearch: fastify.opensearch,
        opensearchIndex: fastify.opensearchIndex,
        redis: fastify.redis,
        redisTTL: fastify.redisTTL,
        mongoose: fastify.mongoose,
        logger: fastify.log,
        config
    };
}

async function initializeServices() {
    // Embedding service client — transport selected by config (gRPC via
    // Envoy in production, HTTP for local dev). Composition happens here so
    // EmbeddingService itself stays protocol-agnostic.
    const embeddingTransport = config.embeddingService.transport === 'grpc'
        ? new GrpcEmbeddingTransport(config.embeddingService)
        : new HttpEmbeddingTransport(config.embeddingService);
    const embeddingService = new EmbeddingService(
        config.embeddingService,
        fastify.redis,
        fastify.redisTTL,
        fastify.log,
        embeddingTransport
    );
    fastify.decorate('embeddingService', embeddingService);
    fastify.addHook('onClose', async () => embeddingTransport.close?.());

    const deps = infraDeps();

    const searchService = new SearchService({ ...deps, embeddingService });
    fastify.decorate('searchService', searchService);

    const ipSearchService = new IpSearchService({
        ...deps,
        opensearchIndex: config.opensearch.ipIndexName,
        embeddingService
    });
    fastify.decorate('ipSearchService', ipSearchService);

    const documentService = new DocumentService(deps);
    fastify.decorate('documentService', documentService);

    const suggestService = new SuggestService(deps);
    suggestService.init();
    fastify.decorate('suggestService', suggestService);

    // IP typeahead uses nested inventors on `ip_documents` (no separate suggest index).
    const ipSuggestService = new IpSuggestService({
        ...deps,
        opensearchIndex: config.opensearch.ipIndexName
    });
    ipSuggestService.init();
    fastify.decorate('ipSuggestService', ipSuggestService);

    const taxonomyService = new TaxonomyService(deps);
    await taxonomyService.init();
    fastify.decorate('taxonomyService', taxonomyService);
    fastify.addHook('onClose', async () => taxonomyService.close());
}

async function registerRoutes() {
    await fastify.register(async (instance) => {
        await instance.register(searchRoutes, {
            searchService: fastify.searchService,
            suggestService: fastify.suggestService,
            config
        });
        await instance.register(ipSearchRoutes, {
            ipSearchService: fastify.ipSearchService,
            ipSuggestService: fastify.ipSuggestService,
            config
        });
        await instance.register(documentRoutes, {
            documentService: fastify.documentService
        });
        await instance.register(taxonomyRoutes, {
            taxonomyService: fastify.taxonomyService
        });
    }, { prefix: '/api/v1' });

    fastify.get('/health', async () => ({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    }));
}

async function start() {
    try {
        await registerPlugins();
        await initializeServices();
        await registerRoutes();

        // East-west gRPC listener (search.v1 SearchService + TaxonomyService),
        // served through Envoy for the gateway/chatbot. REST stays for the
        // browser-facing edge. Same service instances back both planes.
        if (config.grpc.enabled) {
            const grpcServer = await startGrpcServer({
                searchService: fastify.searchService,
                documentService: fastify.documentService,
                suggestService: fastify.suggestService,
                ipSearchService: fastify.ipSearchService,
                ipSuggestService: fastify.ipSuggestService,
                taxonomyService: fastify.taxonomyService,
                logger: fastify.log,
                bindAddress: config.grpc.bindAddress
            });
            if (grpcServer) {
                fastify.addHook('onClose', async () => {
                    await new Promise((resolve) => grpcServer.tryShutdown(resolve));
                });
            }
        }

        await fastify.listen({
            port: config.port,
            host: config.host
        });

        fastify.log.info(`Search API running on http://${config.host}:${config.port}`);

        // Signals PM2 (wait_ready: true in ecosystem.config.cjs) that this
        // worker has finished booting - without it PM2 waits out the full
        // listen_timeout on every deploy/reload and treats it as a failed start.
        if (process.send) {
            process.send('ready');
        }

    } catch (error) {
        fastify.log.error(error);
        process.exit(1);
    }
}

const signals = ['SIGINT', 'SIGTERM'];
signals.forEach(signal => {
    process.on(signal, async () => {
        fastify.log.info(`Received ${signal}, shutting down...`);
        await fastify.close();
        process.exit(0);
    });
});

start();
