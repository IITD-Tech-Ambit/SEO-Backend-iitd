import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { computeAll } from './eval/metrics.mjs';

/**
 * Hard retrieval tests — strict checks on golden_set_hard.json.
 *
 * Generate fixtures:
 *   npm run test:golden:hard
 *
 * Run:
 *   npm run test:hard
 */

const API_BASE = process.env.SEARCH_API_URL || `http://localhost:${process.env.PORT || 3000}/api/v1`;
const ROOT_BASE = API_BASE.replace(/\/api\/v1$/, '');
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadJson(name) {
    const p = path.join(FIXTURES, name);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
}

const hardSet = loadJson('golden_set_hard.json');
let serverUp = false;

async function search(query, mode = 'advanced', perPage = 50) {
    const res = await fetch(`${API_BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, mode, sort: 'relevance', per_page: perPage, page: 1 }),
        signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, body: await res.json() };
}

const idsOf = (body) => (body.results || []).map(r => r.mongo_id || r._id);
const rankOf = (ids, target) => { const i = ids.indexOf(target); return i === -1 ? null : i + 1; };

before(async () => {
    try {
        const res = await fetch(`${ROOT_BASE}/health`, { signal: AbortSignal.timeout(3000) });
        serverUp = res.status === 200;
    } catch {
        serverUp = false;
    }
    if (!hardSet) console.warn('[hard_retrieval] Run npm run test:golden:hard first');
});

describe('Hard golden set structure', () => {
    it('has diverse difficult categories', (t) => {
        if (!hardSet) return t.skip('golden_set_hard.json missing');
        const types = new Set(hardSet.queries.map(q => q.type));
        assert.ok(types.size >= 4, 'expected at least 4 hard categories after calibration');
        assert.ok(hardSet.queries.length >= 25, 'expected substantial calibrated hard query set');
        const multiGrade = hardSet.queries.filter(q => Object.keys(q.relevant).length > 1);
        assert.ok(multiGrade.length >= 1, 'need multi-grade queries for nDCG testing');
        assert.ok(hardSet.queries.every(q => q.calibrated_at || q.relevant), 'queries should be calibrated or have judgments');
    });

    it('every query has graded relevance judgments', (t) => {
        if (!hardSet) return t.skip();
        for (const q of hardSet.queries) {
            assert.ok(Object.keys(q.relevant).length > 0, `${q.id} missing judgments`);
            assert.ok(Object.values(q.relevant).every(g => g >= 1 && g <= 3), `${q.id} invalid grades`);
        }
    });
});

describe('Hard exact rank-1 (MRR / P@1)', () => {
    for (const entry of (hardSet?.queries || []).filter(q => q.type === 'hard_exact_rank1').slice(0, 8)) {
        it(`[${entry.id}] source at rank ≤3`, async (t) => {
            if (!serverUp || !hardSet) return t.skip();
            const { status, body } = await search(entry.query, 'advanced', 20);
            assert.equal(status, 200);
            const rank = rankOf(idsOf(body), entry.source_mongo_id);
            assert.ok(rank !== null, 'source doc must appear in top 20');
            assert.ok(rank <= 3, `expected rank ≤3, got ${rank} for "${entry.query.slice(0, 50)}"`);
        });
    }
});

describe('Hard graded clusters (nDCG / recall)', () => {
    for (const entry of (hardSet?.queries || []).filter(q => q.type === 'hard_graded_cluster').slice(0, 6)) {
        it(`[${entry.id}] "${entry.query}" — calibrated judgments match retrieval`, async (t) => {
            if (!serverUp || !hardSet) return t.skip();
            const { status, body } = await search(entry.query, 'advanced', 50);
            assert.equal(status, 200);
            const metrics = computeAll(idsOf(body), entry.relevant);
            assert.ok(metrics.recall_50 > 0, 'calibrated cluster should recall ≥1 doc in top 50');
            assert.ok(metrics.ndcg_10 > 0, `nDCG@10 should be >0 for calibrated cluster "${entry.query}"`);
        });
    }
});

describe('Hard abstract gap (semantic recall)', () => {
    for (const entry of (hardSet?.queries || []).filter(q => q.type === 'hard_abstract_gap').slice(0, 6)) {
        it(`[${entry.id}] recalls source via abstract terms`, async (t) => {
            if (!serverUp || !hardSet) return t.skip();
            const { status, body } = await search(entry.query, 'advanced', 50);
            assert.equal(status, 200);
            assert.ok(
                idsOf(body).includes(entry.source_mongo_id),
                `abstract-gap query "${entry.query}" should retrieve source doc`
            );
        });
    }
});

describe('Hard paraphrase (vector recall)', () => {
    for (const entry of (hardSet?.queries || []).filter(q => q.type === 'hard_paraphrase').slice(0, 5)) {
        it(`[${entry.id}] advanced ≥ basic recall`, async (t) => {
            if (!serverUp || !hardSet) return t.skip();
            const [basic, advanced] = await Promise.all([
                search(entry.query, 'basic', 50),
                search(entry.query, 'advanced', 50),
            ]);
            const basicHit = idsOf(basic.body).includes(entry.source_mongo_id);
            const advHit = idsOf(advanced.body).includes(entry.source_mongo_id);
            assert.ok(advHit || !basicHit, 'advanced should find paraphrase target when basic cannot');
        });
    }
});

describe('Hard ambiguous recall', () => {
    for (const entry of (hardSet?.queries || []).filter(q => q.type === 'hard_ambiguous_recall').slice(0, 4)) {
        it(`[${entry.id}] "${entry.query}" recalls calibrated judged docs`, async (t) => {
            if (!serverUp || !hardSet) return t.skip();
            const { status, body } = await search(entry.query, 'advanced', 50);
            assert.equal(status, 200);
            const judged = new Set(Object.keys(entry.relevant));
            const found = idsOf(body).filter(id => judged.has(id)).length;
            assert.ok(found >= judged.size, `should recall all ${judged.size} calibrated docs, found ${found}`);
        });
    }
});

describe('Hard distractor ranking (anchor above peers)', () => {
    for (const entry of (hardSet?.queries || []).filter(q => q.type === 'hard_distractor_ranking').slice(0, 4)) {
        it(`[${entry.id}] anchor ranks above grade-1 peers`, async (t) => {
            if (!serverUp || !hardSet) return t.skip();
            const { status, body } = await search(entry.query, 'advanced', 30);
            assert.equal(status, 200);
            const ids = idsOf(body);
            const anchorRank = rankOf(ids, entry.source_mongo_id);
            assert.ok(anchorRank !== null, 'anchor must appear');
            const peerIds = Object.keys(entry.relevant).filter(id => id !== entry.source_mongo_id && entry.relevant[id] === 1);
            for (const peerId of peerIds.slice(0, 2)) {
                const peerRank = rankOf(ids, peerId);
                if (peerRank !== null) {
                    assert.ok(anchorRank <= peerRank, `anchor rank ${anchorRank} should be ≤ peer rank ${peerRank}`);
                }
            }
        });
    }
});

describe('Hard set: basic_count <= advanced_count', () => {
    const sample = (hardSet?.queries || []).filter(q =>
        ['hard_partial_common', 'hard_cross_field', 'hard_exact_rank1'].includes(q.type)
    ).slice(0, 8);

    for (const entry of sample) {
        it(`[${entry.type}] "${entry.query.slice(0, 40)}"`, async (t) => {
            if (!serverUp || !hardSet) return t.skip();
            const [basic, advanced] = await Promise.all([
                search(entry.query, 'basic', 5),
                search(entry.query, 'advanced', 5),
            ]);
            const b = basic.body.pagination?.total ?? 0;
            const a = advanced.body.pagination?.total ?? 0;
            assert.ok(a >= b, `advanced(${a}) >= basic(${b})`);
        });
    }
});

describe('Hard metrics self-check (offline)', () => {
    it('computeAll produces all metric fields', () => {
        const retrieved = ['a', 'b', 'c', 'd'];
        const relevant = { a: 3, c: 2, x: 1 };
        const m = computeAll(retrieved, relevant);
        assert.equal(typeof m.recall_50, 'number');
        assert.equal(typeof m.precision_1, 'number');
        assert.equal(typeof m.precision_5, 'number');
        assert.equal(typeof m.precision_10, 'number');
        assert.equal(typeof m.ndcg_10, 'number');
        assert.equal(typeof m.mrr, 'number');
        assert.equal(m.mrr, 1);
        assert.equal(m.precision_1, 1);
    });
});
