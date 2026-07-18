export async function search(request, reply, searchService) {
    const startTime = Date.now();
    const { query, filters, sort, page, per_page, search_in, mode, refine_within, refine_chain, rerank } = request.body;

    try {
        const result = await searchService.search({
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
            metrics.searchRequests.labels('search').inc();
            if (result.cacheHit) metrics.searchCacheHits.inc();
            metrics.searchStage.labels('total').observe(tookMs / 1000);
        }

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

export async function authorScopedSearch(request, reply, searchService) {
    const startTime = Date.now();
    const { query, author_id, page, per_page, mode, refine_within, refine_chain, search_in, filters } = request.body;

    try {
        const result = await searchService.authorScopedSearch({
            query,
            author_id,
            page,
            per_page,
            mode,
            refine_within,
            refine_chain,
            search_in,
            filters
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
        request.log.error({ error, query, author_id }, 'Author-scoped search failed');

        if (error.message.includes('Embedding service')) {
            return reply.status(503).send({
                error: 'Service Unavailable',
                message: 'Embedding service is not responding',
                statusCode: 503
            });
        }

        return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Author-scoped search failed unexpectedly',
            statusCode: 500
        });
    }
}

export async function getAllFacultyForQuery(request, reply, searchService) {
    const startTime = Date.now();
    const { query, mode, search_in: searchInRaw, refine_within, refine_chain: refineChainRaw, filters: filtersRaw } = request.query;

    const parsedSearchIn =
        typeof searchInRaw === 'string' && searchInRaw.trim()
            ? searchInRaw.split(',').map((s) => s.trim()).filter(Boolean)
            : undefined;

    // Filters arrive as a JSON-encoded object so the People sidebar applies the IDENTICAL
    // facet filters as POST /search and the two paper totals stay consistent.
    let parsedFilters = null;
    if (typeof filtersRaw === 'string' && filtersRaw.trim()) {
        try {
            parsedFilters = JSON.parse(filtersRaw);
        } catch (err) {
            request.log.warn({ err: err?.message, filtersRaw }, 'Faculty-for-query: ignoring malformed filters param');
        }
    }

    // refine_chain arrives JSON-encoded (same pattern as filters) so the People sidebar narrows
    // through the IDENTICAL chain as POST /search.
    let parsedRefineChain = null;
    if (typeof refineChainRaw === 'string' && refineChainRaw.trim()) {
        try {
            parsedRefineChain = JSON.parse(refineChainRaw);
        } catch (err) {
            request.log.warn({ err: err?.message, refineChainRaw }, 'Faculty-for-query: ignoring malformed refine_chain param');
        }
    }

    try {
        const result = await searchService.getAllFacultyForQuery(query, mode, parsedSearchIn, refine_within, parsedFilters, parsedRefineChain);

        const tookMs = Date.now() - startTime;

        return {
            ...result,
            meta: {
                took_ms: tookMs,
                cache_hit: result.cacheHit
            }
        };

    } catch (error) {
        request.log.error({ error, query }, 'Faculty-for-query failed');

        return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Faculty lookup failed unexpectedly',
            statusCode: 500
        });
    }
}
