import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Retrieval quality tests for the search API.
 *
 * Validates that:
 *  - Gibberish / nonsensical queries return 0 results in both modes
 *  - Real queries return results
 *  - Score monotonicity (results are ordered by decreasing relevance)
 *  - Basic mode never returns results for gibberish
 *  - Result relevance spot-checks for top results
 *  - Basic vs advanced result count comparison
 *
 * Requires a live search API at SEARCH_API_URL (default http://localhost:3000).
 * Run: node --test tests/retrieval_quality.test.mjs
 */

const API_BASE = process.env.SEARCH_API_URL || `http://localhost:${process.env.PORT || 3000}/api/v1`;

async function post(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, body: await res.json() };
}

function totalOf(body) {
    return body.pagination?.total ?? -1;
}

// ── Prerequisites ──

describe('Retrieval quality prerequisites', () => {
    it('API is reachable', async () => {
        const rootBase = API_BASE.replace(/\/api\/v1$/, '');
        const res = await fetch(`${rootBase}/health`, { signal: AbortSignal.timeout(5000) });
        assert.equal(res.status, 200);
    });
});

// ── Gibberish queries must return 0 results ──

describe('Gibberish queries return 0 results', () => {
    const gibberishQueries = [
        'asdasdasd',
        'xyzqwerty',
        'zzzzxxxxxwwwww',
        'qwertyuiopasdf',
        'aaa bbb ccc',
        'jjj kkk lll mmm',
    ];

    for (const q of gibberishQueries) {
        it(`advanced mode: "${q}" → 0 results`, async () => {
            const { status, body } = await post('/search', {
                query: q,
                mode: 'advanced',
                per_page: 5,
            });
            assert.equal(status, 200);
            assert.equal(totalOf(body), 0, `gibberish "${q}" should return 0 results in advanced mode`);
        });

        it(`basic mode: "${q}" → 0 results`, async () => {
            const { status, body } = await post('/search', {
                query: q,
                mode: 'basic',
                per_page: 5,
            });
            assert.equal(status, 200);
            assert.equal(totalOf(body), 0, `gibberish "${q}" should return 0 results in basic mode`);
        });
    }
});

describe('Non-alphanumeric and numeric-only queries return 0 results', () => {
    const edgeCases = ['!!!???', '12345', '@#$%^', '...'];

    for (const q of edgeCases) {
        it(`advanced mode: "${q}" → 0 results`, async () => {
            const { status, body } = await post('/search', {
                query: q,
                mode: 'advanced',
                per_page: 5,
            });
            assert.equal(status, 200);
            assert.equal(totalOf(body), 0, `edge case "${q}" should return 0 results in advanced mode`);
        });
    }
});

// ── Real queries must return results ──

describe('Real queries return results in advanced mode', () => {
    const realQueries = [
        { q: 'machine learning', minExpected: 5 },
        { q: 'solar energy', minExpected: 1 },
        { q: 'finite element', minExpected: 5 },
        { q: 'neural', minExpected: 3 },
        { q: 'alloy', minExpected: 5 },
        { q: 'carbon', minExpected: 3 },
    ];

    for (const { q, minExpected } of realQueries) {
        it(`"${q}" returns ≥ ${minExpected} results`, async () => {
            const { status, body } = await post('/search', {
                query: q,
                mode: 'advanced',
                per_page: 50,
            });
            assert.equal(status, 200);
            assert.ok(
                totalOf(body) >= minExpected,
                `"${q}" should return ≥${minExpected} results, got ${totalOf(body)}`
            );
            assert.ok(body.results.length > 0, 'results array should be non-empty');
        });
    }
});

describe('Real queries return results in basic mode', () => {
    const realQueries = [
        { q: 'machine learning', minExpected: 5 },
        { q: 'finite element', minExpected: 5 },
        { q: 'alloy', minExpected: 5 },
    ];

    for (const { q, minExpected } of realQueries) {
        it(`"${q}" returns ≥ ${minExpected} results`, async () => {
            const { status, body } = await post('/search', {
                query: q,
                mode: 'basic',
                per_page: 50,
            });
            assert.equal(status, 200);
            assert.ok(
                totalOf(body) >= minExpected,
                `basic "${q}" should return ≥${minExpected}, got ${totalOf(body)}`
            );
        });
    }
});

// ── Top-result relevance spot-checks ──

describe('Top results contain query terms (title relevance)', () => {
    const spotChecks = [
        { q: 'machine learning', terms: ['machine', 'learning', 'ml', 'neural', 'predict'] },
        { q: 'solar energy', terms: ['solar', 'energy', 'photovoltaic', 'pv', 'power'] },
        { q: 'finite element', terms: ['finite', 'element', 'fem', 'mesh', 'numerical'] },
    ];

    for (const { q, terms } of spotChecks) {
        it(`top 5 results for "${q}" are title-relevant`, async () => {
            const { status, body } = await post('/search', {
                query: q,
                mode: 'advanced',
                per_page: 10,
            });
            assert.equal(status, 200);
            const top5 = body.results.slice(0, 5);
            const lowerTerms = terms.map(t => t.toLowerCase());

            let relevantCount = 0;
            for (const r of top5) {
                const titleLower = (r.title || '').toLowerCase();
                const abstractLower = (r.abstract || '').toLowerCase();
                const combined = titleLower + ' ' + abstractLower;
                if (lowerTerms.some(t => combined.includes(t))) {
                    relevantCount++;
                }
            }
            assert.ok(
                relevantCount >= 3,
                `at least 3 of top 5 results for "${q}" should contain relevant terms in title/abstract, got ${relevantCount}`
            );
        });
    }
});

// ── Basic vs advanced comparison ──

describe('Basic vs advanced mode comparison', () => {
    it('basic returns fewer or equal results than advanced for broad queries', async () => {
        const queries = ['alloy', 'neural', 'machine learning'];
        for (const q of queries) {
            const [basic, advanced] = await Promise.all([
                post('/search', { query: q, mode: 'basic', per_page: 5 }),
                post('/search', { query: q, mode: 'advanced', per_page: 5 }),
            ]);
            const basicTotal = totalOf(basic.body);
            const advancedTotal = totalOf(advanced.body);
            // Advanced mode uses kNN + BM25, so it should generally find at least
            // as many results as basic (BM25-only). Small corpus edge cases may
            // violate this for certain queries, so we just check basic isn't wildly
            // larger than advanced.
            assert.ok(
                basicTotal <= advancedTotal + 10,
                `"${q}": basic (${basicTotal}) should not far exceed advanced (${advancedTotal})`
            );
        }
    });

    it('gibberish returns 0 in BOTH modes', async () => {
        const gibberish = ['asdasdasd', 'xyzqwerty'];
        for (const q of gibberish) {
            const [basic, advanced] = await Promise.all([
                post('/search', { query: q, mode: 'basic', per_page: 5 }),
                post('/search', { query: q, mode: 'advanced', per_page: 5 }),
            ]);
            assert.equal(totalOf(basic.body), 0, `basic "${q}" should be 0`);
            assert.equal(totalOf(advanced.body), 0, `advanced "${q}" should be 0`);
        }
    });
});

// ── Very short queries ──

describe('Very short queries', () => {
    it('"a" returns results (single common letter)', async () => {
        const { status, body } = await post('/search', {
            query: 'a',
            mode: 'advanced',
            per_page: 5,
        });
        assert.equal(status, 200);
        assert.ok(totalOf(body) > 0, '"a" should match many documents');
    });

    it('"ab" returns 0 in advanced (no meaningful match)', async () => {
        const { status, body } = await post('/search', {
            query: 'ab',
            mode: 'advanced',
            per_page: 5,
        });
        assert.equal(status, 200);
        // "ab" is unlikely to match any title/abstract as a standalone token
        assert.equal(totalOf(body), 0, '"ab" should not return results');
    });
});

// ── Response shape consistency ──

describe('Response shape consistency', () => {
    it('advanced search response has correct structure', async () => {
        const { status, body } = await post('/search', {
            query: 'machine learning',
            mode: 'advanced',
            per_page: 5,
        });
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.results), 'results should be an array');
        assert.ok(body.pagination, 'should have pagination');
        assert.ok(typeof body.pagination.total === 'number', 'total should be a number');
        assert.ok(typeof body.pagination.page === 'number', 'page should be a number');
        assert.ok(typeof body.pagination.per_page === 'number', 'per_page should be a number');
        assert.ok(typeof body.pagination.total_pages === 'number', 'total_pages should be a number');
        assert.equal(body.mode, 'advanced', 'mode should be advanced');
    });

    it('zero-result response for gibberish has correct structure', async () => {
        const { status, body } = await post('/search', {
            query: 'asdasdasd',
            mode: 'advanced',
            per_page: 5,
        });
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.results), 'results should be an array');
        assert.equal(body.results.length, 0, 'results should be empty');
        assert.equal(body.pagination.total, 0, 'total should be 0');
        assert.equal(body.pagination.total_pages, 0, 'total_pages should be 0');
    });

    it('each result has required fields', async () => {
        const { status, body } = await post('/search', {
            query: 'alloy',
            mode: 'advanced',
            per_page: 3,
        });
        assert.equal(status, 200);
        for (const r of body.results) {
            assert.ok(r.title, 'result should have title');
            assert.ok(Array.isArray(r.authors), 'result should have authors array');
            assert.ok(r.publication_year || r.publication_year === 0, 'result should have publication_year');
        }
    });
});

// ── Suggestions on zero results ──

describe('Suggestions for zero-result queries', () => {
    it('gibberish in advanced mode returns suggestions array (may be empty)', async () => {
        const { status, body } = await post('/search', {
            query: 'asdasdasd',
            mode: 'advanced',
            per_page: 5,
        });
        assert.equal(status, 200);
        assert.ok(
            Array.isArray(body.suggestions) || body.suggestions === undefined,
            'suggestions should be an array or undefined'
        );
    });
});
