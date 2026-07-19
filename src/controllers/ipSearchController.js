export async function search(request, reply, ipSearchService) {
    const startTime = Date.now();
    const { query, filters, sort, page, per_page, search_in, mode, refine_within, refine_chain, rerank } = request.body;

    try {
        const result = await ipSearchService.search({
            query,
            filters,
            sort,
            page,
            per_page,
            search_in,
            mode,
            refine_within,
            refine_chain,
            rerank
        });

        const tookMs = Date.now() - startTime;

        const metrics = request.server.metrics;
        if (metrics) {
            metrics.searchRequests?.labels('ip_search').inc();
            if (result.cacheHit) metrics.searchCacheHits?.inc();
            metrics.searchStage?.labels('total').observe(tookMs / 1000);
        }

        return {
            ...result,
            meta: {
                took_ms: tookMs,
                cache_hit: result.cacheHit
            }
        };

    } catch (error) {
        request.log.error({ error, query }, 'IP search failed');

        if (error.message?.includes('Embedding service')) {
            return reply.status(503).send({
                error: 'Service Unavailable',
                message: 'Embedding service is not responding',
                statusCode: 503
            });
        }

        if (error.meta?.statusCode) {
            return reply.status(502).send({
                error: 'Bad Gateway',
                message: 'Search engine error',
                statusCode: 502
            });
        }

        return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'IP search failed unexpectedly',
            statusCode: 500
        });
    }
}

export async function getIpDocument(request, reply) {
    const { id } = request.params;
    try {
        const IPMetaData = request.server.mongoose.model('IPMetaData');
        const document = await IPMetaData.findById(id).lean();
        if (!document) {
            return reply.status(404).send({
                error: 'Not Found',
                message: 'IP document not found',
                statusCode: 404
            });
        }
        return { document };
    } catch (error) {
        request.log.error({ error, id }, 'Fetch IP document failed');
        return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Failed to fetch IP document',
            statusCode: 500
        });
    }
}

export async function searchHealth(request, reply) {
    const fastify = request.server;

    const checks = {
        opensearch: false,
        embedding: false,
        redis: false
    };

    try {
        const osHealth = await fastify.opensearch.cluster.health();
        checks.opensearch = ['green', 'yellow'].includes(osHealth.body.status);
    } catch {
        checks.opensearch = false;
    }

    try {
        checks.embedding = await fastify.embeddingService.health();
    } catch {
        checks.embedding = false;
    }

    try {
        await fastify.redis.ping();
        checks.redis = true;
    } catch {
        checks.redis = false;
    }

    const healthy = Object.values(checks).every((v) => v);

    return reply
        .status(healthy ? 200 : 503)
        .send({
            status: healthy ? 'healthy' : 'degraded',
            checks,
            timestamp: new Date().toISOString()
        });
}
