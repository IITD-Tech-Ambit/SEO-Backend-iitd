import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Rigorous multi-step refinement (search-on-search to N levels) integration tests.
 *
 * Exercises the `refine_chain` contract end-to-end against a live API + OpenSearch/Mongo/Redis/
 * embedding service. Verifies the core guarantees of the feature:
 *  - Monotonic narrowing: count(step n) <= count(step n-1) for deep chains, in basic AND advanced.
 *  - Strict subset by document id (when the full shallow set fits in one page).
 *  - Commutativity: prior-term order never changes the count (prior terms are AND filters).
 *  - Deduplication and empty/whitespace-term hygiene.
 *  - Legacy `refine_within` == single-element `refine_chain`.
 *  - basic results stay a subset of advanced under the same chain.
 *  - Chain cap (>8 terms) is accepted without error and never broadens.
 *  - Author-scope drill-down narrows within one author and never exceeds total_papers.
 *  - People sidebar (faculty-for-query) narrows through the chain.
 *  - A gibberish refinement yields zero results and never re-broadens.
 *
 * If the API is unreachable every test self-skips. Run with services up:
 *   node --test tests/integration/refinement_chain.test.mjs
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
const idsOf = (body) => (body.results || []).map(r => r.open_search_id || r._id || r.document_scopus_id).filter(Boolean);

before(async () => {
    try {
        const res = await fetch(`${ROOT_BASE}/health`, { signal: AbortSignal.timeout(3000) });
        serverUp = res.status === 200;
    } catch {
        serverUp = false;
    }
    if (!serverUp) {
        // eslint-disable-next-line no-console
        console.warn(`[refinement_chain] API not reachable at ${ROOT_BASE} — skipping integration tests.`);
    }
});

// Step the chain forward one term at a time; the newest term is `query`, the rest is `refine_chain`.
async function runChain(terms, mode, per_page = 10) {
    const steps = [];
    for (let n = 0; n < terms.length; n++) {
        const query = terms[n];
        const refine_chain = terms.slice(0, n);
        const { status, body } = await post('/search', { query, mode, per_page, refine_chain });
        steps.push({ query, refine_chain, status, body, total: totalOf(body) });
    }
    return steps;
}

describe('Deep chain narrows monotonically (count[n] <= count[n-1])', () => {
    const chains = [
        ['learning', 'machine', 'deep', 'neural'],
        ['energy', 'solar', 'cell', 'efficiency'],
    ];
    for (const mode of ['basic', 'advanced']) {
        for (const terms of chains) {
            it(`${mode}: ${terms.join(' -> ')}`, async (t) => {
                if (!serverUp) return t.skip('API not reachable');
                const steps = await runChain(terms, mode);
                for (const s of steps) assert.equal(s.status, 200, `step "${s.query}" should 200`);
                for (let n = 1; n < steps.length; n++) {
                    assert.ok(
                        steps[n].total <= steps[n - 1].total,
                        `${mode} step ${n} ("${steps[n].query}") total ${steps[n].total} must be <= prev ${steps[n - 1].total}`
                    );
                }
            });
        }
    }
});

describe('Strict subset by document id when the shallow set fits one page', () => {
    // Use an already-narrowed shallow step so its full result set is likely to fit in one page,
    // making a true subset-by-id assertion possible for the next, deeper step. The deeper step
    // follows the real refinement flow: the shallow newest term ("perovskite") becomes a filter
    // and a brand-new term ("film") becomes the scored query.
    const shallow = { query: 'perovskite', refine_chain: ['energy', 'solar'] };
    const deeper = { query: 'film', refine_chain: ['energy', 'solar', 'perovskite'] };
    for (const mode of ['basic', 'advanced']) {
        it(`${mode}: deeper step ids ⊆ shallow step ids`, async (t) => {
            if (!serverUp) return t.skip('API not reachable');
            const base = await post('/search', { ...shallow, mode, per_page: 100 });
            assert.equal(base.status, 200);
            if (totalOf(base.body) === 0 || totalOf(base.body) > 100) {
                return t.skip('shallow set does not fully fit one page; subset-by-id not assertable here');
            }
            const refined = await post('/search', { ...deeper, mode, per_page: 100 });
            assert.equal(refined.status, 200);
            const baseIds = new Set(idsOf(base.body));
            for (const id of idsOf(refined.body)) {
                assert.ok(baseIds.has(id), `refined id ${id} must be present in the shallower result set`);
            }
        });
    }
});

describe('Commutativity: prior-term order does not change the count (AND filters)', () => {
    for (const mode of ['basic', 'advanced']) {
        it(`${mode}: chain [machine, deep] == [deep, machine] for query "learning"`, async (t) => {
            if (!serverUp) return t.skip('API not reachable');
            const a = await post('/search', { query: 'learning', mode, per_page: 5, refine_chain: ['machine', 'deep'] });
            const b = await post('/search', { query: 'learning', mode, per_page: 5, refine_chain: ['deep', 'machine'] });
            assert.equal(a.status, 200);
            assert.equal(b.status, 200);
            assert.equal(totalOf(a.body), totalOf(b.body), 'prior-term order must not affect the total');
        });
    }
});

describe('Deduplication and empty-term hygiene', () => {
    for (const mode of ['basic', 'advanced']) {
        it(`${mode}: duplicate/blank chain entries collapse to the canonical chain`, async (t) => {
            if (!serverUp) return t.skip('API not reachable');
            const canonical = await post('/search', { query: 'learning', mode, per_page: 5, refine_chain: ['machine'] });
            const noisy = await post('/search', { query: 'learning', mode, per_page: 5, refine_chain: ['machine', 'Machine', '  ', 'machine'] });
            assert.equal(canonical.status, 200);
            assert.equal(noisy.status, 200);
            assert.equal(totalOf(noisy.body), totalOf(canonical.body), 'duplicate/blank terms must be ignored');
        });
    }
});

describe('Legacy refine_within == single-element refine_chain', () => {
    for (const mode of ['basic', 'advanced']) {
        it(`${mode}: "energy" refined by "solar"`, async (t) => {
            if (!serverUp) return t.skip('API not reachable');
            const legacy = await post('/search', { query: 'energy', mode, per_page: 10, refine_within: 'solar' });
            const chained = await post('/search', { query: 'energy', mode, per_page: 10, refine_chain: ['solar'] });
            assert.equal(legacy.status, 200);
            assert.equal(chained.status, 200);
            assert.equal(totalOf(chained.body), totalOf(legacy.body), 'counts must match');
            assert.deepEqual(idsOf(chained.body), idsOf(legacy.body), 'ordered result ids must match');
        });
    }
});

describe('basic results stay a subset of advanced under the same chain', () => {
    const chains = [
        { query: 'solar', refine_chain: ['energy'] },
        { query: 'deep', refine_chain: ['machine', 'learning'] },
    ];
    for (const c of chains) {
        it(`query "${c.query}" chain [${c.refine_chain}]`, async (t) => {
            if (!serverUp) return t.skip('API not reachable');
            const basic = await post('/search', { ...c, mode: 'basic', per_page: 5 });
            const advanced = await post('/search', { ...c, mode: 'advanced', per_page: 5 });
            assert.equal(basic.status, 200);
            assert.equal(advanced.status, 200);
            assert.ok(
                totalOf(advanced.body) >= totalOf(basic.body),
                `advanced(${totalOf(advanced.body)}) >= basic(${totalOf(basic.body)})`
            );
        });
    }
});

describe('Chain at the cap boundary (8 prior terms) is accepted and never broadens', () => {
    for (const mode of ['basic', 'advanced']) {
        it(`${mode}: max-length chain returns 200 and <= base`, async (t) => {
            if (!serverUp) return t.skip('API not reachable');
            const base = await post('/search', { query: 'energy', mode, per_page: 5 });
            // refine_chain is capped at maxItems: 8 — exercise the boundary with exactly 8 prior terms.
            const maxChain = await post('/search', {
                query: 'energy',
                mode,
                per_page: 5,
                refine_chain: ['solar', 'cell', 'power', 'grid', 'storage', 'battery', 'photovoltaic', 'thermal'],
            });
            assert.equal(base.status, 200);
            assert.equal(maxChain.status, 200, 'a max-length (8-prior) chain must return 200');
            assert.ok(totalOf(maxChain.body) <= totalOf(base.body), 'a deep chain must never broaden past the base');
        });
    }

    it('rejects an over-long chain (>8 prior terms) with a 400', async (t) => {
        if (!serverUp) return t.skip('API not reachable');
        const over = await post('/search', {
            query: 'energy',
            per_page: 5,
            refine_chain: ['solar', 'cell', 'power', 'grid', 'storage', 'battery', 'photovoltaic', 'thermal', 'wind'],
        });
        assert.equal(over.status, 400, 'a chain exceeding maxItems:8 must be rejected by schema validation');
    });
});

describe('A gibberish refinement yields zero results and never broadens', () => {
    for (const mode of ['basic', 'advanced']) {
        it(`${mode}: refine "energy" by "qwxzjkvbnm"`, async (t) => {
            if (!serverUp) return t.skip('API not reachable');
            const base = await post('/search', { query: 'energy', mode, per_page: 5 });
            const refined = await post('/search', { query: 'energy', mode, per_page: 5, refine_chain: ['qwxzjkvbnm'] });
            assert.equal(base.status, 200);
            assert.equal(refined.status, 200);
            assert.equal(totalOf(refined.body), 0, 'refining within a nonexistent term must yield 0 results');
            assert.ok(totalOf(refined.body) <= totalOf(base.body));
        });
    }
});

describe('People sidebar (faculty-for-query) narrows through the chain', () => {
    for (const mode of ['basic', 'advanced']) {
        it(`${mode}: faculty papers under a chain <= unrefined`, async (t) => {
            if (!serverUp) return t.skip('API not reachable');
            const base = await get('/search/faculty-for-query', { query: 'energy', mode });
            const refined = await get('/search/faculty-for-query', { query: 'solar', mode, refine_chain: JSON.stringify(['energy']) });
            assert.equal(base.status, 200);
            assert.equal(refined.status, 200);
            const baseTotal = base.body.total_matching_papers ?? -1;
            const refinedTotal = refined.body.total_matching_papers ?? -1;
            assert.ok(
                refinedTotal <= baseTotal,
                `refined faculty papers(${refinedTotal}) must be <= unrefined(${baseTotal})`
            );
        });
    }
});

describe('Author-scope drill-down narrows within one author through the chain', () => {
    for (const mode of ['basic', 'advanced']) {
        it(`${mode}: refining an author's papers narrows and never exceeds total_papers`, async (t) => {
            if (!serverUp) return t.skip('API not reachable');
            // Find a faculty with papers for the base query via the People sidebar.
            const people = await get('/search/faculty-for-query', { query: 'energy', mode });
            assert.equal(people.status, 200);
            const dept = (people.body.departments || []).find(d => (d.faculty || []).some(f => f.author_id && f.paper_count > 0));
            const faculty = dept?.faculty?.find(f => f.author_id && f.paper_count > 0);
            if (!faculty) return t.skip('no faculty with papers for the base query');

            const base = await post('/search/author-scope', {
                query: 'energy', author_id: faculty.author_id, mode, per_page: 10,
            });
            assert.equal(base.status, 200);
            const totalPapers = base.body.author?.total_papers ?? Infinity;
            assert.ok(totalOf(base.body) <= totalPapers, 'author-scope base must not exceed the author total');

            const refined = await post('/search/author-scope', {
                query: 'solar', author_id: faculty.author_id, mode, per_page: 10, refine_chain: ['energy'],
            });
            assert.equal(refined.status, 200);
            assert.ok(
                totalOf(refined.body) <= totalOf(base.body),
                `author-scope refined(${totalOf(refined.body)}) must be <= base(${totalOf(base.body)})`
            );
            assert.ok(totalOf(refined.body) <= totalPapers);
        });
    }
});
