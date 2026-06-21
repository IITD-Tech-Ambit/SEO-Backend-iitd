import { test } from 'node:test';
import assert from 'node:assert/strict';
import RerankService from '../../src/services/search/RerankService.js';

const noopLogger = { warn() {}, info() {} };

function makeRedis() {
    return {
        mget: async (...keys) => new Array(keys.length).fill(null),
        pipeline: () => ({ setex() { return this; }, exec: async () => {} })
    };
}

function makeReranker(scoresByIndex) {
    return {
        embeddingService: { rerank: async (_q, docs) => docs.map((_, i) => ({ index: i, score: scoresByIndex[i] })) },
        redis: makeRedis(),
        logger: noopLogger
    };
}

test('rerank fuses first-stage score and strips the internal field', async () => {
    const deps = makeReranker([0, 5]);
    const svc = new RerankService({ ...deps, rerankConfig: { fusionAlpha: 0.7 } });
    const results = [
        { mongo_id: 'a', title: 'alpha', abstract: '', _firstStageScore: 10 },
        { mongo_id: 'b', title: 'beta', abstract: '', _firstStageScore: 1 }
    ];
    const { results: out, reranked } = await svc.rerank('zzz query', results);

    assert.equal(reranked, true);
    // b has the dominant rerank score; with alpha=0.7 it still wins despite a's lexical edge.
    assert.equal(out[0].mongo_id, 'b');
    assert.ok(typeof out[0].fused_score === 'number');
    assert.ok(typeof out[0].rerank_score === 'number');
    for (const r of out) assert.ok(!('_firstStageScore' in r), 'internal field must not leak');
});

test('literal title match is pinned above an equal-rerank distractor', async () => {
    const deps = makeReranker([3, 3]);
    const svc = new RerankService({ ...deps, rerankConfig: { fusionAlpha: 0.7, literalTitleBonus: 0.3 } });
    const results = [
        { mongo_id: 'a', title: 'deep learning survey', abstract: '', _firstStageScore: 5 },
        { mongo_id: 'b', title: 'neural networks', abstract: '', _firstStageScore: 5 }
    ];
    const { results: out } = await svc.rerank('neural networks', results);
    assert.equal(out[0].mongo_id, 'b', 'exact title match must be pinned to the top');
});
