/**
 * Search Controller
 * Handles search-related HTTP requests
 */

/**
 * Search documents with hybrid BM25 + semantic search
 */
export async function search(request, reply) {
    const startTime = Date.now();
    const { query, filters, sort, page, per_page, search_in } = request.body;
    const searchService = request.server.searchService;

    try {
        const result = await searchService.search({
            query,
            filters,
            sort,
            page,
            per_page,
            search_in
        });

        const tookMs = Date.now() - startTime;

        return {
            ...result,
            meta: {
                took_ms: tookMs,
                cache_hit: result.cacheHit
            }
        };

    } catch (error) {
        request.log.error({ error, query }, 'Search failed');

        if (error.message.includes('Embedding service')) {
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
            message: 'Search failed unexpectedly',
            statusCode: 500
        });
    }
}

/**
 * Health check for search infrastructure
 */
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

    const healthy = Object.values(checks).every(v => v);

    return reply
        .status(healthy ? 200 : 503)
        .send({
            status: healthy ? 'healthy' : 'degraded',
            checks,
            timestamp: new Date().toISOString()
        });
}
