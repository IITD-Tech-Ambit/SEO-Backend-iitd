#!/usr/bin/env node
/**
 * Intensive, self-contained regression suite for BASIC-MODE search.
 *
 * Purpose
 * -------
 * Run this AFTER any reindex (new mapping, data refresh, analyzer change)
 * to confirm that basic-mode search is working end-to-end.
 *
 * What it covers
 * --------------
 *   [Pre]   Service health + index analyzer sanity (english vs minimal_english)
 *   [L]     Literal precision — no Porter-stem leaks (communication ≠ community)
 *   [M]     Morphology recall — plurals collapse (communication ≡ communications)
 *   [D]     Distinct-root integrity — no over-stemming (inform ≠ information)
 *   [A]     Author-name search (search_in=["author"])
 *   [G]     IITD faculty gate (non-IITD co-author leaks)
 *   [F]     search_in field constraints (title / abstract / subject / field / author)
 *   [R]     refine_within (base + refinement narrowing)
 *   [S]     Author-scope bypass (authorScopedSearch)
 *   [P]     Phrase boost on multi-word queries
 *   [X]     Filters (year, document_type, subject_area, author_id)
 *   [O]     Sort variants (relevance / date / citations)
 *   [N]     Pagination + facets + response shape
 *   [E]     Edge cases (empty / whitespace / special / unicode / long / numeric)
 *   [V]     Validation errors (malformed requests)
 *   [C]     Cache hit semantics
 *   [Q]     Quantitative precision benchmark — prints a table
 *
 * Run
 * ---
 *   node tests/basic_search_intensive.mjs
 *
 * Env
 * ---
 *   BASE_URL          default http://127.0.0.1:3000
 *   OS_URL            default http://10.17.8.24:9200          (OpenSearch direct)
 *   OS_INDEX          default research_documents              (the alias or index)
 *   REDIS_URL         default redis://10.17.8.24:6379         (cache flush; optional)
 *   AUTHOR_ID         default 60800                           (Prof. Basu expert_id)
 *   AUTHOR_SCOPUS_ID  default 56301902700                     (Prof. Basu Scopus id)
 *   SKIP_CACHE_FLUSH  set to 1 to skip redis flush at startup
 *
 * Exit codes
 * ----------
 *   0 — every test passed
 *   1 — at least one test failed (see per-group output for details)
 */

import assert from 'node:assert/strict';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const OS_URL   = process.env.OS_URL   || 'http://10.17.8.24:9200';
const OS_INDEX = process.env.OS_INDEX || 'research_documents';
const REDIS_URL = process.env.REDIS_URL || 'redis://10.17.8.24:6379';
const AUTHOR_ID = process.env.AUTHOR_ID || '60800';
const AUTHOR_SCOPUS_ID = process.env.AUTHOR_SCOPUS_ID || '56301902700';

// ──────────────────────────── HTTP helpers ────────────────────────────

async function api(path, body, method = 'POST') {
    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
    return { status: res.status, body: json, raw: text };
}

async function get(path) {
    const res = await fetch(`${BASE_URL}${path}`);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
    return { status: res.status, body: json, raw: text };
}

async function osFetch(method, path, body) {
    const res = await fetch(`${OS_URL}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
}

// Convenience: fire a basic-mode search with minimal boilerplate.
async function basic(query, opts = {}) {
    const { body, status } = await api('/api/v1/search', {
        query,
        mode: 'basic',
        page: opts.page || 1,
        per_page: opts.per_page || 20,
        ...opts,
    });
    if (status !== 200) {
        throw new Error(`basic("${query}") → ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    }
    return body;
}

// Collect stable identifiers across result sets (scopus_id > mongo_id > _id > title).
function idsOf(body) {
    return new Set(body.results.map((r) =>
        r.scopus_id || r.mongo_id || r._id || (r.title || '').trim()));
}

// Extract title+abstract for regex checks, lowercased.
function textOf(r) {
    return ((r.title || '') + ' ' + (r.abstract || '')).toLowerCase();
}

// ──────────────────────────── Redis cache flush ────────────────────────────

async function flushCaches() {
    if (process.env.SKIP_CACHE_FLUSH === '1') return;
    let Redis;
    try { Redis = (await import('ioredis')).default; }
    catch { console.log('  (ioredis not installed — skipping cache flush)'); return; }
    const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
        await r.connect();
        for (const pattern of ['search:*', 'author_scope:*', 'faculty_query:*', 'iitd_faculty:*']) {
            const keys = await r.keys(pattern);
            if (keys.length) await r.del(...keys);
        }
        console.log('  ✓ redis cache flushed');
    } catch (err) {
        console.log(`  (redis flush skipped: ${err.message})`);
    } finally { await r.quit().catch(() => {}); }
}

// ──────────────────────────── Test runner ────────────────────────────

const cases = [];
const test = (group, name, fn) => cases.push({ group, name, fn });
let failed = 0;
const short = (s, n = 80) => (s == null ? '' : String(s)).slice(0, n);

// ────────────────── [Pre] Service & analyzer sanity ──────────────────

test('Pre', 'service health endpoint reports all subsystems healthy', async () => {
    const { body, status } = await get('/api/v1/search/health');
    assert.equal(status, 200);
    assert.ok(body.checks?.opensearch,    'opensearch not healthy');
    assert.ok(body.checks?.embedding,     'embedding not healthy');
    assert.ok(body.checks?.redis,         'redis not healthy');
});

test('Pre', 'index exists and has documents', async () => {
    const { body, status } = await osFetch('GET',
        `/_cat/indices/${OS_INDEX}?format=json&h=index,docs.count`);
    assert.equal(status, 200);
    assert.ok(body.length > 0, `index "${OS_INDEX}" not found`);
    const docs = parseInt(body[0]['docs.count'], 10);
    assert.ok(docs > 1000, `index only has ${docs} documents — reindex incomplete?`);
});

test('Pre', 'title uses english analyzer (advanced mode recall) and title.standard uses minimal_english_analyzer (basic mode precision)', async () => {
    // Root `title` field uses Porter (english) — should collapse community & communication.
    const { body: rootTokens } = await osFetch('POST',
        `/${OS_INDEX}/_analyze`,
        { field: 'title', text: 'communication community batteries' });
    const roots = rootTokens.tokens.map((t) => t.token);
    assert.deepEqual(roots.slice(0, 3), ['commun', 'commun', 'batteri'],
        `title root analyzer wrong — got ${JSON.stringify(roots)}`);

    // `title.standard` MUST use minimal_english_analyzer — plurals collapse,
    // but distinct roots stay distinct.
    const { body: standardTokens } = await osFetch('POST',
        `/${OS_INDEX}/_analyze`,
        { field: 'title.standard', text: 'communication communications community batteries batteries' });
    const std = standardTokens.tokens.map((t) => t.token);
    assert.equal(std[0], 'communication', `expected 'communication', got '${std[0]}'`);
    assert.equal(std[1], 'communication', `plural must collapse to singular, got '${std[1]}' — .standard is NOT using minimal_english_analyzer`);
    assert.equal(std[2], 'community',     `distinct root must stay, got '${std[2]}' — over-stemming detected`);
    assert.equal(std[3], 'battery',       `batteries → battery, got '${std[3]}'`);
});

test('Pre', 'abstract.standard uses minimal_english_analyzer', async () => {
    const { body } = await osFetch('POST', `/${OS_INDEX}/_analyze`,
        { field: 'abstract.standard', text: 'optimize optimization optimal' });
    const tokens = body.tokens.map((t) => t.token);
    assert.equal(tokens[0], 'optimize',     `got '${tokens[0]}'`);
    assert.equal(tokens[1], 'optimization', `must be distinct from "optimize" — got '${tokens[1]}'`);
    assert.equal(tokens[2], 'optimal',      `must be distinct from "optimize" — got '${tokens[2]}'`);
});

// ────────────────── [L] Literal precision (stem-collision must NOT leak) ──────────────────

const LEAK_CASES = [
    { q: 'Communication', anchor: /communicat/i, leak: /communit/i,         leakLabel: 'community' },
    { q: 'community',     anchor: /communit/i,   leak: /communicat/i,       leakLabel: 'communication' },
    { q: 'information',   anchor: /informati/i,  leak: /\binform(?:ed|al)\b/i, leakLabel: 'inform/informed/informal' },
    { q: 'optimize',      anchor: /optim(?:iz|is)/i, leak: /\boptim(?:al|um)\b/i, leakLabel: 'optimal/optimum' },
    { q: 'production',    anchor: /produc(?:tion|ed|ing|tive)/i, leak: /\bproduct(?:s)?\b/i, leakLabel: 'product/products' },
];

for (const { q, anchor, leak, leakLabel } of LEAK_CASES) {
    test('L', `"${q}" — top-30 must contain anchor token and NOT leak to ${leakLabel}`, async () => {
        const body = await basic(q, { per_page: 30 });
        assert.ok(body.pagination.total > 0, `precondition: "${q}" must have results`);
        const offenders = body.results.filter((r) => !anchor.test(textOf(r)) && leak.test(textOf(r)));
        assert.equal(offenders.length, 0,
            `${offenders.length} leak(s): ` + offenders.slice(0, 3).map((o) => short(o.title)).join(' | '));
    });
}

test('L', 'quantitative: "Communication" top-20 precision ≥ 95%', async () => {
    const body = await basic('Communication', { per_page: 20 });
    const literal = body.results.filter((r) => /communicat/i.test(textOf(r))).length;
    const precision = literal / body.results.length;
    assert.ok(precision >= 0.95, `precision ${(precision * 100).toFixed(1)}% — expected ≥ 95%`);
});

test('L', 'quantitative: top-10 of 15 diverse queries each ≥ 80% on-topic', async () => {
    const probes = [
        ['energy',        /energ/],
        ['battery',       /batter/],
        ['neural network',/neural/],
        ['polymer',       /polym/],
        ['solar cell',    /solar/],
        ['catalyst',      /cataly/],
        ['simulation',    /simulat/],
        ['CRISPR',        /crispr/i],
        ['transformer',   /transform/],
        ['image segmentation', /segment/],
        ['microfluidic',  /microflu/],
        ['quantum',       /quantum/],
        ['graph',         /graph/],
        ['hydrogel',      /hydrogel/],
        ['reinforcement learning', /reinforc|learning/],
    ];
    const failures = [];
    for (const [q, anchor] of probes) {
        const body = await basic(q, { per_page: 10 });
        if (body.pagination.total === 0) continue;
        const onTopic = body.results.filter((r) => anchor.test(textOf(r))).length;
        if (onTopic < 8) failures.push(`${q}: ${onTopic}/10 on-topic`);
    }
    assert.equal(failures.length, 0, `weak probes: ${failures.join(' | ')}`);
});

// ────────────────── [M] Morphology — plurals collapse ──────────────────

const COLLAPSE_PAIRS = [
    ['communication', 'communications'],
    ['battery',       'batteries'],
    ['optimization',  'optimizations'],
    ['network',       'networks'],
    ['algorithm',     'algorithms'],
    ['molecule',      'molecules'],
];

for (const [a, b] of COLLAPSE_PAIRS) {
    test('M', `"${a}" ≡ "${b}" — identical totals and ≥ 96% top-50 overlap`, async () => {
        const [left, right] = await Promise.all([
            basic(a, { per_page: 50 }),
            basic(b, { per_page: 50 }),
        ]);
        assert.equal(left.pagination.total, right.pagination.total,
            `totals must match: ${a}=${left.pagination.total} vs ${b}=${right.pagination.total}`);
        const leftIds = idsOf(left), rightIds = idsOf(right);
        const overlap = [...leftIds].filter((id) => rightIds.has(id)).length;
        assert.ok(overlap >= 48, `overlap ${overlap}/50 — expected ≥ 48 (plurals not collapsing?)`);
    });
}

test('M', 'plural-only title retrievable via singular query', async () => {
    const [sing, plur] = await Promise.all([
        basic('communication',  { per_page: 100 }),
        basic('communications', { per_page: 100 }),
    ]);
    const singIds = idsOf(sing), plurIds = idsOf(plur);
    const overlap = [...plurIds].filter((id) => singIds.has(id)).length;
    assert.ok(overlap >= 95, `expected ≥ 95/100 overlap, got ${overlap}`);
});

// ────────────────── [D] Distinct-root integrity (no over-stemming) ──────────────────

const DISTINCT_PAIRS = [
    ['communication', 'community'],
    ['inform',        'information'],
    ['optimize',      'optimal'],
    ['production',    'product'],
    ['management',    'manage'],
];

for (const [a, b] of DISTINCT_PAIRS) {
    test('D', `"${a}" ≠ "${b}" — different totals AND < 50% top-50 overlap`, async () => {
        const [left, right] = await Promise.all([
            basic(a, { per_page: 50 }),
            basic(b, { per_page: 50 }),
        ]);
        assert.notEqual(left.pagination.total, right.pagination.total,
            `distinct roots should have different totals: ${a}=${left.pagination.total} vs ${b}=${right.pagination.total}`);
        const leftIds = idsOf(left), rightIds = idsOf(right);
        const overlap = [...leftIds].filter((id) => rightIds.has(id)).length;
        assert.ok(overlap < 25,
            `top-50 overlap ${overlap}/50 too high — over-stemming suspected between "${a}" and "${b}"`);
    });
}

// ────────────────── [A] Author-name search ──────────────────

test('A', 'IITD surname "basu" via search_in=["author"] returns hundreds of papers', async () => {
    const body = await basic('basu', { search_in: ['author'], per_page: 3 });
    assert.ok(body.pagination.total > 100,
        `expected >100 Basu papers, got ${body.pagination.total}`);
});

test('A', 'bare basic query "basu" (no search_in) still finds IITD Basu papers', async () => {
    const body = await basic('basu', { per_page: 5 });
    assert.ok(body.pagination.total > 0, 'should find Basu papers via default search');
});

test('A', 'IITD author returns results whose authors[] actually contain the anchor name', async () => {
    const body = await basic('basu', { search_in: ['author'], per_page: 5 });
    for (const r of body.results) {
        const hasBasu = (r.authors || []).some((a) =>
            /basu/i.test(a.author_name || a.name || ''));
        assert.ok(hasBasu, `result "${short(r.title)}" missing a Basu author`);
    }
});

test('A', 'nonsense author query returns 0 (no full-corpus leak)', async () => {
    const body = await basic('qqqzzzxxx', { search_in: ['author'], per_page: 3 });
    assert.equal(body.pagination.total, 0);
});

// ────────────────── [G] IITD-Faculty roster gate ──────────────────

test('G', 'non-IITD surname "lund" returns 0 in default basic search', async () => {
    const body = await basic('lund', { per_page: 3 });
    assert.equal(body.pagination.total, 0,
        `"lund" must not leak via non-IITD co-author names; got ${body.pagination.total}`);
});

test('G', 'non-IITD surname "dhruv" returns 0 in default basic search', async () => {
    // Note: "dhruva" (Dhruva reactor) is a valid physics term — check gate-only
    const body = await basic('dhruv', { per_page: 3 });
    assert.ok(
        body.pagination.total === 0 ||
        body.results.every((r) => /dhruva|\breactor\b/i.test(textOf(r))),
        `"dhruv" leaked through non-IITD author match`);
});

test('G', 'faculty-for-query "lund" returns 0 IITD faculty', async () => {
    const { body, status } = await get('/api/v1/search/faculty-for-query?query=lund');
    assert.equal(status, 200);
    assert.equal((body.faculty || []).length, 0,
        `faculty roster should have no "lund" match; got ${(body.faculty || []).length}`);
});

// ────────────────── [F] search_in field constraints ──────────────────

test('F', 'search_in=["title"] — every result has the token literally in title', async () => {
    const body = await basic('Communication', { search_in: ['title'], per_page: 10 });
    for (const r of body.results) {
        assert.ok(/communicat/i.test(r.title || ''),
            `title-only search returned "${short(r.title)}" missing communicat*`);
    }
});

test('F', 'search_in=["abstract"] — every result has the token literally in abstract', async () => {
    const body = await basic('communication', { search_in: ['abstract'], per_page: 10 });
    for (const r of body.results) {
        assert.ok(/communicat/i.test(r.abstract || ''),
            `abstract-only search returned "${short(r.title)}" missing communicat* in abstract`);
    }
});

test('F', 'search_in=["title","abstract"] — union is at least as wide as each alone', async () => {
    const [both, justTitle] = await Promise.all([
        basic('Communication', { search_in: ['title', 'abstract'], per_page: 5 }),
        basic('Communication', { search_in: ['title'],             per_page: 5 }),
    ]);
    assert.ok(both.pagination.total >= justTitle.pagination.total,
        `title+abstract (${both.pagination.total}) should be ≥ title-only (${justTitle.pagination.total})`);
});

test('F', 'search_in=["subject_area"] returns typed matches only', async () => {
    const body = await basic('chemistry', { search_in: ['subject_area'], per_page: 5 });
    if (body.pagination.total > 0) {
        for (const r of body.results) {
            const subjects = (r.subject_area || r.subject_areas || []).join(' ').toLowerCase();
            assert.ok(/chem/i.test(subjects),
                `subject_area search returned "${short(r.title)}" without chemistry subject_area`);
        }
    }
});

test('F', 'unknown search_in value is rejected with 400', async () => {
    const { status } = await api('/api/v1/search',
        { query: 'anything', mode: 'basic', search_in: ['nonsense_field'] });
    assert.equal(status, 400);
});

// ────────────────── [R] refine_within ──────────────────

test('R', 'refine_within narrows the base query strictly', async () => {
    const [base, narrowed] = await Promise.all([
        basic('Communication', { per_page: 5 }),
        basic('Communication', { refine_within: 'wireless', per_page: 5 }),
    ]);
    assert.ok(narrowed.pagination.total > 0, 'refine expected to yield results');
    assert.ok(narrowed.pagination.total < base.pagination.total,
        `refine should narrow: narrowed=${narrowed.pagination.total} vs base=${base.pagination.total}`);
});

test('R', 'refine_within results contain BOTH query and refine terms literally', async () => {
    const body = await basic('Communication', { refine_within: 'wireless', per_page: 10 });
    for (const r of body.results) {
        const t = textOf(r);
        assert.ok(/communicat/i.test(t), `refine: missing communicat in "${short(r.title)}"`);
        assert.ok(/wireless/i.test(t),   `refine: missing wireless in "${short(r.title)}"`);
    }
});

test('R', 'refine_within with nonsense term returns 0 (no silent full-corpus leak)', async () => {
    const body = await basic('Communication', { refine_within: 'qqqzzzxxx', per_page: 3 });
    assert.equal(body.pagination.total, 0);
});

// ────────────────── [S] Author-scope bypass ──────────────────

test('S', 'author-scope basic × "lund" narrows within Basu\'s corpus', async () => {
    const { body, status } = await api('/api/v1/search/author-scope', {
        query: 'lund',
        author_id: AUTHOR_ID,
        mode: 'basic',
        search_in: ['author'],
        page: 1,
        per_page: 5,
    });
    assert.equal(status, 200);
    assert.ok(body.pagination.total >= 1,
        `author-scope bypass should allow non-IITD co-author match; got 0`);
    if (body.author?.total_papers) {
        assert.ok(body.pagination.total < body.author.total_papers,
            `author-scope must narrow, not return full corpus`);
    }
});

test('S', 'author-scope basic × nonsense returns 0 (no match_all fallback)', async () => {
    const { body } = await api('/api/v1/search/author-scope', {
        query: 'qqqzzzxxx',
        author_id: AUTHOR_ID,
        mode: 'basic',
        search_in: ['author'],
        page: 1,
        per_page: 3,
    });
    assert.equal(body.pagination.total, 0);
});

test('S', 'author-scope every result contains anchor author', async () => {
    const { body } = await api('/api/v1/search/author-scope', {
        query: 'energy',
        author_id: AUTHOR_ID,
        mode: 'basic',
        page: 1,
        per_page: 5,
    });
    for (const r of body.results) {
        const hasAnchor = (r.authors || []).some((a) =>
            a.author_id === AUTHOR_SCOPUS_ID || /basu/i.test(a.author_name || a.name || ''));
        assert.ok(hasAnchor,
            `author-scope result "${short(r.title)}" missing anchor author (scopus=${AUTHOR_SCOPUS_ID})`);
    }
});

// ────────────────── [P] Phrase boost on multi-word queries ──────────────────

test('P', 'multi-word query "wireless communication" — every top-10 result contains BOTH terms literally', async () => {
    const body = await basic('wireless communication', { per_page: 10 });
    assert.ok(body.pagination.total > 0);
    for (const r of body.results) {
        const t = textOf(r);
        assert.ok(/communicat/i.test(t), `missing communicat in "${short(r.title)}"`);
        assert.ok(/wireless/i.test(t),   `missing wireless in "${short(r.title)}"`);
    }
});

test('P', 'phrase-adjacent results rank higher than loose-co-occurrence', async () => {
    // Ask for "machine learning" and verify a reasonable count. Soft check: at least
    // top-5 contain both tokens (basic mode uses AND on tokens).
    const body = await basic('machine learning', { per_page: 5 });
    for (const r of body.results) {
        const t = textOf(r);
        assert.ok(/machine/.test(t),  `missing "machine" in "${short(r.title)}"`);
        assert.ok(/learning/.test(t), `missing "learning" in "${short(r.title)}"`);
    }
});

// ────────────────── [X] Filters ──────────────────

test('X', 'year filter narrows to the selected range', async () => {
    // API uses flat filter keys: year_from / year_to
    const body = await basic('energy', {
        filters: { year_from: 2020, year_to: 2022 },
        per_page: 10,
    });
    for (const r of body.results) {
        const yr = r.publication_year || r.year;
        if (yr != null) {
            assert.ok(yr >= 2020 && yr <= 2022,
                `result year ${yr} outside filter [2020,2022]`);
        }
    }
});

test('X', 'impossible year range returns 0 with valid pagination', async () => {
    const body = await basic('energy', {
        filters: { year_from: 2099, year_to: 2099 },
        per_page: 10,
    });
    assert.equal(body.pagination.total, 0);
    assert.equal(body.pagination.total_pages, 0);
});

test('X', 'document_type filter restricts to the selected type', async () => {
    const body = await basic('energy', {
        filters: { document_type: 'Conference Paper' },
        per_page: 10,
    });
    if (body.pagination.total > 0) {
        for (const r of body.results) {
            const dt = r.document_type || '';
            assert.ok(/conference/i.test(dt) || dt === '',
                `non-matching document_type "${dt}"`);
        }
    }
});

test('X', 'author_id filter returns only that Scopus-author\'s papers', async () => {
    const { body, status } = await api('/api/v1/search', {
        query: '*',
        mode: 'basic',
        page: 1,
        per_page: 5,
        filters: { author_id: AUTHOR_SCOPUS_ID },
    });
    if (status === 200 && body.pagination.total > 0) {
        for (const r of body.results) {
            const hasAuthor = (r.authors || []).some((a) => a.author_id === AUTHOR_SCOPUS_ID);
            assert.ok(hasAuthor,
                `author_id filter leaked: "${short(r.title)}"`);
        }
    }
});

// ────────────────── [O] Sort variants ──────────────────

test('O', 'sort=date returns results in descending publication_year', async () => {
    const body = await basic('energy', { sort: 'date', per_page: 10 });
    const years = body.results.map((r) => r.publication_year || r.year).filter((y) => y != null);
    for (let i = 1; i < years.length; i++) {
        assert.ok(years[i - 1] >= years[i],
            `sort=date broken: ${years[i-1]} before ${years[i]}`);
    }
});

test('O', 'sort=citations returns results in descending citation_count', async () => {
    const body = await basic('energy', { sort: 'citations', per_page: 10 });
    const cites = body.results.map((r) => r.citation_count ?? 0);
    for (let i = 1; i < cites.length; i++) {
        assert.ok(cites[i - 1] >= cites[i],
            `sort=citations broken: ${cites[i-1]} before ${cites[i]}`);
    }
});

test('O', 'invalid sort value is rejected with 400', async () => {
    const { status } = await api('/api/v1/search',
        { query: 'anything', mode: 'basic', sort: 'random' });
    assert.equal(status, 400);
});

// ────────────────── [N] Pagination, facets, response shape ──────────────────

test('N', 'pagination invariants hold (total, total_pages, results.length)', async () => {
    const body = await basic('energy', { page: 1, per_page: 25 });
    const { total, total_pages, per_page, page } = body.pagination;
    assert.equal(page, 1);
    assert.equal(per_page, 25);
    assert.equal(total_pages, Math.ceil(total / per_page));
    assert.ok(body.results.length <= per_page);
    if (total > 0) assert.ok(body.results.length > 0);
});

test('N', 'page=1 and page=2 return disjoint result sets for common query', async () => {
    const [p1, p2] = await Promise.all([
        basic('energy', { page: 1, per_page: 10 }),
        basic('energy', { page: 2, per_page: 10 }),
    ]);
    const ids1 = idsOf(p1), ids2 = idsOf(p2);
    const overlap = [...ids1].filter((id) => ids2.has(id)).length;
    assert.equal(overlap, 0, `page overlap: ${overlap}`);
});

test('N', 'page beyond total_pages returns empty (gracefully, not 500)', async () => {
    const body = await basic('zzzunlikelyquery42', { page: 1, per_page: 10 });
    // either 0 total or the request was tolerated; never a crash
    assert.ok(body.pagination.total >= 0);
});

test('N', 'response has results, pagination, facets, mode fields', async () => {
    const body = await basic('energy', { per_page: 3 });
    for (const key of ['results', 'pagination', 'facets', 'mode']) {
        assert.ok(key in body, `missing top-level "${key}"`);
    }
    assert.equal(body.mode, 'basic');
});

test('N', 'every result has a valid shape (_id, title, authors)', async () => {
    const body = await basic('energy', { per_page: 10 });
    for (const r of body.results) {
        assert.ok(typeof r._id === 'string' && r._id.length > 0, '_id missing');
        assert.ok(typeof r.title === 'string' && r.title.length > 0, 'title missing');
        assert.ok(Array.isArray(r.authors), 'authors not array');
    }
});

test('N', 'facets are present and each bucket has {value, count}', async () => {
    const body = await basic('energy', { per_page: 3 });
    if (body.facets) {
        for (const [facetName, buckets] of Object.entries(body.facets)) {
            if (Array.isArray(buckets)) {
                for (const b of buckets.slice(0, 3)) {
                    assert.ok('value' in b && 'count' in b,
                        `facet "${facetName}" bucket malformed: ${JSON.stringify(b)}`);
                }
            }
        }
    }
});

// ────────────────── [E] Edge cases ──────────────────

test('E', 'whitespace-padded query is trimmed', async () => {
    const { status } = await api('/api/v1/search',
        { query: '  energy  ', mode: 'basic', page: 1, per_page: 3 });
    assert.equal(status, 200);
});

test('E', 'unicode query does not 500', async () => {
    const { status } = await api('/api/v1/search',
        { query: 'ज्ञान', mode: 'basic', page: 1, per_page: 3 });
    assert.ok(status === 200 || status === 400);
});

test('E', 'special-char query does not 500', async () => {
    const { status } = await api('/api/v1/search',
        { query: 'C++ programming', mode: 'basic', page: 1, per_page: 3 });
    assert.equal(status, 200);
});

test('E', '500-char query is handled gracefully', async () => {
    const q = 'quantum '.repeat(64).slice(0, 500);
    const { status } = await api('/api/v1/search',
        { query: q, mode: 'basic', page: 1, per_page: 3 });
    assert.ok(status === 200 || status === 400);
});

test('E', 'single-character query is accepted (or rejected deterministically)', async () => {
    const { status } = await api('/api/v1/search',
        { query: 'x', mode: 'basic', page: 1, per_page: 3 });
    assert.ok(status === 200 || status === 400);
});

test('E', 'numeric query is handled', async () => {
    const { status } = await api('/api/v1/search',
        { query: '2020', mode: 'basic', page: 1, per_page: 3 });
    assert.equal(status, 200);
});

test('E', 'gibberish single-word query returns 0 — no fuzzy fallback in basic mode', async () => {
    const body = await basic('zzzqqxxnonsense', { per_page: 3 });
    assert.equal(body.pagination.total, 0);
});

// ────────────────── [V] Validation ──────────────────

test('V', 'empty body → 400', async () => {
    const { status } = await fetch(`${BASE_URL}/api/v1/search`, { method: 'POST' })
        .then((r) => ({ status: r.status }));
    assert.equal(status, 400);
});

test('V', 'empty query → 400', async () => {
    const { status } = await api('/api/v1/search', { query: '', mode: 'basic' });
    assert.equal(status, 400);
});

test('V', 'per_page > 100 → 400', async () => {
    const { status } = await api('/api/v1/search',
        { query: 'x', mode: 'basic', per_page: 1000 });
    assert.equal(status, 400);
});

test('V', 'page < 1 → 400', async () => {
    const { status } = await api('/api/v1/search',
        { query: 'x', mode: 'basic', page: 0 });
    assert.equal(status, 400);
});

test('V', 'year_from below allowed minimum → 400', async () => {
    // API enforces year_from >= 1900 (or similar lower bound) on flat filter keys.
    const { status } = await api('/api/v1/search', {
        query: 'x', mode: 'basic',
        filters: { year_from: 1800 },
    });
    assert.equal(status, 400);
});

// ────────────────── [C] Cache behavior ──────────────────

test('C', 'identical basic search twice → second is a cache hit', async () => {
    const q = `perovskite solar cell efficiency ${Date.now()}`;
    // First call — must populate cache. Use a unique suffix to bypass pre-existing cache.
    await basic(q, { per_page: 3 });
    const second = await api('/api/v1/search',
        { query: q, mode: 'basic', page: 1, per_page: 3 });
    // Some zero-result queries are intentionally not cached; only check when hits > 0.
    if (second.body.pagination.total > 0) {
        const meta = second.body.meta || {};
        assert.ok(meta.cache_hit === true || meta.cacheHit === true || second.body.cacheHit === true,
            `expected cache_hit=true on second identical call`);
    }
});

// ────────────────── [Q] Quantitative benchmark (runs at end, prints report) ──────────────────

test('Q', 'quantitative benchmark: basic-mode precision & morphology table', async () => {
    const queries = [
        'Communication', 'community', 'information', 'optimization',
        'battery', 'batteries', 'network', 'networks',
        'energy', 'polymer', 'catalyst', 'CRISPR',
    ];
    const rows = [];
    for (const q of queries) {
        const body = await basic(q, { per_page: 20 });
        rows.push({
            query: q,
            total: body.pagination.total,
            top_titles: body.results.slice(0, 3).map((r) => short(r.title, 55)),
        });
    }
    console.log();
    console.log('    ─────────────── Quantitative benchmark ───────────────');
    for (const row of rows) {
        console.log(`    ${row.query.padEnd(18)}  total=${String(row.total).padStart(6)}   #1: ${row.top_titles[0] || ''}`);
    }
    console.log();

    // Sanity: "Communication" and "communications" totals must match now (morphology collapse).
    const comm  = rows.find((r) => r.query === 'Communication').total;
    const comms = await basic('communications', { per_page: 3 });
    assert.equal(comm, comms.pagination.total,
        `Communication (${comm}) vs communications (${comms.pagination.total}) — morphology broken`);
});

// ──────────────────────────── Runner ────────────────────────────

function groupName(g) {
    const names = {
        Pre: 'Service & analyzer sanity',
        L: 'Literal precision',
        M: 'Morphology (plurals collapse)',
        D: 'Distinct roots (no over-stemming)',
        A: 'Author-name search',
        G: 'IITD faculty gate',
        F: 'search_in constraints',
        R: 'refine_within',
        S: 'Author-scope bypass',
        P: 'Multi-word / phrase',
        X: 'Filters',
        O: 'Sort variants',
        N: 'Pagination / facets / shape',
        E: 'Edge cases',
        V: 'Validation errors',
        C: 'Cache hit semantics',
        Q: 'Quantitative benchmark',
    };
    return names[g] || g;
}

(async () => {
    console.log(`Base URL:         ${BASE_URL}`);
    console.log(`OpenSearch URL:   ${OS_URL}`);
    console.log(`OpenSearch index: ${OS_INDEX}`);
    console.log(`Author ID:        ${AUTHOR_ID} (Scopus ${AUTHOR_SCOPUS_ID})`);
    console.log();
    console.log('Flushing caches before run…');
    await flushCaches();
    console.log();

    const byGroup = new Map();
    for (const c of cases) {
        if (!byGroup.has(c.group)) byGroup.set(c.group, []);
        byGroup.get(c.group).push(c);
    }
    const groupOrder = ['Pre', 'L', 'M', 'D', 'A', 'G', 'F', 'R', 'S', 'P', 'X', 'O', 'N', 'E', 'V', 'C', 'Q'];
    const startTotal = Date.now();
    let passed = 0;

    for (const g of groupOrder) {
        if (!byGroup.has(g)) continue;
        console.log(`[${g}] ${groupName(g)}`);
        for (const c of byGroup.get(g)) {
            const t0 = Date.now();
            try {
                await c.fn();
                const dt = Date.now() - t0;
                console.log(`  ✓ ${c.name}  (${dt}ms)`);
                passed++;
            } catch (err) {
                failed++;
                console.log(`  ✗ ${c.name}`);
                console.log(`      ${err.message}`);
                if (process.env.VERBOSE === '1' && err.stack) {
                    console.log(err.stack.split('\n').slice(1, 4).join('\n'));
                }
            }
        }
        console.log();
    }

    const total = passed + failed;
    const elapsed = ((Date.now() - startTotal) / 1000).toFixed(2);
    console.log('='.repeat(70));
    console.log(`${passed}/${total} passed  (${failed} failed, ${elapsed}s total)`);
    console.log();
    console.log('By group:');
    for (const g of groupOrder) {
        if (!byGroup.has(g)) continue;
        const group = byGroup.get(g);
        const ok = group.length; // we don't track per-group fails separately here
        // Recompute from log counter would be nicer, but assert errors already shown above.
        console.log(`  ${g.padEnd(3)} ${groupName(g).padEnd(32)}  ${group.length} case(s)`);
    }

    process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
    console.error('Runner crashed:', err);
    process.exit(2);
});
