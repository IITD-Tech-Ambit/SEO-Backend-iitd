import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Corpus-aligned retrieval tests.
 *
 * Uses golden_set_comprehensive.json generated from test_corpus.json via:
 *   npm run test:dump && npm run test:golden
 *
 * Skips gracefully when fixtures or API are unavailable.
 */

const API_BASE = process.env.SEARCH_API_URL || `http://localhost:${process.env.PORT || 3000}/api/v1`;
const ROOT_BASE = API_BASE.replace(/\/api\/v1$/, '');
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadJson(name) {
    const p = path.join(FIXTURES, name);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
}

const goldenSet = loadJson('golden_set_comprehensive.json');
const corpus = loadJson('test_corpus.json');

let serverUp = false;

async function post(body) {
    const res = await fetch(`${API_BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, body: await res.json() };
}

const totalOf = (body) => body.pagination?.total ?? -1;
const idsOf = (body) => (body.results || []).map(r => r.mongo_id || r._id);

before(async () => {
    try {
        const res = await fetch(`${ROOT_BASE}/health`, { signal: AbortSignal.timeout(3000) });
        serverUp = res.status === 200;
    } catch {
        serverUp = false;
    }
    if (!serverUp) console.warn('[corpus_retrieval] API not reachable — tests will skip.');
    if (!goldenSet) console.warn('[corpus_retrieval] golden_set_comprehensive.json missing — run npm run test:dump');
});

describe('Corpus golden set prerequisites', () => {
    it('fixture files exist', (t) => {
        if (!goldenSet) return t.skip('Run npm run test:dump to generate fixtures');
        assert.ok(goldenSet.queries.length >= 30, 'expected a substantial golden set');
        assert.ok(goldenSet.queries.every(q => Object.keys(q.relevant).length > 0), 'every query needs judgments');
    });
});

describe('Exact title queries recall the source document', () => {
    for (const entry of (goldenSet?.queries || []).filter(q => q.type === 'exact_title').slice(0, 15)) {
        it(`[${entry.id}] "${entry.query.slice(0, 40)}..."`, async (t) => {
            if (!serverUp || !goldenSet) return t.skip('fixtures or API unavailable');
            const { status, body } = await post({
                query: entry.query,
                mode: 'advanced',
                per_page: 20,
            });
            assert.equal(status, 200);
            assert.ok(
                idsOf(body).includes(entry.source_mongo_id),
                `source doc ${entry.source_mongo_id} should appear in top 20`
            );
        });
    }
});

describe('Partial title queries recall the source document', () => {
    for (const entry of (goldenSet?.queries || []).filter(q => q.type === 'partial_title').slice(0, 10)) {
        it(`[${entry.id}] "${entry.query}"`, async (t) => {
            if (!serverUp || !goldenSet) return t.skip('fixtures or API unavailable');
            const { status, body } = await post({
                query: entry.query,
                mode: 'advanced',
                per_page: 50,
            });
            assert.equal(status, 200);
            assert.ok(
                idsOf(body).includes(entry.source_mongo_id),
                `source doc should appear in top 50 for "${entry.query}"`
            );
        });
    }
});

describe('Corpus queries: basic_total <= advanced_total', () => {
    const byType = {};
    for (const q of goldenSet?.queries || []) {
        if (!byType[q.type]) byType[q.type] = q;
    }
    for (const entry of Object.values(byType)) {
        it(`[${entry.type}] "${entry.query.slice(0, 50)}"`, async (t) => {
            if (!serverUp || !goldenSet) return t.skip('fixtures or API unavailable');
            const [basic, advanced] = await Promise.all([
                post({ query: entry.query, mode: 'basic', per_page: 5 }),
                post({ query: entry.query, mode: 'advanced', per_page: 5 }),
            ]);
            assert.equal(basic.status, 200);
            assert.equal(advanced.status, 200);
            assert.ok(
                totalOf(advanced.body) >= totalOf(basic.body),
                `advanced(${totalOf(advanced.body)}) >= basic(${totalOf(basic.body)})`
            );
        });
    }
});

describe('Corpus field queries return results', () => {
    for (const entry of (goldenSet?.queries || []).filter(q => q.type === 'field_broad').slice(0, 5)) {
        it(`"${entry.query}" returns ≥ expected_min_results`, async (t) => {
            if (!serverUp || !goldenSet) return t.skip('fixtures or API unavailable');
            const { status, body } = await post({
                query: entry.query,
                mode: 'advanced',
                per_page: 10,
            });
            assert.equal(status, 200);
            const min = entry.expected_min_results ?? 1;
            assert.ok(totalOf(body) >= min, `"${entry.query}" should return at least ${min}`);
        });
    }
});

describe('Multi-relevant topic clusters return lexically matching results', () => {
    for (const entry of (goldenSet?.queries || []).filter(q => q.type === 'multi_relevant').slice(0, 5)) {
        it(`[${entry.id}] "${entry.query}" returns title matches`, async (t) => {
            if (!serverUp || !goldenSet) return t.skip('fixtures or API unavailable');
            const { status, body } = await post({
                query: entry.query,
                mode: 'advanced',
                per_page: 50,
            });
            assert.equal(status, 200);
            assert.ok(totalOf(body) >= 2, `"${entry.query}" should match multiple docs in the index`);
            const [w1, w2] = entry.query.toLowerCase().split(/\s+/);
            const lexicalHits = (body.results || []).filter(r => {
                const text = `${r.title || ''} ${r.abstract || ''}`.toLowerCase();
                return text.includes(w1) && text.includes(w2);
            }).length;
            assert.ok(
                lexicalHits >= 1,
                `"${entry.query}" should return at least one result containing both cluster terms`
            );
        });
    }
});

describe('Gibberish tokens absent from corpus return 0', () => {
    it('corpus has absent tokens for gibberish tests', (t) => {
        if (!corpus) return t.skip('test_corpus.json missing');
        const corpusText = corpus.documents
            .map(d => `${d.title || ''} ${d.abstract || ''}`.toLowerCase())
            .join(' ');
        const candidates = ['qxzxqv', 'zzyyxxww', 'mnbvcxzq', 'plokijuhyg'];
        assert.ok(candidates.some(tok => !corpusText.includes(tok)), 'need absent tokens');
    });

    for (const q of ['qxzxqv', 'zzyyxxww', 'mnbvcxzq']) {
        it(`advanced "${q}" → 0 results`, async (t) => {
            if (!serverUp) return t.skip('API not reachable');
            const { status, body } = await post({ query: q, mode: 'advanced', per_page: 5 });
            assert.equal(status, 200);
            assert.equal(totalOf(body), 0, `"${q}" should not match anything`);
        });
    }
});
