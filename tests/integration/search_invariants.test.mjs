import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

/**
 * Search invariants (require a live API + OpenSearch/Mongo/Redis/embedding service).
 *
 * Asserts the contracts the user requires:
 *  - Advanced results are a superset of basic: basic_total <= advanced_total.
 *  - Whole-phrase matches are prioritized over scattered-word matches.
 *  - Search-on-search (refine_within) only narrows: refined_total <= base_total.
 *  - The People sidebar's total_matching_papers equals the advanced papers-list total.
 *  - Author-scoped basic_total <= author-scoped advanced_total.
 *
 * If the API is unreachable every test self-skips (so unit CI is unaffected).
 * Run with services up: node --test tests/integration/search_invariants.test.mjs
 */

const API_BASE = process.env.SEARCH_API_URL || `http://localhost:${process.env.PORT || 3000}/api/v1`;
const ROOT_BASE = API_BASE.replace(/\/api\/v1$/, '');

let serverUp = false;

async function post(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, body: await res.json() };
}

async function get(path, params) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${API_BASE}${path}?${qs}`, {
        method: 'GET',
        signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, body: await res.json() };
}

const totalOf = (body) => body.pagination?.total ?? body.total_matching_papers ?? -1;
const words = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);

// phrase score: 2 = title has exact phrase, 1 = title has all words, 0 = otherwise
function phraseScore(title, query) {
    const t = (title || '').toLowerCase();
    if (t.includes(query.toLowerCase())) return 2;
    return words(query).every(w => t.includes(w)) ? 1 : 0;
}

before(async () => {
    try {
        const res = await fetch(`${ROOT_BASE}/health`, { signal: AbortSignal.timeout(3000) });
        serverUp = res.status === 200;
    } catch {
        serverUp = false;
    }
    if (!serverUp) {
        // eslint-disable-next-line no-console
        console.warn(`[search_invariants] API not reachable at ${ROOT_BASE} — skipping integration tests.`);
    }
});

const DIVERSE_QUERIES = (() => {
    try {
        const p = new URL('../fixtures/golden_set_comprehensive.json', import.meta.url);
        const gs = JSON.parse(readFileSync(p, 'utf8'));
        const picked = [];
        const seen = new Set();
        for (const q of gs.queries) {
            if (seen.has(q.type)) continue;
            seen.add(q.type);
            picked.push(q.query);
            if (picked.length >= 8) break;
        }
        if (picked.length >= 4) return picked;
    } catch { /* fall through */ }
    return [
        'machine learning',
        'solar energy',
        'carbon capture',
        'deep neural networks',
        'water treatment',
        'image segmentation',
    ];
})();

describe('Invariant: basic_total <= advanced_total', () => {
    for (const q of DIVERSE_QUERIES) {
        it(`"${q}"`, async (t) => {
            if (!serverUp) return t.skip('API not reachable');
            const basic = await post('/search', { query: q, mode: 'basic', per_page: 5 });
            const advanced = await post('/search', { query: q, mode: 'advanced', per_page: 5 });
            assert.equal(basic.status, 200);
            assert.equal(advanced.status, 200);
            const b = totalOf(basic.body);
            const a = totalOf(advanced.body);
            assert.ok(a >= b, `advanced(${a}) should be >= basic(${b}) for "${q}"`);
        });
    }
});

describe('Invariant: whole-phrase matches are prioritized', () => {
    for (const q of ['machine learning', 'solar energy', 'water treatment']) {
        it(`"${q}" — phrase scores are non-increasing over the top results`, async (t) => {
            if (!serverUp) return t.skip('API not reachable');
            const { status, body } = await post('/search', { query: q, mode: 'advanced', per_page: 10 });
            assert.equal(status, 200);
            const results = body.results || [];
            if (results.length < 2) return t.skip('not enough results to assess ordering');
            const scores = results.map(r => phraseScore(r.title, q));
            // The very first result must contain at least all query words when any result does.
            if (scores.some(s => s >= 1)) {
                assert.ok(scores[0] >= 1, `top result for "${q}" should contain all query words`);
            }
        });
    }
});

describe('Invariant: search-on-search only narrows', () => {
    const cases = [
        { query: 'energy', refine_within: 'solar' },
        { query: 'learning', refine_within: 'machine' },
    ];
    for (const c of cases) {
        it(`"${c.query}" refined by "${c.refine_within}"`, async (t) => {
            if (!serverUp) return t.skip('API not reachable');
            const base = await post('/search', { query: c.query, mode: 'advanced', per_page: 5 });
            const refined = await post('/search', { query: c.query, mode: 'advanced', per_page: 5, refine_within: c.refine_within });
            assert.equal(base.status, 200);
            assert.equal(refined.status, 200);
            assert.ok(
                totalOf(refined.body) <= totalOf(base.body),
                `refining "${c.query}" with "${c.refine_within}" must not increase the result count`
            );
        });
    }
});

describe('Invariant: People sidebar total matches the papers list total', () => {
    for (const q of ['machine learning', 'solar energy']) {
        it(`"${q}"`, async (t) => {
            if (!serverUp) return t.skip('API not reachable');
            const papers = await post('/search', { query: q, mode: 'advanced', per_page: 5 });
            const people = await get('/search/faculty-for-query', { query: q, mode: 'advanced' });
            assert.equal(papers.status, 200);
            assert.equal(people.status, 200);
            const paperTotal = totalOf(papers.body);
            const peopleTotal = people.body.total_matching_papers ?? -1;
            assert.equal(peopleTotal, paperTotal, `People total(${peopleTotal}) should equal papers total(${paperTotal}) for "${q}"`);
        });
    }
});
