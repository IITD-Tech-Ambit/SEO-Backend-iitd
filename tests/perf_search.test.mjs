import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Performance assertions for search and rerank endpoints.
 *
 * Measures p95 latency over N iterations and fails if it exceeds the budget.
 * Run: node --test tests/perf_search.test.mjs
 */

const API_BASE = process.env.SEARCH_API_URL || `http://localhost:${process.env.PORT || 3000}/api/v1`;
const ROOT_BASE = API_BASE.replace(/\/api\/v1$/, '');
const EMBED_URL = process.env.EMBEDDING_SERVICE_URL || 'http://localhost:8000';
const ITERATIONS = parseInt(process.env.PERF_ITERATIONS || '10');

// Latency budgets (ms). Adjust based on hardware.
const BUDGETS = {
    search_cached: 100,        // cached search response
    search_uncached: 5000,     // cold search (embedding + OS + rerank)
    rerank_50: 2000,           // /rerank with 50 candidates
};

async function post(base, path, body) {
    const start = performance.now();
    const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
    });
    const elapsed = performance.now() - start;
    return { status: res.status, elapsed };
}

function p95(times) {
    const sorted = [...times].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[Math.max(0, idx)];
}

function formatMs(ms) {
    return `${ms.toFixed(1)}ms`;
}

describe('Performance: /search latency', () => {
    before(async () => {
        const res = await fetch(`${ROOT_BASE}/health`, { signal: AbortSignal.timeout(3000) });
        assert.equal(res.status, 200, 'API should be healthy');
    });

    it(`p95 uncached search < ${BUDGETS.search_uncached}ms (${ITERATIONS} iterations)`, async () => {
        const times = [];
        for (let i = 0; i < ITERATIONS; i++) {
            // Use a unique query each time to avoid cache hits
            const query = `performance test query ${Date.now()} ${i}`;
            const { status, elapsed } = await post(API_BASE, '/search', {
                query,
                mode: 'advanced',
                sort: 'relevance',
                per_page: 20,
            });
            if (status === 200) times.push(elapsed);
        }

        assert.ok(times.length >= Math.floor(ITERATIONS * 0.8),
            `At least 80% of requests should succeed (got ${times.length}/${ITERATIONS})`);

        const p95Val = p95(times);
        const sorted = [...times].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        console.log(`    /search uncached: p95=${formatMs(p95Val)}, median=${formatMs(median)}, min=${formatMs(Math.min(...times))}`);

        assert.ok(p95Val < BUDGETS.search_uncached,
            `p95 ${formatMs(p95Val)} exceeds budget ${formatMs(BUDGETS.search_uncached)}`);
    });

    it(`p95 cached search < ${BUDGETS.search_cached}ms`, async () => {
        const query = 'deep learning';
        // Warm the cache
        await post(API_BASE, '/search', { query, mode: 'advanced', per_page: 10 });

        const times = [];
        for (let i = 0; i < ITERATIONS; i++) {
            const { status, elapsed } = await post(API_BASE, '/search', {
                query,
                mode: 'advanced',
                per_page: 10,
            });
            if (status === 200) times.push(elapsed);
        }

        assert.ok(times.length > 0,
            `No successful cached requests (all returned non-200)`);

        const p95Val = p95(times);
        console.log(`    /search cached: p95=${formatMs(p95Val)}, min=${formatMs(Math.min(...times))}`);

        assert.ok(p95Val < BUDGETS.search_cached,
            `p95 ${formatMs(p95Val)} exceeds budget ${formatMs(BUDGETS.search_cached)}`);
    });
});

describe('Performance: /rerank latency', () => {
    it(`p95 rerank (50 candidates) < ${BUDGETS.rerank_50}ms`, async () => {
        // Generate 50 dummy documents
        const documents = Array.from({ length: 50 }, (_, i) =>
            `Research paper about topic ${i}. This paper presents a novel approach to solving problems in area ${i % 10}.`
        );

        const times = [];
        for (let i = 0; i < Math.min(ITERATIONS, 5); i++) {
            try {
                const { status, elapsed } = await post(EMBED_URL, '/rerank', {
                    query: 'novel machine learning approach',
                    documents,
                });
                if (status === 200) times.push(elapsed);
                else if (status === 404) {
                    console.log('    /rerank disabled — skipping performance test');
                    return;
                }
            } catch {
                console.log('    Embedding service not reachable — skipping');
                return;
            }
        }

        if (times.length === 0) {
            console.log('    No successful rerank calls — skipping');
            return;
        }

        const p95Val = p95(times);
        console.log(`    /rerank (50 docs): p95=${formatMs(p95Val)}, min=${formatMs(Math.min(...times))}`);

        assert.ok(p95Val < BUDGETS.rerank_50,
            `p95 ${formatMs(p95Val)} exceeds budget ${formatMs(BUDGETS.rerank_50)}`);
    });
});
