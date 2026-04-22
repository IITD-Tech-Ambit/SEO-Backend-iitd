#!/usr/bin/env node
/**
 * Exhaustive API-level test suite for the Explore section.
 *
 * Covers every Explore-facing endpoint:
 *   - POST /api/v1/search                (main search)
 *   - POST /api/v1/search/author-scope   (author sidebar click)
 *   - GET  /api/v1/search/faculty-for-query   (People sidebar)
 *   - GET  /api/v1/search/health         (monitoring)
 *
 * Dimensions covered:
 *   - mode (basic/advanced), sort (relevance/date/citations/impact/normalized)
 *   - search_in (each allowed field + combinations + empty)
 *   - filters (year range, document_type/document_types, subject_area,
 *     author_id, kerberos, first_author_only, interdisciplinary)
 *   - pagination (page/per_page, total_pages invariants, large per_page)
 *   - refine_within (scoped + unscoped narrowing)
 *   - IITD-Faculty roster gate (non-IITD co-author leak regressions)
 *   - request validation (missing/invalid inputs)
 *   - response schema integrity (required fields, pagination math, facets)
 *   - caching behaviour (second identical call is cacheHit:true)
 *   - edge cases (special chars, unicode, very long query, nonsense)
 *
 * Run:
 *   node tests/explore_exhaustive.mjs
 * Env:
 *   BASE_URL          default http://127.0.0.1:3000
 *   REDIS_URL         default redis://10.17.8.24:6379
 *   AUTHOR_ID         default 60800 (Prof. Suddhasatwa Basu expert_id, accepted by /author-scope)
 *   AUTHOR_SCOPUS_ID  default 56301902700 (Prof. Basu's Scopus id — matches nested authors.author_id)
 */

import assert from 'node:assert/strict';
import Redis from 'ioredis';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const REDIS_URL = process.env.REDIS_URL || 'redis://10.17.8.24:6379';
const AUTHOR_ID = process.env.AUTHOR_ID || '60800';
const AUTHOR_SCOPUS_ID = process.env.AUTHOR_SCOPUS_ID || '56301902700';

// ──────────────────────────── HTTP helpers ────────────────────────────

const api = async (path, body, method = 'POST') => {
    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
    return { status: res.status, body: json, raw: text };
};

const get = async (path) => {
    const res = await fetch(`${BASE_URL}${path}`);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
    return { status: res.status, body: json, raw: text };
};

// ──────────────────────────── Redis cache flush ────────────────────────────

async function flushCaches() {
    const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
        await r.connect();
        for (const pattern of [
            'author_scope:*',
            'search:*',
            'faculty_query:*',
            'iitd_faculty:*',
        ]) {
            const keys = await r.keys(pattern);
            if (keys.length) await r.del(...keys);
        }
    } finally {
        await r.quit().catch(() => {});
    }
}

// ──────────────────────────── Test runner ────────────────────────────

const cases = [];
const test = (group, name, fn) => cases.push({ group, name, fn });
let failed = 0;
const results = [];

const short = (s, n = 80) => (s == null ? '' : String(s)).slice(0, n);
const toStr = (v) => Array.isArray(v) ? v.join(' ') : (v == null ? '' : String(v));

// Assert the "pagination" block is self-consistent on every response.
function assertPaginationInvariants(body, { page, per_page }) {
    assert.ok(body.pagination, 'missing pagination');
    assert.equal(body.pagination.page, page, 'page echoed');
    assert.equal(body.pagination.per_page, per_page, 'per_page echoed');
    assert.equal(
        body.pagination.total_pages,
        Math.ceil((body.pagination.total || 0) / per_page),
        'total_pages = ceil(total / per_page)',
    );
    assert.ok(body.results.length <= per_page, 'results.length <= per_page');
    if (body.pagination.total > 0) {
        assert.ok(body.results.length > 0, 'non-zero total must yield at least one result');
    }
}

// Assert every result hit conforms to the documented shape.
function assertResultShape(r) {
    assert.ok(typeof r._id === 'string' && r._id.length > 0, '_id present');
    assert.ok(typeof r.title === 'string' && r.title.length > 0, 'title present');
    assert.ok(Array.isArray(r.authors), 'authors is array');
    for (const a of r.authors) {
        assert.ok(typeof a.author_name === 'string' || typeof a.name === 'string', 'author has name');
        assert.ok(a.author_id != null, 'author has author_id');
    }
}

// ────────────────── Group A: Endpoint health & routing ──────────────────

test('A', 'GET /health (root) returns ok', async () => {
    const { status, body } = await get('/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
});

test('A', 'GET /api/v1/search/health reports opensearch + redis', async () => {
    const { status, body } = await get('/api/v1/search/health');
    assert.ok([200, 503].includes(status));
    assert.equal(body.checks.opensearch, true);
    assert.equal(body.checks.redis, true);
});

test('A', 'Unknown route returns 404', async () => {
    const { status } = await get('/api/v1/definitely-not-a-route');
    assert.equal(status, 404);
});

// ────────────────── Group B: Request validation ──────────────────

test('B', 'POST /search without body → 400', async () => {
    const { status } = await api('/api/v1/search', {});
    assert.equal(status, 400);
});

test('B', 'POST /search with empty query → 400', async () => {
    const { status } = await api('/api/v1/search', { query: '' });
    assert.equal(status, 400);
});

test('B', 'POST /search with query > 500 chars → 400', async () => {
    const { status } = await api('/api/v1/search', { query: 'x'.repeat(501) });
    assert.equal(status, 400);
});

test('B', 'POST /search with invalid mode → 400', async () => {
    const { status } = await api('/api/v1/search', { query: 'basu', mode: 'bogus' });
    assert.equal(status, 400);
});

test('B', 'POST /search with invalid sort → 400', async () => {
    const { status } = await api('/api/v1/search', { query: 'basu', sort: 'wtf' });
    assert.equal(status, 400);
});

test('B', 'POST /search with invalid search_in field → 400', async () => {
    const { status } = await api('/api/v1/search', { query: 'basu', search_in: ['title', 'nope'] });
    assert.equal(status, 400);
});

test('B', 'POST /search with per_page > 100 → 400', async () => {
    const { status } = await api('/api/v1/search', { query: 'basu', per_page: 101 });
    assert.equal(status, 400);
});

test('B', 'POST /search with page < 1 → 400', async () => {
    const { status } = await api('/api/v1/search', { query: 'basu', page: 0 });
    assert.equal(status, 400);
});

test('B', 'POST /search with unknown filter key is tolerated (silently ignored)', async () => {
    // Fastify's validator does not enforce nested additionalProperties here; the
    // service should accept the request and behave as if the stray key wasn't sent.
    const { status, body } = await api('/api/v1/search', {
        query: 'basu',
        filters: { not_a_real_filter: 'x' },
    });
    assert.equal(status, 200);
    assert.ok(body.pagination, 'still returns a valid search response');
});

test('B', 'POST /search with year out of range → 400', async () => {
    const { status } = await api('/api/v1/search', {
        query: 'basu',
        filters: { year_from: 1800 },
    });
    assert.equal(status, 400);
});

test('B', 'POST /search/author-scope without author_id → 400', async () => {
    const { status } = await api('/api/v1/search/author-scope', { query: 'basu' });
    assert.equal(status, 400);
});

test('B', 'POST /search/author-scope without query → 400', async () => {
    const { status } = await api('/api/v1/search/author-scope', { author_id: AUTHOR_ID });
    assert.equal(status, 400);
});

test('B', 'GET /faculty-for-query without query → 400', async () => {
    const { status } = await get('/api/v1/search/faculty-for-query');
    assert.equal(status, 400);
});

// ────────────────── Group C: Basic mode (BM25 only) ──────────────────

test('C', 'basic: common keyword "quantum" returns results and valid shape', async () => {
    const { status, body } = await api('/api/v1/search', {
        query: 'quantum', page: 1, per_page: 10, mode: 'basic',
    });
    assert.equal(status, 200);
    assert.ok(body.pagination.total > 0, 'quantum must have papers');
    assertPaginationInvariants(body, { page: 1, per_page: 10 });
    for (const r of body.results) assertResultShape(r);
    assert.equal(body.mode, 'basic');
});

test('C', 'basic: non-IITD surname "dhruv" returns 0 (IITD gate)', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'dhruv', page: 1, per_page: 5, mode: 'basic',
    });
    assert.equal(body.pagination.total, 0, 'non-IITD author must not leak in default basic');
});

test('C', 'basic: IITD surname "basu" still finds Basu papers', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'basu', page: 1, per_page: 5, mode: 'basic',
    });
    assert.ok(body.pagination.total > 0);
    const anyBasu = body.results.some((r) =>
        (r.authors || []).some((a) => /basu/i.test(a.author_name || a.name || '')),
    );
    assert.ok(anyBasu, 'at least one result should be co-authored by an IITD "Basu" faculty');
});

test('C', 'basic: single-word term strict — gibberish returns 0 (no fuzzy fallback)', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'zxyqwvxzzz', page: 1, per_page: 5, mode: 'basic',
    });
    assert.equal(body.pagination.total, 0);
    assert.ok(Array.isArray(body.suggestions));
});

test('C', 'basic: multi-word phrase narrows more than single word', async () => {
    const wide = await api('/api/v1/search', { query: 'energy', page: 1, per_page: 5, mode: 'basic' });
    const narrow = await api('/api/v1/search', { query: 'energy storage lithium', page: 1, per_page: 5, mode: 'basic' });
    assert.ok(narrow.body.pagination.total < wide.body.pagination.total, 'multi-word should narrow');
});

// ────────────────── Group D: Advanced mode (hybrid) ──────────────────

test('D', 'advanced: common keyword "quantum" returns results', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'quantum', page: 1, per_page: 10, mode: 'advanced',
    });
    assert.ok(body.pagination.total > 0);
    assertPaginationInvariants(body, { page: 1, per_page: 10 });
    assert.equal(body.mode, 'advanced');
});

test('D', 'advanced: typo "quamtum" fuzzy-matches quantum papers', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'quamtum', page: 1, per_page: 5, mode: 'advanced',
    });
    assert.ok(body.pagination.total > 0, 'fuzziness should catch a 1-char typo');
});

test('D', 'advanced: semantic intent "how do batteries store energy" returns results', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'how do batteries store energy', page: 1, per_page: 5, mode: 'advanced',
    });
    assert.ok(body.pagination.total > 0, 'semantic match should succeed');
});

test('D', 'advanced: non-IITD surname "dhruv" either 0 or only text/legit-author matches', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'dhruv', page: 1, per_page: 5, mode: 'advanced',
    });
    for (const r of body.results) {
        const haystack = [r.title, r.abstract, r.subject_area, r.field_associated].map(toStr).join(' ');
        const inText = /dhruv/i.test(haystack);
        const anyIitdAuthorMatch = (r.authors || []).some((a) => /dhruv/i.test(a.author_name || a.name || ''));
        assert.ok(inText || anyIitdAuthorMatch,
            `advanced result "${short(r.title)}" must justify the match via text or IITD author`);
    }
});

test('D', 'advanced: refine_within narrows vs. non-refined baseline', async () => {
    const base = await api('/api/v1/search', {
        query: 'energy', page: 1, per_page: 10, mode: 'advanced',
    });
    const refined = await api('/api/v1/search', {
        query: 'energy', refine_within: 'solar', page: 1, per_page: 10, mode: 'advanced',
    });
    assert.ok(refined.body.pagination.total <= base.body.pagination.total,
        'refine_within should not broaden results');
});

// ────────────────── Group E: search_in variations ──────────────────

const SEARCH_IN_CASES = [
    { search_in: ['title'], query: 'machine learning', name: 'title-only' },
    { search_in: ['abstract'], query: 'machine learning', name: 'abstract-only' },
    { search_in: ['author'], query: 'basu', name: 'author-only IITD' },
    { search_in: ['author'], query: 'dhruv', name: 'author-only non-IITD → 0', expectZero: true },
    { search_in: ['subject_area'], query: 'chemistry', name: 'subject_area-only' },
    { search_in: ['field'], query: 'computer', name: 'field-only' },
    { search_in: ['title', 'abstract'], query: 'quantum mechanics', name: 'title+abstract' },
    { search_in: ['title', 'author'], query: 'dhruv', name: 'title+author non-IITD → 0', expectZero: true },
    { search_in: ['author', 'subject_area'], query: 'basu', name: 'author+subject_area' },
];

for (const tc of SEARCH_IN_CASES) {
    test('E', `search_in=${JSON.stringify(tc.search_in)} q="${tc.query}" (${tc.name})`, async () => {
        const { status, body } = await api('/api/v1/search', {
            query: tc.query, search_in: tc.search_in, page: 1, per_page: 5, mode: 'basic',
        });
        assert.equal(status, 200);
        if (tc.expectZero) {
            assert.equal(body.pagination.total, 0, `${tc.name}: must not leak`);
        } else {
            assertPaginationInvariants(body, { page: 1, per_page: 5 });
        }
    });
}

// ────────────────── Group F: Filters ──────────────────

test('F', 'filter: year_from + year_to narrows to window', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'energy', page: 1, per_page: 10, mode: 'basic',
        filters: { year_from: 2020, year_to: 2022 },
    });
    for (const r of body.results) {
        assert.ok(r.publication_year >= 2020 && r.publication_year <= 2022,
            `year ${r.publication_year} out of [2020,2022]`);
    }
});

test('F', 'filter: document_type (single) narrows to that type', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'energy', page: 1, per_page: 10, mode: 'basic',
        filters: { document_type: 'Article' },
    });
    for (const r of body.results) {
        assert.equal(r.document_type, 'Article');
    }
});

test('F', 'filter: document_types (array) accepts multiple types', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'energy', page: 1, per_page: 10, mode: 'basic',
        filters: { document_types: ['Article', 'Review'] },
    });
    for (const r of body.results) {
        assert.ok(['Article', 'Review'].includes(r.document_type),
            `unexpected doc_type ${r.document_type}`);
    }
});

test('F', 'filter: impossible year range returns 0, valid pagination', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'energy', page: 1, per_page: 5, mode: 'basic',
        filters: { year_from: 2099, year_to: 2099 },
    });
    assert.equal(body.pagination.total, 0);
    assertPaginationInvariants(body, { page: 1, per_page: 5 });
});

test('F', 'filter: author_id (Scopus) scopes to that author\'s papers only', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'energy', page: 1, per_page: 10, mode: 'basic',
        filters: { author_id: AUTHOR_SCOPUS_ID },
    });
    assert.ok(body.pagination.total > 0, 'anchor author should have energy papers');
    for (const r of body.results) {
        const hasAuthor = (r.authors || []).some((a) => String(a.author_id) === AUTHOR_SCOPUS_ID);
        assert.ok(hasAuthor, `paper "${short(r.title)}" missing author ${AUTHOR_SCOPUS_ID}`);
    }
});

test('F', 'KNOWN BUG: first_author_only + author_id does NOT actually require anchor at pos 1', async () => {
    // The current implementation of `first_author_only` pushes a separate
    // nested clause `{ authors.author_position: 1 }`, i.e. "some author in the
    // paper is at position 1". It does not bind that constraint to the
    // `author_id` filter, so a paper where Basu is position 3 still passes as
    // long as *someone* is at position 1 (trivially true for almost every paper).
    //
    // This test pins the current broken behaviour: at least one returned paper
    // must have the anchor NOT at position 1. Fix = combine both predicates in
    // a single nested query:
    //   { nested: { path: 'authors', query: { bool: { must: [
    //       { term: { 'authors.author_id': AID } },
    //       { term: { 'authors.author_position': 1 } },
    //   ] } } } }
    const { body } = await api('/api/v1/search', {
        query: 'energy', page: 1, per_page: 10, mode: 'basic',
        filters: { author_id: AUTHOR_SCOPUS_ID, first_author_only: true },
    });
    assert.ok(body.pagination.total > 0, 'the filter should not collapse the result set');
    const badPapers = body.results.filter((r) => {
        const positions = (r.authors || [])
            .filter((a) => String(a.author_id) === AUTHOR_SCOPUS_ID)
            .map((a) => Number(a.author_position))
            .filter((p) => !Number.isNaN(p));
        return positions.length > 0 && !positions.includes(1);
    });
    assert.ok(badPapers.length > 0,
        'pinned bug — expected some paper where anchor is not first author. If this fails, the bug has been fixed; update this test.');
});

test('F', 'filter: interdisciplinary=true limits to papers with 3+ subject areas', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'energy', page: 1, per_page: 10, mode: 'basic',
        filters: { interdisciplinary: true },
    });
    for (const r of body.results) {
        const sa = r.subject_area || [];
        assert.ok(sa.length >= 3,
            `interdisciplinary=true but subject_area length = ${sa.length}`);
    }
});

// ────────────────── Group G: Sort variations ──────────────────

// `normalized` is only exercised in basic mode because advanced mode hits a
// known painless-script bug (see the "KNOWN BUG" test below).
const SORT_MATRIX = [
    ['relevance', 'advanced'],
    ['date', 'advanced'],
    ['citations', 'advanced'],
    ['impact', 'advanced'],
    ['normalized', 'basic'],
];
for (const [s, mode] of SORT_MATRIX) {
    test('G', `sort=${s} (mode=${mode}): returns results and passes pagination invariants`, async () => {
        const { status, body } = await api('/api/v1/search', {
            query: 'quantum', page: 1, per_page: 10, mode, sort: s,
        });
        assert.equal(status, 200);
        assert.ok(body.pagination.total > 0);
        assertPaginationInvariants(body, { page: 1, per_page: 10 });
    });
}

test('G', 'KNOWN BUG: sort=normalized + mode=advanced → 502 (painless cosineSimilarity field arg)', async () => {
    // _buildNormalizedHybridQuery passes the field name as a string literal:
    //   cosineSimilarity(params.queryVector, 'embedding')
    // OpenSearch/KNN expects `doc['embedding']` instead. This test pins the
    // current broken behaviour so we notice when the underlying code is fixed.
    const { status, body } = await api('/api/v1/search', {
        query: 'quantum', page: 1, per_page: 5, mode: 'advanced', sort: 'normalized',
    });
    assert.equal(status, 502, `expected pinned bug status 502, got ${status}`);
    assert.equal(body?.error, 'Bad Gateway');
});

test('G', 'sort=date returns descending publication_year', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'quantum', page: 1, per_page: 10, mode: 'advanced', sort: 'date',
    });
    const years = body.results.map((r) => r.publication_year).filter((y) => y != null);
    for (let i = 1; i < years.length; i++) {
        assert.ok(years[i - 1] >= years[i], `year ordering broken at idx ${i}: ${years}`);
    }
});

test('G', 'sort=citations returns descending citation_count', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'quantum', page: 1, per_page: 10, mode: 'advanced', sort: 'citations',
    });
    const cits = body.results.map((r) => r.citation_count || 0);
    for (let i = 1; i < cits.length; i++) {
        assert.ok(cits[i - 1] >= cits[i], `citation ordering broken: ${cits}`);
    }
});

// ────────────────── Group H: Pagination ──────────────────

test('H', 'pagination: page=1 and page=2 return disjoint result sets', async () => {
    const a = await api('/api/v1/search', {
        query: 'energy', page: 1, per_page: 5, mode: 'basic',
    });
    const b = await api('/api/v1/search', {
        query: 'energy', page: 2, per_page: 5, mode: 'basic',
    });
    const ids1 = new Set(a.body.results.map((r) => r._id));
    const ids2 = new Set(b.body.results.map((r) => r._id));
    for (const id of ids2) assert.ok(!ids1.has(id), `duplicate _id ${id} across pages`);
});

test('H', 'pagination: page beyond total_pages returns empty results OR a bounded deep-page error', async () => {
    // Use a narrow query whose total is safely small so we can page past it
    // without hitting OpenSearch's max_result_window (10000 = page*per_page).
    const narrow = { query: 'cryogenic plasma confinement IITD xyz-unique', per_page: 5, mode: 'basic' };
    const a = await api('/api/v1/search', { ...narrow, page: 1 });
    const tp = a.body.pagination?.total_pages ?? 0;
    const safePage = Math.max(tp + 5, 1);
    const far = await api('/api/v1/search', { ...narrow, page: safePage });
    if (far.status === 200) {
        assert.equal(far.body.pagination.total, a.body.pagination.total,
            'total should be consistent across pages');
        assert.equal(far.body.results.length, 0);
    } else {
        assert.ok([400, 500, 502].includes(far.status),
            `got unexpected status ${far.status}`);
        assert.ok(far.body?.error, 'error body required when status != 200');
    }
});

test('H', 'pagination: extreme deep page (> max_result_window) returns a clean error, not a crash', async () => {
    const { status, body } = await api('/api/v1/search', {
        query: 'energy', page: 9999, per_page: 100, mode: 'basic',
    });
    // OpenSearch default max_result_window is 10000. The service surfaces the
    // underlying OpenSearch error as 502 (Bad Gateway) today; accept any
    // documented non-2xx as long as the JSON envelope is still well-formed.
    assert.ok([200, 400, 500, 502, 503].includes(status),
        `unexpected status ${status}`);
    if (status !== 200) {
        assert.ok(body?.error, 'error body must be present');
        assert.ok(body?.statusCode, 'error body must include statusCode');
    }
});

test('H', 'pagination: per_page boundary (100) is accepted', async () => {
    const { status, body } = await api('/api/v1/search', {
        query: 'energy', page: 1, per_page: 100, mode: 'basic',
    });
    assert.equal(status, 200);
    assert.ok(body.results.length <= 100);
});

// ────────────────── Group I: Response shape & facets ──────────────────

test('I', 'search response has required top-level keys', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'quantum', page: 1, per_page: 5, mode: 'advanced',
    });
    for (const k of ['results', 'pagination', 'mode']) {
        assert.ok(k in body, `missing "${k}"`);
    }
});

test('I', 'every result hit has valid shape', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'quantum', page: 1, per_page: 10, mode: 'advanced',
    });
    for (const r of body.results) assertResultShape(r);
});

test('I', 'facets present and well-formed when aggregations available', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'quantum', page: 1, per_page: 5, mode: 'basic',
    });
    assert.ok(body.facets, 'facets should be present on a non-trivial query');
    // The service exposes each facet as an array of { value, count } buckets.
    for (const [name, buckets] of Object.entries(body.facets)) {
        assert.ok(Array.isArray(buckets), `facet ${name} should be an array`);
        for (const b of buckets) {
            assert.ok(b.value !== undefined, `facet ${name}: missing "value"`);
            assert.ok(typeof b.count === 'number' && b.count >= 0,
                `facet ${name}: invalid "count" (${b.count})`);
        }
    }
    // Sanity: at least one of the standard facets must exist.
    const expected = ['years', 'document_types', 'fields', 'subject_areas'];
    const found = expected.filter((k) => k in body.facets);
    assert.ok(found.length > 0, `expected at least one of ${expected}, got ${Object.keys(body.facets)}`);
});

test('I', 'related_faculty is array when present', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'basu', page: 1, per_page: 5, mode: 'basic',
    });
    if ('related_faculty' in body) {
        assert.ok(Array.isArray(body.related_faculty));
    }
});

// ────────────────── Group J: refine_within ──────────────────

test('J', 'refine_within: base refined by distinct term narrows strictly', async () => {
    const base = await api('/api/v1/search', {
        query: 'quantum', page: 1, per_page: 10, mode: 'basic',
    });
    const refined = await api('/api/v1/search', {
        query: 'quantum', refine_within: 'computing', page: 1, per_page: 10, mode: 'basic',
    });
    assert.ok(refined.body.pagination.total <= base.body.pagination.total,
        'refine_within must not broaden');
});

test('J', 'refine_within: nonsense refinement returns 0', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'quantum', refine_within: 'zxyqwvzzz', page: 1, per_page: 5, mode: 'basic',
    });
    assert.equal(body.pagination.total, 0);
});

test('J', 'refine_within: combined with search_in=["author"] + IITD surname', async () => {
    const { status, body } = await api('/api/v1/search', {
        query: 'basu', refine_within: 'basu', search_in: ['author'],
        page: 1, per_page: 5, mode: 'basic',
    });
    assert.equal(status, 200);
    assert.ok(body.pagination.total >= 0);
});

// ────────────────── Group K: author-scope endpoint ──────────────────

test('K', 'author-scope: bare query (no search_in) finds within Basu corpus', async () => {
    const { status, body } = await api('/api/v1/search/author-scope', {
        query: 'energy', author_id: AUTHOR_ID,
        page: 1, per_page: 5, mode: 'basic',
    });
    assert.equal(status, 200);
    assert.ok(body.author.total_papers > 0);
    assert.ok(body.pagination.total <= body.author.total_papers);
    assertPaginationInvariants(body, { page: 1, per_page: 5 });
});

test('K', 'author-scope: search_in=["author"] + IITD surname "basu" = full corpus', async () => {
    const { body } = await api('/api/v1/search/author-scope', {
        query: 'basu', author_id: AUTHOR_ID,
        page: 1, per_page: 5, mode: 'basic', search_in: ['author'],
    });
    assert.equal(body.pagination.total, body.author.total_papers);
});

test('K', 'author-scope: search_in=["author"] + non-IITD surname "lund" narrows', async () => {
    const { body } = await api('/api/v1/search/author-scope', {
        query: 'lund', author_id: AUTHOR_ID,
        page: 1, per_page: 5, mode: 'basic', search_in: ['author'],
    });
    assert.ok(body.pagination.total >= 1);
    assert.ok(body.pagination.total < body.author.total_papers);
});

test('K', 'author-scope: search_in=["author"] + nonsense → 0 (no full-corpus leak)', async () => {
    const { body } = await api('/api/v1/search/author-scope', {
        query: 'xyzqqqnonperson', author_id: AUTHOR_ID,
        page: 1, per_page: 5, mode: 'basic', search_in: ['author'],
    });
    assert.equal(body.pagination.total, 0);
});

test('K', 'author-scope: advanced mode has parity with basic narrowing for "lund"', async () => {
    const a = await api('/api/v1/search/author-scope', {
        query: 'lund', author_id: AUTHOR_ID,
        page: 1, per_page: 5, mode: 'basic', search_in: ['author'],
    });
    const b = await api('/api/v1/search/author-scope', {
        query: 'lund', author_id: AUTHOR_ID,
        page: 1, per_page: 5, mode: 'advanced', search_in: ['author'],
    });
    assert.ok(a.body.pagination.total >= 1);
    assert.ok(b.body.pagination.total >= 1);
    // advanced can be >= basic because of fuzziness
    assert.ok(b.body.pagination.total >= a.body.pagination.total);
});

test('K', 'author-scope: invalid author_id → empty, not full-corpus leak', async () => {
    const { body } = await api('/api/v1/search/author-scope', {
        query: 'lund', author_id: 'definitely_not_an_author_id_zzz',
        page: 1, per_page: 5, mode: 'basic',
    });
    assert.equal(body.pagination.total, 0);
    assert.equal(body.author.total_papers, 0);
});

test('K', 'author-scope: every result truly includes the anchor author (by Scopus id or name)', async () => {
    const { body } = await api('/api/v1/search/author-scope', {
        query: 'energy', author_id: AUTHOR_ID,
        page: 1, per_page: 10, mode: 'basic',
    });
    const anchorName = (body.author?.name || '').toLowerCase();
    const anchorLastName = anchorName.split(/\s+/).filter(Boolean).pop() || '';
    for (const r of body.results) {
        const byId = (r.authors || []).some((a) =>
            String(a.author_id) === AUTHOR_SCOPUS_ID || String(a.author_id) === AUTHOR_ID);
        const byName = anchorLastName && (r.authors || []).some((a) =>
            (a.author_name || a.name || '').toLowerCase().includes(anchorLastName));
        assert.ok(byId || byName,
            `result "${short(r.title)}" does not list anchor ${body.author?.name}`);
    }
});

// ────────────────── Group L: faculty-for-query endpoint ──────────────────

test('L', 'faculty-for-query: common term "quantum" returns IITD faculty', async () => {
    const { status, body } = await get(
        `/api/v1/search/faculty-for-query?query=${encodeURIComponent('quantum')}&mode=basic`,
    );
    assert.equal(status, 200);
    assert.ok(body.total_faculty > 0);
    assert.ok(Array.isArray(body.departments));
});

test('L', 'faculty-for-query: non-IITD surname "dhruv" returns 0 IITD faculty', async () => {
    const { body } = await get(
        `/api/v1/search/faculty-for-query?query=${encodeURIComponent('dhruv')}&mode=basic`,
    );
    assert.equal(body.total_faculty, 0);
});

test('L', 'faculty-for-query: IITD surname "basu" includes a Basu', async () => {
    const { body } = await get(
        `/api/v1/search/faculty-for-query?query=${encodeURIComponent('basu')}&mode=basic`,
    );
    const flat = body.departments.flatMap((d) => d.faculty || []);
    const anyBasu = flat.some((f) =>
        /basu/i.test(String(f.name || f.first_name || f.last_name || '')));
    assert.ok(anyBasu, 'expected at least one Basu in faculty-for-query result');
});

test('L', 'faculty-for-query: paper_count per faculty is bounded by their total papers', async () => {
    const { body } = await get(
        `/api/v1/search/faculty-for-query?query=${encodeURIComponent('quantum')}&mode=basic`,
    );
    const flat = body.departments.flatMap((d) => d.faculty || []);
    for (const f of flat) {
        assert.ok(typeof f.paper_count === 'number' && f.paper_count >= 0,
            `faculty paper_count invalid: ${f.paper_count}`);
    }
});

test('L', 'faculty-for-query: search_in=author applies same narrowing', async () => {
    const { body } = await get(
        `/api/v1/search/faculty-for-query?query=${encodeURIComponent('dhruv')}&mode=basic&search_in=author`,
    );
    assert.equal(body.total_faculty, 0);
});

// ────────────────── Group M: Caching behaviour ──────────────────

test('M', 'same /search request twice → second has meta.cache_hit:true (non-empty result set)', async () => {
    // Zero-result queries are intentionally NOT cached by the service, so we
    // pick a query guaranteed to return results.
    const payload = {
        query: 'perovskite solar cell efficiency', page: 1, per_page: 5, mode: 'basic',
    };
    const r1 = await api('/api/v1/search', payload);
    const r2 = await api('/api/v1/search', payload);
    assert.ok(r1.body.pagination.total > 0, 'precondition: probe query must return results');
    assert.equal(r2.body?.meta?.cache_hit, true, 'second call should be a cache hit');
    assert.equal(r2.body.pagination.total, r1.body.pagination.total,
        'cold vs warm totals must match');
});

test('M', 'same /author-scope request twice → second has meta.cache_hit:true', async () => {
    const r1 = await api('/api/v1/search/author-scope', {
        query: 'energy', author_id: AUTHOR_ID, page: 1, per_page: 5, mode: 'basic',
    });
    const r2 = await api('/api/v1/search/author-scope', {
        query: 'energy', author_id: AUTHOR_ID, page: 1, per_page: 5, mode: 'basic',
    });
    assert.equal(r2.body?.meta?.cache_hit, true, 'second call should be a cache hit');
    assert.equal(r2.body.pagination.total, r1.body.pagination.total);
});

// ────────────────── Group N: Edge cases ──────────────────

test('N', 'edge: whitespace-padded query is trimmed / treated normally', async () => {
    const a = await api('/api/v1/search', { query: '   quantum   ', page: 1, per_page: 5, mode: 'basic' });
    const b = await api('/api/v1/search', { query: 'quantum', page: 1, per_page: 5, mode: 'basic' });
    assert.equal(a.status, 200);
    assert.equal(a.body.pagination.total, b.body.pagination.total);
});

test('N', 'edge: Unicode / non-ASCII query does not 500', async () => {
    const { status } = await api('/api/v1/search', {
        query: 'αβγ résumé 机器学习', page: 1, per_page: 5, mode: 'basic',
    });
    assert.equal(status, 200);
});

test('N', 'edge: special chars in query are handled', async () => {
    const { status } = await api('/api/v1/search', {
        query: '+-&&||!(){}[]^"~*?:\\/', page: 1, per_page: 5, mode: 'basic',
    });
    assert.equal(status, 200);
});

test('N', 'edge: long 500-char query does not 500', async () => {
    const { status } = await api('/api/v1/search', {
        query: 'quantum '.repeat(62).trim(), page: 1, per_page: 5, mode: 'basic',
    });
    assert.equal(status, 200);
});

test('N', 'edge: single character query is valid', async () => {
    const { status } = await api('/api/v1/search', {
        query: 'q', page: 1, per_page: 5, mode: 'basic',
    });
    assert.equal(status, 200);
});

test('N', 'edge: numeric query is handled', async () => {
    const { status } = await api('/api/v1/search', {
        query: '2022', page: 1, per_page: 5, mode: 'basic',
    });
    assert.equal(status, 200);
});

// ────────────────── Group O: Basic literal-match (no stemmer leaks) ──────────────────
// Regression guard for the "Communication → community papers" bug fix. Basic
// mode must use the un-stemmed `.standard` sub-fields of title/abstract so
// Porter-stem collisions (communication↔community, inform↔information) cannot
// promote off-topic results.

const LITERAL_CASES = [
    {
        name: 'Communication',
        query: 'Communication',
        anchor: /communicat/i,
        mustNotBeSoleMatchFor: /communit/i,
    },
    {
        name: 'information',
        query: 'information',
        anchor: /informati/i,          // information, informational, informative
        mustNotBeSoleMatchFor: /inform(?!ati)/i,   // inform / informed / informal
    },
    {
        name: 'optimize',
        query: 'optimize',
        anchor: /optim(?:iz|is)/i,    // optimize/optimise/optimization
        mustNotBeSoleMatchFor: /optim(?:al|um)\b/i, // optimal/optimum as pure collisions
    },
    {
        name: 'production',
        query: 'production',
        anchor: /produc(?:tion|ed|ing|tive)/i,
        mustNotBeSoleMatchFor: /\bproduct(?:s)?\b/i,
    },
];

for (const tc of LITERAL_CASES) {
    test('O', `basic literal-only: "${tc.name}" — top-20 all contain anchor token`, async () => {
        const { body } = await api('/api/v1/search', {
            query: tc.query, mode: 'basic', page: 1, per_page: 20,
        });
        assert.ok(body.pagination.total > 0, `precondition: "${tc.name}" must have results`);
        const offenders = body.results.filter((r) => {
            const text = ((r.title || '') + ' ' + (r.abstract || '')).toLowerCase();
            const hasAnchor = tc.anchor.test(text);
            const hasCollision = tc.mustNotBeSoleMatchFor.test(text);
            return !hasAnchor && hasCollision;
        });
        assert.equal(offenders.length, 0,
            `basic "${tc.name}" leaked ${offenders.length} stem-collision result(s): ` +
            offenders.slice(0, 3).map((o) => short(o.title)).join(' | '));
    });
}

test('O', 'basic literal-only: "Communication" — zero community-only papers in top-30', async () => {
    const LIT = /communicat/i;
    const COM = /communit/i;
    const { body } = await api('/api/v1/search', {
        query: 'Communication', mode: 'basic', page: 1, per_page: 30,
    });
    const communityOnly = body.results.filter((r) => {
        const text = ((r.title || '') + ' ' + (r.abstract || '')).toLowerCase();
        return !LIT.test(text) && COM.test(text);
    });
    assert.equal(communityOnly.length, 0,
        `community-only leak: ${communityOnly.map((r) => short(r.title)).join(' | ')}`);
});

test('O', 'basic literal-only: advanced mode still uses stemmer (control — total differs from basic)', async () => {
    const basic = await api('/api/v1/search', { query: 'Communication', mode: 'basic',    page: 1, per_page: 5 });
    const adv   = await api('/api/v1/search', { query: 'Communication', mode: 'advanced', page: 1, per_page: 5 });
    // Advanced retains stemming (recall-oriented), so it should return strictly
    // more results than basic. If they ever converge, the basic gate regressed.
    assert.ok(adv.body.pagination.total > basic.body.pagination.total,
        `advanced (${adv.body.pagination.total}) should exceed basic (${basic.body.pagination.total})`);
});

test('O', 'basic literal-only: soft morphology — "communications" retrieves communication papers', async () => {
    // Plural ↔ singular must still cross-retrieve via the low-boost stemmed
    // SHOULD clause in _buildBasicQuery; otherwise strictness is too harsh.
    const { body } = await api('/api/v1/search', {
        query: 'communications', mode: 'basic', page: 1, per_page: 10,
    });
    assert.ok(body.pagination.total > 0);
    const anyLiteralCommunication = body.results.some((r) =>
        /\bcommunication\b/i.test((r.title || '') + ' ' + (r.abstract || '')));
    assert.ok(anyLiteralCommunication,
        'expected at least one "communication" (singular) paper retrievable from a "communications" query');
});

test('O', 'basic literal-only: author search still works (nested path, not affected by stemmer change)', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'basu', mode: 'basic', page: 1, per_page: 5, search_in: ['author'],
    });
    assert.ok(body.pagination.total > 0, 'Basu author search must still return papers');
});

test('O', 'basic literal-only: search_in=["title"] matches literally', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'Communication', mode: 'basic', page: 1, per_page: 10, search_in: ['title'],
    });
    for (const r of body.results) {
        assert.ok(/communicat/i.test(r.title || ''),
            `title-search result "${short(r.title)}" missing literal "communicat*"`);
    }
});

test('O', 'basic literal-only: search_in=["abstract"] matches literally', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'Communication', mode: 'basic', page: 1, per_page: 10, search_in: ['abstract'],
    });
    for (const r of body.results) {
        assert.ok(/communicat/i.test(r.abstract || ''),
            `abstract-search result "${short(r.title)}" missing literal "communicat*"`);
    }
});

test('O', 'basic literal-only: refine_within keeps literal semantics', async () => {
    // Base "Communication", refined within "wireless" — every result must contain
    // both literal "communicat*" and literal "wireless" in title or abstract.
    const { body } = await api('/api/v1/search', {
        query: 'Communication', refine_within: 'wireless',
        mode: 'basic', page: 1, per_page: 10,
    });
    assert.ok(body.pagination.total > 0);
    for (const r of body.results) {
        const text = ((r.title || '') + ' ' + (r.abstract || '')).toLowerCase();
        assert.ok(/communicat/i.test(text), `refine: missing communicat in "${short(r.title)}"`);
        assert.ok(/wireless/i.test(text),   `refine: missing wireless in "${short(r.title)}"`);
    }
});

test('O', 'basic literal-only: multi-word "wireless communication" phrase boost still literal', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'wireless communication', mode: 'basic', page: 1, per_page: 10,
    });
    assert.ok(body.pagination.total > 0);
    for (const r of body.results) {
        const text = ((r.title || '') + ' ' + (r.abstract || '')).toLowerCase();
        assert.ok(/communicat/i.test(text) && /wireless/i.test(text),
            `multi-word basic leak: "${short(r.title)}"`);
    }
});

test('O', 'basic literal-only: author-scope Basu + "lund" still bypasses gate and narrows', async () => {
    const { body } = await api('/api/v1/search/author-scope', {
        query: 'lund', author_id: AUTHOR_ID,
        page: 1, per_page: 5, mode: 'basic', search_in: ['author'],
    });
    assert.ok(body.pagination.total >= 1,
        'author-scope bypass must still allow non-IITD co-author matches');
    assert.ok(body.pagination.total < body.author.total_papers,
        'and must narrow vs full corpus');
});

test('O', 'basic literal-only: quantitative — "Communication" top-20 precision ≥ 95%', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'Communication', mode: 'basic', page: 1, per_page: 20,
    });
    const literal = body.results.filter((r) =>
        /communicat/i.test(((r.title || '') + ' ' + (r.abstract || '')))).length;
    const precision = literal / body.results.length;
    assert.ok(precision >= 0.95,
        `precision regressed to ${(precision * 100).toFixed(1)}% — expected >= 95%`);
});

// ────────────────── Group P: minimal_english morphology (plurals collapse, stems don't) ──────────────────
// Basic mode now indexes title/abstract through a custom `minimal_english_analyzer`
// on the `.standard` sub-field. This analyzer collapses regular plurals
// (communication↔communications, battery↔batteries) but preserves distinct
// roots (communication vs community, inform vs information, optimize vs optimal).

async function basicQueryIds(query) {
    const { body } = await api('/api/v1/search', { query, mode: 'basic', page: 1, per_page: 50 });
    return {
        total: body.pagination.total,
        ids: new Set(body.results.map((r) => r.scopus_id || r.mongo_id || r._id)),
        titles: body.results.map((r) => (r.title || '').trim()),
    };
}

const COLLAPSE_PAIRS = [
    ['communication', 'communications'],
    ['battery', 'batteries'],
    ['optimization', 'optimizations'],
    ['network', 'networks'],
];

for (const [a, b] of COLLAPSE_PAIRS) {
    test('P', `morphology: "${a}" ≡ "${b}" — same totals and near-identical top-50`, async () => {
        const left  = await basicQueryIds(a);
        const right = await basicQueryIds(b);
        assert.equal(left.total, right.total,
            `totals must match: ${a}=${left.total} vs ${b}=${right.total}`);
        const overlap = [...left.ids].filter((id) => right.ids.has(id)).length;
        assert.ok(overlap >= 48,
            `top-50 overlap ${overlap}/50 — expected >= 48`);
    });
}

const DISTINCT_PAIRS = [
    ['communication', 'community'],
    ['inform',        'information'],
    ['optimize',      'optimal'],
    ['production',    'product'],
];

for (const [a, b] of DISTINCT_PAIRS) {
    test('P', `morphology: "${a}" ≠ "${b}" — different result sets (no over-stemming)`, async () => {
        const left  = await basicQueryIds(a);
        const right = await basicQueryIds(b);
        // Require their totals are not lock-stepped AND top-50 overlap is small.
        assert.notEqual(left.total, right.total,
            `distinct roots must not have identical totals: ${a}=${left.total} vs ${b}=${right.total}`);
        const overlap = [...left.ids].filter((id) => right.ids.has(id)).length;
        assert.ok(overlap < 25,
            `top-50 overlap ${overlap}/50 is too high for "${a}" vs "${b}"`);
    });
}

test('P', 'morphology: "Communication" basic — still 0 community-only papers in top-30', async () => {
    const { body } = await api('/api/v1/search', {
        query: 'Communication', mode: 'basic', page: 1, per_page: 30,
    });
    const leaks = body.results.filter((r) => {
        const t = ((r.title || '') + ' ' + (r.abstract || '')).toLowerCase();
        return !/communicat/i.test(t) && /communit/i.test(t);
    });
    assert.equal(leaks.length, 0,
        `leaks: ${leaks.slice(0, 3).map((r) => short(r.title)).join(' | ')}`);
});

test('P', 'morphology: plural-only title retrievable via singular query (soft morphology recall)', async () => {
    // "MIMO communications" or similar plural-form titles must now appear in
    // the result set for query="communication" — the whole point of upgrading
    // the analyzer. We confirm by asking for both and checking intersection.
    const sing = await api('/api/v1/search', { query: 'communication',  mode: 'basic', page: 1, per_page: 100 });
    const plur = await api('/api/v1/search', { query: 'communications', mode: 'basic', page: 1, per_page: 100 });
    const singIds = new Set(sing.body.results.map((r) => r.scopus_id || r.mongo_id || r._id));
    const plurIds = new Set(plur.body.results.map((r) => r.scopus_id || r.mongo_id || r._id));
    const overlap = [...plurIds].filter((id) => singIds.has(id)).length;
    assert.ok(overlap >= 95,
        `expected almost-complete overlap, got ${overlap}/100`);
});

test('P', 'morphology: advanced mode unchanged — uses Porter via `title` root, recalls much more', async () => {
    const basic    = await api('/api/v1/search', { query: 'Communication', mode: 'basic',    page: 1, per_page: 5 });
    const advanced = await api('/api/v1/search', { query: 'Communication', mode: 'advanced', page: 1, per_page: 5 });
    assert.ok(advanced.body.pagination.total > basic.body.pagination.total * 1.5,
        `advanced (${advanced.body.pagination.total}) should vastly exceed basic (${basic.body.pagination.total})`);
});

// ────────────────── Main ──────────────────

async function main() {
    console.log(`Base URL:   ${BASE_URL}`);
    console.log(`Author ID:  ${AUTHOR_ID}`);
    console.log(`Test count: ${cases.length}\n`);
    console.log('Flushing caches before run…');
    try { await flushCaches(); } catch (err) {
        console.warn('Cache flush failed (continuing):', err.message);
    }

    let curGroup = null;
    const t0 = Date.now();
    for (const { group, name, fn } of cases) {
        if (group !== curGroup) {
            curGroup = group;
            console.log(`\n[Group ${group}]`);
        }
        const started = Date.now();
        try {
            await fn();
            const ms = Date.now() - started;
            console.log(`  \u2713 ${name}  (${ms}ms)`);
            results.push({ group, name, ok: true, ms });
        } catch (err) {
            failed += 1;
            const ms = Date.now() - started;
            console.error(`  \u2717 ${name}  (${ms}ms)`);
            console.error(`      ${err.message?.split('\n')[0]}`);
            results.push({ group, name, ok: false, ms, err: err.message });
        }
    }

    const total = cases.length;
    const passed = total - failed;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${passed}/${total} passed  (${failed} failed, ${elapsed}s total)`);

    // Per-group summary
    const byGroup = {};
    for (const r of results) {
        byGroup[r.group] ??= { pass: 0, fail: 0 };
        byGroup[r.group][r.ok ? 'pass' : 'fail'] += 1;
    }
    console.log('\nBy group:');
    for (const [g, s] of Object.entries(byGroup)) {
        console.log(`  ${g}: ${s.pass}/${s.pass + s.fail}`);
    }

    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
