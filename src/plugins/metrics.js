import http from 'node:http';
import fp from 'fastify-plugin';
import client from 'prom-client';

/**
 * Prometheus metrics plugin (search-api).
 *
 * Exposes RED metrics (Rate / Errors / Duration) for every HTTP route plus a
 * few search-domain counters, and serves them on a DEDICATED internal port
 * (never on the public app port).
 *
 * PM2 cluster note: prom-client's AggregatorRegistry must run in the cluster
 * primary, which PM2 owns — so cross-worker aggregation is not possible here.
 * Instead each worker exposes its own metrics endpoint on
 *   METRICS_PORT_BASE + NODE_APP_INSTANCE
 * and Prometheus scrapes every worker (see monitoring/prometheus/prometheus.yml).
 * Aggregation across workers is done at query time with `sum by (job)`.
 */

const SERVICE_NAME = process.env.SERVICE_NAME || 'search-api';
const METRICS_PORT_BASE = parseInt(process.env.METRICS_PORT_BASE || '9101', 10);
const METRICS_HOST = process.env.METRICS_HOST || '0.0.0.0';

function resolveMetricsPort() {
    // PM2 sets NODE_APP_INSTANCE to the 0-based worker index in cluster mode.
    const instance = parseInt(process.env.NODE_APP_INSTANCE || '0', 10);
    return METRICS_PORT_BASE + (Number.isNaN(instance) ? 0 : instance);
}

async function metricsPlugin(fastify) {
    const register = new client.Registry();
    register.setDefaultLabels({ service: SERVICE_NAME });
    client.collectDefaultMetrics({ register });

    const httpHistogram = new client.Histogram({
        name: 'http_request_duration_seconds',
        help: 'HTTP request duration in seconds',
        labelNames: ['method', 'route', 'status_code'],
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        registers: [register]
    });

    // --- Search domain metrics ---
    const searchRequests = new client.Counter({
        name: 'search_requests_total',
        help: 'Total search requests handled, by type',
        labelNames: ['type'],
        registers: [register]
    });
    const searchCacheHits = new client.Counter({
        name: 'search_cache_hits_total',
        help: 'Total search requests served from the Redis result cache',
        registers: [register]
    });
    const searchStage = new client.Histogram({
        name: 'search_stage_seconds',
        help: 'Duration of search pipeline stages in seconds',
        labelNames: ['stage'],
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
        registers: [register]
    });

    fastify.decorate('metrics', {
        register,
        searchRequests,
        searchCacheHits,
        searchStage
    });

    // Per-request timing. routeOptions.url keeps cardinality bounded (matched
    // pattern, not the concrete path).
    fastify.addHook('onRequest', async (request) => {
        request.metricsStart = process.hrtime.bigint();
    });

    fastify.addHook('onResponse', async (request, reply) => {
        if (!request.metricsStart) return;
        const seconds = Number(process.hrtime.bigint() - request.metricsStart) / 1e9;
        const route = request.routeOptions?.url || reply.request?.routerPath || request.url || 'unknown';
        httpHistogram
            .labels(request.method, route, String(reply.statusCode))
            .observe(seconds);
    });

    // Dedicated internal metrics server (kept off the public app port).
    const metricsServer = http.createServer(async (req, res) => {
        if (req.url === '/metrics') {
            try {
                const body = await register.metrics();
                res.writeHead(200, { 'Content-Type': register.contentType });
                res.end(body);
            } catch (err) {
                res.writeHead(500);
                res.end(String(err));
            }
            return;
        }
        if (req.url === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
            return;
        }
        res.writeHead(404);
        res.end();
    });

    const port = resolveMetricsPort();
    metricsServer.listen(port, METRICS_HOST, () => {
        fastify.log.info(`Metrics exposed on http://${METRICS_HOST}:${port}/metrics`);
    });
    metricsServer.on('error', (err) => {
        fastify.log.error({ err }, 'Metrics server error');
    });

    fastify.addHook('onClose', async () => {
        await new Promise((resolve) => metricsServer.close(resolve));
    });
}

export default fp(metricsPlugin, { name: 'metrics' });
