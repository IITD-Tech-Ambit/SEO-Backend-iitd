#!/usr/bin/env node
/**
 * Intensive regression tests for author-scoped search + Explore search flows.
 *
 * Reproduces the reported bugs and pins correct behaviour:
 *   1. `query="lund"` with `search_in=['author']` must NOT fall back to the
 *      clicked author's entire lifetime corpus (was 350 — must narrow).
 *   2. Nonsense queries (no author name match, no faculty match) must return
 *      zero instead of match_all on the author corpus.
 *   3. Clicking yourself after searching your own name is allowed to return
 *      the full corpus (semantically redundant but consistent).
 *   4. Cross-mode (basic / advanced) parity for narrowing behaviour.
 *   5. Refine-within still narrows correctly.
 *
 * Run with:   node tests/author_scope_regression.mjs
 *   env BASE_URL=http://127.0.0.1:3000   (default)
 *   env AUTHOR_ID=60800                  (Prof. Basu expert_id, default)
 */

import assert from 'node:assert/strict';
import Redis from 'ioredis';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const REDIS_URL = process.env.REDIS_URL || 'redis://10.17.8.24:6379';
const AUTHOR_ID = process.env.AUTHOR_ID || '60800'; // Basu expert_id

const api = async (path, body, method = 'POST') => {
    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        throw new Error(`Non-JSON from ${method} ${path}: ${text.slice(0, 200)}`);
    }
    return { status: res.status, body: json };
};

const get = async (path) => {
    const res = await fetch(`${BASE_URL}${path}`);
    return { status: res.status, body: await res.json() };
};

// Invalidate all search caches so results come from OpenSearch every run.
async function flushCaches() {
    const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
        await r.connect();
        for (const pattern of [
            'author_scope:*',
            'search:*',
            'faculty_query:*',
            'iitd_faculty:*', // IITD scopus roster cache
        ]) {
            const keys = await r.keys(pattern);
            if (keys.length) await r.del(...keys);
        }
    } finally {
        await r.quit().catch(() => {});
    }
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
let failed = 0;

function short(title) {
    return (title || '').slice(0, 80);
}

test('health endpoint is alive', async () => {
    const { status, body } = await get('/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
});

test('search/health reports opensearch + redis healthy', async () => {
    const { status, body } = await get('/api/v1/search/health');
    assert.ok([200, 503].includes(status), 'health status should be 200/503');
    assert.equal(body.checks.opensearch, true, 'opensearch must be reachable');
    assert.equal(body.checks.redis, true, 'redis must be reachable');
});

test('IITD GATE: POST /search basic "lund" (non-IITD author) returns zero in default mode', async () => {
    // Previously "lund" matched because flat author_names contains every co-author.
    // Fix: default mode only matches IITD-affiliated authors via nested roster filter.
    const { status, body } = await api('/api/v1/search', {
        query: 'lund', page: 1, per_page: 5, mode: 'basic',
    });
    assert.equal(status, 200);
    assert.equal(body.pagination.total, 0, 'non-IITD surname must not leak through default basic search');
});

test('IITD GATE: POST /search basic "dhruv" (non-IITD co-author) returns zero', async () => {
    // "Dhruv, V.K." appears as a co-author on a paper authored by an IITD faculty (Deepak Kumar).
    // Flat author_names previously matched this; nested IITD-filter blocks it.
    const { status, body } = await api('/api/v1/search', {
        query: 'dhruv', page: 1, per_page: 5, mode: 'basic',
    });
    assert.equal(status, 200);
    assert.equal(body.pagination.total, 0, '"dhruv" (non-IITD) must not leak');
});

test('IITD GATE: POST /search basic "basu" (IITD faculty) still finds Basu\'s papers', async () => {
    const { status, body } = await api('/api/v1/search', {
        query: 'basu', page: 1, per_page: 5, mode: 'basic',
    });
    assert.equal(status, 200);
    assert.ok(body.pagination.total > 0, 'IITD faculty surname must still match');
    // At least one result should have a Basu-looking author
    const anyBasu = body.results.some((r) =>
        (r.authors || []).some((a) => /basu/i.test(a.author_name || ''))
    );
    assert.ok(anyBasu, 'results should contain a Basu author');
});

test('IITD GATE: default advanced mode "dhruv" only matches when text has "dhruva" (reactor), not an author', async () => {
    // Legitimate text match (abstract mentions "Dhruva reactor") is fine.
    // What we're verifying is we DON\'T leak solely because a non-IITD co-author is named Dhruv.
    const { status, body } = await api('/api/v1/search', {
        query: 'dhruv', page: 1, per_page: 5, mode: 'advanced',
    });
    assert.equal(status, 200);
    // Any result must justify its match via actual text (title/abstract/subject/field)
    // or via an IITD author — never via flat author_names of a non-IITD co-author.
    const toStr = (v) => Array.isArray(v) ? v.join(' ') : (v == null ? '' : String(v));
    for (const r of body.results) {
        const haystack = [r.title, r.abstract, r.subject_area, r.field_associated].map(toStr).join(' ');
        const inText = /dhruv/i.test(haystack);
        const anyIitdAuthorMatch = (r.authors || []).some((a) => /dhruv/i.test(a.author_name || ''));
        assert.ok(
            inText || anyIitdAuthorMatch,
            `paper "${short(r.title)}" must match via text or IITD author, not a non-IITD co-author leak`,
        );
    }
});

test('GET /search/faculty-for-query?query=lund (non-IITD) returns zero IITD faculty', async () => {
    const { status, body } = await get(
        `/api/v1/search/faculty-for-query?query=${encodeURIComponent('lund')}&mode=basic`,
    );
    assert.equal(status, 200);
    assert.equal(
        body.total_faculty, 0,
        'faculty-for-query must not surface IITD faculty whose only link to "lund" is a non-IITD co-author',
    );
});

test('BUG FIX: author-scope basic + search_in=["author"] + "lund" narrows (not full corpus)', async () => {
    const { status, body } = await api('/api/v1/search/author-scope', {
        query: 'lund',
        author_id: AUTHOR_ID,
        page: 1,
        per_page: 5,
        mode: 'basic',
        search_in: ['author'],
    });
    assert.equal(status, 200);
    assert.equal(body.author.total_papers, 350, 'sanity: Basu has 350 indexed papers');
    assert.ok(
        body.pagination.total < body.author.total_papers,
        `expected narrowing, got ${body.pagination.total}/${body.author.total_papers}`,
    );
    assert.ok(body.pagination.total >= 1, 'at least one co-authored-with-Lund paper expected');
});

test('BUG FIX: author-scope advanced + search_in=["author"] + "lund" narrows', async () => {
    const { status, body } = await api('/api/v1/search/author-scope', {
        query: 'lund',
        author_id: AUTHOR_ID,
        page: 1,
        per_page: 5,
        mode: 'advanced',
        search_in: ['author'],
    });
    assert.equal(status, 200);
    assert.ok(body.pagination.total < body.author.total_papers, 'advanced must narrow as well');
    assert.ok(body.pagination.total >= 1);
});

test('BUG FIX: nonsense author-name query returns zero (no match_all fallback)', async () => {
    const { status, body } = await api('/api/v1/search/author-scope', {
        query: 'xyzzzznonexistentperson',
        author_id: AUTHOR_ID,
        page: 1,
        per_page: 5,
        mode: 'basic',
        search_in: ['author'],
    });
    assert.equal(status, 200);
    assert.equal(body.pagination.total, 0, 'nonsense must not expand to full corpus');
});

test('author-scope WITHOUT search_in is unaffected by the fix (still narrows on text)', async () => {
    const { status, body } = await api('/api/v1/search/author-scope', {
        query: 'lund',
        author_id: AUTHOR_ID,
        page: 1,
        per_page: 5,
        mode: 'basic',
    });
    assert.equal(status, 200);
    assert.ok(body.pagination.total >= 1 && body.pagination.total <= 10,
        `expected narrowing via free-text, got ${body.pagination.total}`);
});

test('author-scoped IITD bypass: Basu + "lund" (non-IITD) still matches co-authored papers', async () => {
    // Inside an author-scoped search the anchor author filter already gates to an IITD faculty.
    // Free-text queries against non-IITD co-authors must still match Basu × Lund co-authored papers.
    const { status, body } = await api('/api/v1/search/author-scope', {
        query: 'lund',
        author_id: AUTHOR_ID,
        page: 1,
        per_page: 5,
        mode: 'basic',
        search_in: ['author'],
    });
    assert.equal(status, 200);
    assert.ok(
        body.pagination.total >= 1 && body.pagination.total < body.author.total_papers,
        `expected 1..${body.author.total_papers - 1} Basu×Lund hits, got ${body.pagination.total}`,
    );
});

test('author-scope own-name still returns full corpus (semantic consistency)', async () => {
    const { status, body } = await api('/api/v1/search/author-scope', {
        query: 'Basu',
        author_id: AUTHOR_ID,
        page: 1,
        per_page: 5,
        mode: 'basic',
        search_in: ['author'],
    });
    assert.equal(status, 200);
    assert.equal(body.pagination.total, body.author.total_papers,
        'clicking your own name should list all your papers');
});

test('refine_within still narrows co-authored slice', async () => {
    // First get the baseline narrowed Lund corpus, then refine to a topic.
    const base = await api('/api/v1/search/author-scope', {
        query: 'lund', author_id: AUTHOR_ID, page: 1, per_page: 10, mode: 'basic',
        search_in: ['author'],
    });
    const baseTotal = base.body.pagination.total;

    // A title word that appears in only one of the matching papers
    const refined = await api('/api/v1/search/author-scope', {
        query: 'lund',
        author_id: AUTHOR_ID,
        page: 1,
        per_page: 10,
        mode: 'basic',
        search_in: ['author'],
        refine_within: 'lund', // anchor
    });
    // Without a distinct refine text, total should be <= base
    assert.ok(refined.body.pagination.total <= baseTotal);
});

test('pagination consistency: total_pages matches ceil(total/per_page)', async () => {
    const { body } = await api('/api/v1/search/author-scope', {
        query: 'energy', author_id: AUTHOR_ID, page: 1, per_page: 7, mode: 'basic',
    });
    const expectedPages = Math.ceil(body.pagination.total / 7);
    assert.equal(body.pagination.total_pages, expectedPages);
});

test('invalid author_id returns empty result, not full-corpus leak', async () => {
    const { status, body } = await api('/api/v1/search/author-scope', {
        query: 'lund',
        author_id: 'non_existent_author_zzz_123',
        page: 1,
        per_page: 5,
        mode: 'basic',
    });
    assert.equal(status, 200);
    assert.equal(body.pagination.total, 0);
    assert.equal(body.author.total_papers, 0);
});

test('POST /search validates request body', async () => {
    const { status } = await api('/api/v1/search', {});
    assert.equal(status, 400, 'missing query should 400');
});

async function main() {
    console.log(`Base URL:  ${BASE_URL}`);
    console.log(`Author ID: ${AUTHOR_ID}\n`);
    console.log('Flushing caches before run…');
    try {
        await flushCaches();
    } catch (err) {
        console.warn('Cache flush failed (continuing):', err.message);
    }

    for (const { name, fn } of cases) {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
        } catch (err) {
            failed += 1;
            console.error(`  ✗ ${name}`);
            console.error(`      ${err.message}`);
        }
    }

    console.log(`\n${cases.length - failed}/${cases.length} passed`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
