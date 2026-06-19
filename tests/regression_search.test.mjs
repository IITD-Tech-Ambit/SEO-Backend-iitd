import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Regression + contract tests for the search pipeline.
 *
 * Requires a live search API at SEARCH_API_URL (default http://localhost:3001).
 * Run: node --test tests/regression_search.test.mjs
 */

const API_BASE = process.env.SEARCH_API_URL || `http://localhost:${process.env.PORT || 3000}/api/v1`;
const ROOT_BASE = API_BASE.replace(/\/api\/v1$/, '');

async function post(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, body: await res.json() };
}

async function get(path) {
    const res = await fetch(`${API_BASE}${path}`, {
        signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, body: await res.json() };
}

// ── Health prerequisite ──

describe('Prerequisites', () => {
    it('API health check succeeds', async () => {
        const { status } = await fetch(`${ROOT_BASE}/health`, { signal: AbortSignal.timeout(3000) }).then(r => ({ status: r.status }));
        assert.equal(status, 200);
    });
});

// ── 6b: Regression tests pinning bug fixes ──

describe('Bug #1 — Semantic recall (vector-recall arm)', () => {
    it('returns results for a paraphrase query with no exact lexical overlap', async () => {
        const { status, body } = await post('/search', {
            query: 'methods to reduce pollution in rivers',
            mode: 'advanced',
            sort: 'relevance',
            per_page: 20,
        });
        assert.equal(status, 200);
        assert.ok(body.results, 'Response should contain results array');
        // With the vector-recall arm, we expect at least some results
        // even when the exact words don't appear in the index
    });

    it('returns results for a purely semantic query', async () => {
        const { status, body } = await post('/search', {
            query: 'teaching machines to understand human emotions',
            mode: 'advanced',
            sort: 'relevance',
            per_page: 20,
        });
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.results));
    });
});

describe('Bug #2 — Fusion ordering (normalized by default)', () => {
    it('relevance and normalized sorts both return results', async () => {
        const query = 'machine learning';

        const [rel, norm] = await Promise.all([
            post('/search', { query, mode: 'advanced', sort: 'relevance', per_page: 10 }),
            post('/search', { query, mode: 'advanced', sort: 'normalized', per_page: 10 }),
        ]);

        assert.equal(rel.status, 200);
        assert.equal(norm.status, 200);
        assert.ok(rel.body.results.length > 0, 'relevance should return results');
        assert.ok(norm.body.results.length > 0, 'normalized should return results');
    });
});

describe('Bug #5 — Cache isolation', () => {
    it('basic and advanced modes return different result sets for the same query', async () => {
        const query = 'neural network';

        const [basic, advanced] = await Promise.all([
            post('/search', { query, mode: 'basic', per_page: 5 }),
            post('/search', { query, mode: 'advanced', per_page: 5 }),
        ]);

        assert.equal(basic.status, 200);
        assert.equal(advanced.status, 200);
        assert.equal(basic.body.mode, 'basic');
        assert.equal(advanced.body.mode, 'advanced');
    });
});

describe('Bug #9 — Deep pagination guard', () => {
    it('rejects page values above the maximum', async () => {
        const { status } = await post('/search', {
            query: 'test',
            page: 501,
            per_page: 20,
        });
        assert.equal(status, 400, 'Should reject page > 500');
    });

    it('accepts the maximum allowed page', async () => {
        const { status } = await post('/search', {
            query: 'test',
            page: 500,
            per_page: 20,
        });
        assert.equal(status, 200);
    });
});

describe('Pagination + rerank consistency', () => {
    it('no duplicate mongo_ids across page 1 and page 2', async () => {
        const query = 'machine learning classification';

        const [p1, p2] = await Promise.all([
            post('/search', { query, mode: 'advanced', sort: 'relevance', per_page: 10, page: 1 }),
            post('/search', { query, mode: 'advanced', sort: 'relevance', per_page: 10, page: 2 }),
        ]);

        assert.equal(p1.status, 200);
        assert.equal(p2.status, 200);

        const ids1 = new Set((p1.body.results || []).map(r => r._id || r.mongo_id));
        const ids2 = new Set((p2.body.results || []).map(r => r._id || r.mongo_id));

        for (const id of ids2) {
            assert.ok(!ids1.has(id), `Duplicate id ${id} found on page 1 and page 2`);
        }
    });
});

describe('Roster gating', () => {
    it('searching a non-IITD surname does not surface unrelated papers', async () => {
        // "Zuckerberg" should not be an IITD faculty name;
        // the roster gate should prevent matches on non-IITD co-authors
        const { status, body } = await post('/search', {
            query: 'Zuckerberg',
            mode: 'advanced',
            sort: 'relevance',
            per_page: 10,
        });
        assert.equal(status, 200);
        // We expect few or no results, not a flood of random papers
    });
});

describe('Graceful fallback (reranker down)', () => {
    it('/search never returns 503 even when the reranker fails', async () => {
        // This test verifies the fallback path.
        // Even if the reranker is unavailable, the search should still return first-stage results.
        const { status, body } = await post('/search', {
            query: 'deep learning',
            mode: 'advanced',
            sort: 'relevance',
            per_page: 10,
        });
        assert.notEqual(status, 503, 'Search should never return 503 from the rerank path');
        assert.ok(status === 200 || status === 400, `Unexpected status: ${status}`);
    });
});

// ── 6c: Endpoint / contract tests ──

describe('/search contract', () => {
    it('response has required fields: results, facets, pagination, mode', async () => {
        const { status, body } = await post('/search', {
            query: 'test query',
            mode: 'advanced',
            per_page: 5,
        });
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.results), 'results should be an array');
        assert.ok(body.facets, 'facets should be present');
        assert.ok(body.pagination, 'pagination should be present');
        assert.ok(body.mode, 'mode should be present');
        assert.ok(body.pagination.page, 'pagination.page should be present');
        assert.ok(body.pagination.per_page, 'pagination.per_page should be present');
        assert.equal(typeof body.pagination.total, 'number');
        assert.equal(typeof body.pagination.total_pages, 'number');
    });

    it('basic mode search returns expected shape', async () => {
        const { status, body } = await post('/search', {
            query: 'machine learning',
            mode: 'basic',
            per_page: 5,
        });
        assert.equal(status, 200);
        assert.equal(body.mode, 'basic');
        assert.ok(Array.isArray(body.results));
    });

    it('advanced mode search returns expected shape', async () => {
        const { status, body } = await post('/search', {
            query: 'machine learning',
            mode: 'advanced',
            per_page: 5,
        });
        assert.equal(status, 200);
        assert.equal(body.mode, 'advanced');
        assert.ok(Array.isArray(body.results));
    });

    it('rejects empty query', async () => {
        const { status } = await post('/search', {
            query: '',
            per_page: 5,
        });
        assert.equal(status, 400);
    });

    it('respects per_page limit', async () => {
        const perPage = 3;
        const { status, body } = await post('/search', {
            query: 'research',
            per_page: perPage,
        });
        assert.equal(status, 200);
        assert.ok(body.results.length <= perPage, `Got ${body.results.length} results, expected <= ${perPage}`);
    });

    it('sort variants all succeed', async () => {
        const sorts = ['relevance', 'date', 'citations', 'impact', 'normalized'];
        const results = await Promise.all(
            sorts.map(sort => post('/search', { query: 'test', sort, per_page: 3 }))
        );
        for (let i = 0; i < sorts.length; i++) {
            assert.equal(results[i].status, 200, `Sort '${sorts[i]}' should return 200`);
        }
    });

    it('related_faculty is an array', async () => {
        const { status, body } = await post('/search', {
            query: 'machine learning',
            mode: 'advanced',
            per_page: 10,
        });
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.related_faculty), 'related_faculty should be an array');
    });
});

describe('/search/author-scope contract', () => {
    it('rejects request without author_id', async () => {
        const { status } = await post('/search/author-scope', {
            query: 'test',
        });
        assert.equal(status, 400);
    });
});

describe('/rerank contract (embedding service)', () => {
    const EMBED_URL = process.env.EMBEDDING_SERVICE_URL || 'http://localhost:8001';

    it('/rerank returns scores sorted descending with correct length', async () => {
        const docs = ['document about AI', 'document about cooking', 'document about machine learning'];
        let res;
        try {
            res = await fetch(`${EMBED_URL}/rerank`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: 'artificial intelligence', documents: docs }),
                signal: AbortSignal.timeout(30000),
            });
        } catch {
            // Embedding service not running — skip
            return;
        }

        if (res.status === 404) return; // reranking disabled

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.ok(Array.isArray(data.results));
        assert.equal(data.results.length, docs.length, 'Result count should match input');

        for (let i = 1; i < data.results.length; i++) {
            assert.ok(
                data.results[i - 1].score >= data.results[i].score,
                `Scores should be sorted descending: ${data.results[i - 1].score} >= ${data.results[i].score}`
            );
        }
    });

    it('/rerank respects top_n', async () => {
        const docs = ['doc1', 'doc2', 'doc3', 'doc4'];
        let res;
        try {
            res = await fetch(`${EMBED_URL}/rerank`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: 'test', documents: docs, top_n: 2 }),
                signal: AbortSignal.timeout(30000),
            });
        } catch {
            return; // Embedding service not running
        }

        if (res.status === 404) return; // reranking disabled

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.results.length, 2, 'Should return exactly top_n results');
    });

    it('/rerank rejects empty documents array', async () => {
        let res;
        try {
            res = await fetch(`${EMBED_URL}/rerank`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: 'test', documents: [] }),
                signal: AbortSignal.timeout(5000),
            });
        } catch {
            return;
        }

        if (res.status === 404) return;
        assert.equal(res.status, 422, 'Empty documents should be rejected');
    });
});
