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

export async function getIpDocument(request, reply, ipSearchService) {
    const { id } = request.params;
    try {
        const document = await ipSearchService.getDocument(id);
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

export async function getAllFacultyForQuery(request, reply, ipSearchService) {
    const startTime = Date.now();
    const { query, mode, search_in: searchInRaw, refine_chain: refineChainRaw, filters: filtersRaw } = request.query;

    const parsedSearchIn =
        typeof searchInRaw === 'string' && searchInRaw.trim()
            ? searchInRaw.split(',').map((s) => s.trim()).filter(Boolean)
            : undefined;

    let parsedFilters = null;
    if (typeof filtersRaw === 'string' && filtersRaw.trim()) {
        try {
            parsedFilters = JSON.parse(filtersRaw);
        } catch (err) {
            request.log.warn({ err: err?.message, filtersRaw }, 'IP faculty-for-query: ignoring malformed filters param');
        }
    }

    let parsedRefineChain = null;
    if (typeof refineChainRaw === 'string' && refineChainRaw.trim()) {
        try {
            parsedRefineChain = JSON.parse(refineChainRaw);
        } catch (err) {
            request.log.warn({ err: err?.message, refineChainRaw }, 'IP faculty-for-query: ignoring malformed refine_chain param');
        }
    }

    try {
        const result = await ipSearchService.getAllFacultyForQuery(query, mode, parsedSearchIn, parsedFilters, parsedRefineChain);

        const tookMs = Date.now() - startTime;

        return {
            ...result,
            meta: {
                took_ms: tookMs,
                cache_hit: result.cacheHit
            }
        };
    } catch (error) {
        request.log.error({ error, query }, 'IP faculty-for-query failed');
        return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'IP faculty-for-query failed unexpectedly',
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
