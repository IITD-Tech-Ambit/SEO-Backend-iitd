import { test } from 'node:test';
import assert from 'node:assert/strict';
import RerankService from '../../src/services/search/RerankService.js';
import { deriveRerankModelVersion } from '../../src/config/index.js';

// The two model ids that are genuinely deployed today: the local embedding service loads the
// MiniLM cross-encoder, the container in docker-compose.services.yml loads BGE. Both were
// previously labelled `ms-marco-minilm-l12-v2`, which is why they could share cache entries.
const LOCAL_MODEL = 'cross-encoder/ms-marco-MiniLM-L-6-v2';
const DOCKER_MODEL = 'BAAI/bge-reranker-base';

function makeLogger() {
    const warns = [];
    const errors = [];
    return {
        warns,
        errors,
        warn(ctx, msg) { warns.push({ ctx, msg }); },
        error(ctx, msg) { errors.push({ ctx, msg }); },
        info() {}
    };
}

/** Redis stub over a real Map so cross-instance cache reuse (or isolation) is observable. */
function makeRedis(store = new Map()) {
    return {
        store,
        mget: async (...keys) => keys.map(k => (store.has(k) ? store.get(k) : null)),
        pipeline: () => ({
            setex(key, _ttl, value) { store.set(key, value); return this; },
            exec: async () => {}
        })
    };
}

function makeService({ modelName, revision, declaredModelVersion, redis, logger, rerank, extra }) {
    const calls = [];
    const svc = new RerankService({
        embeddingService: {
            rerank: rerank || (async (query, docs) => {
                calls.push({ query, docs });
                return docs.map((_, i) => ({ index: i, score: docs.length - i }));
            })
        },
        redis: redis || makeRedis(),
        logger: logger || makeLogger(),
        rerankConfig: {
            modelName,
            declaredModelVersion,
            modelVersion: deriveRerankModelVersion(modelName, revision),
            ...extra
        }
    });
    return { svc, calls };
}

const docs = () => [
    { _id: 'doc-1', title: 'graphene membranes', abstract: 'water', _firstStageScore: 9 },
    { _id: 'doc-2', title: 'catalysis', abstract: 'zeolite', _firstStageScore: 4 }
];

test('derived model version separates the cross-encoders that are actually deployed', () => {
    const local = deriveRerankModelVersion(LOCAL_MODEL);
    const docker = deriveRerankModelVersion(DOCKER_MODEL);

    assert.equal(local, 'cross-encoder-ms-marco-minilm-l-6-v2');
    assert.equal(docker, 'baai-bge-reranker-base');
    assert.notEqual(local, docker, 'different models must never share a cache namespace');
});

test('revision distinguishes changed weights published under the same model id', () => {
    const base = deriveRerankModelVersion(LOCAL_MODEL);
    const requantized = deriveRerankModelVersion(LOCAL_MODEL, 'int8-2026-08');

    assert.notEqual(base, requantized);
    assert.ok(requantized.startsWith(base), 'revision extends the model namespace rather than replacing it');
});

test('missing model name yields a placeholder namespace instead of a plausible-looking one', () => {
    assert.equal(deriveRerankModelVersion(undefined), 'unset-model');
    assert.equal(deriveRerankModelVersion(''), 'unset-model');
});

test('config derives the cache namespace from the model the embedding service loads', async () => {
    const previous = { name: process.env.RERANK_MODEL_NAME, version: process.env.RERANK_MODEL_VERSION };
    process.env.RERANK_MODEL_NAME = DOCKER_MODEL;
    process.env.RERANK_MODEL_VERSION = 'ms-marco-minilm-l12-v2';
    try {
        // Query string defeats the ESM module cache so env resolution is observed on a fresh load.
        const { default: config } = await import('../../src/config/index.js?rerankConfigTest');
        assert.equal(config.reranker.modelName, DOCKER_MODEL);
        assert.equal(config.reranker.modelVersion, 'baai-bge-reranker-base');
        assert.equal(config.reranker.declaredModelVersion, 'ms-marco-minilm-l12-v2');
    } finally {
        if (previous.name == null) delete process.env.RERANK_MODEL_NAME;
        else process.env.RERANK_MODEL_NAME = previous.name;
        if (previous.version == null) delete process.env.RERANK_MODEL_VERSION;
        else process.env.RERANK_MODEL_VERSION = previous.version;
    }
});

test('cache keys are namespaced by the derived model version', async () => {
    const redis = makeRedis();
    const { svc } = makeService({ modelName: LOCAL_MODEL, redis });

    await svc.rerank('graphene', docs());

    const keys = [...redis.store.keys()];
    assert.equal(keys.length, 2);
    for (const key of keys) {
        assert.ok(
            key.startsWith('rerank:cross-encoder-ms-marco-minilm-l-6-v2:'),
            `key must carry the model namespace: ${key}`
        );
    }
});

test('scores cached under one model are not served for another', async () => {
    const redis = makeRedis();
    const first = makeService({ modelName: LOCAL_MODEL, redis });
    await first.svc.rerank('graphene', docs());
    assert.equal(first.calls.length, 1, 'cold cache must reach the cross-encoder');

    // Same Redis, same query, same documents — only the model differs. A shared key here would
    // hand BGE scores to callers who believe they are reading MiniLM scores.
    const second = makeService({ modelName: DOCKER_MODEL, redis });
    await second.svc.rerank('graphene', docs());
    assert.equal(second.calls.length, 1, 'a different model must miss the cache, not inherit it');

    assert.equal(redis.store.size, 4, 'each model keeps its own cache entries');
});

test('a warm cache for the same model is reused', async () => {
    const redis = makeRedis();
    const first = makeService({ modelName: LOCAL_MODEL, redis });
    await first.svc.rerank('graphene', docs());

    const second = makeService({ modelName: LOCAL_MODEL, redis });
    await second.svc.rerank('graphene', docs());
    assert.equal(second.calls.length, 0, 'identical model + query must be served from cache');
});

test('an unset model name is reported at construction', () => {
    const logger = makeLogger();
    makeService({ modelName: '', logger });

    assert.equal(logger.errors.length, 0, 'an unpinned namespace degrades relevance, it is not an outage');
    assert.ok(
        logger.warns.some(w => /RERANK_MODEL_NAME is unset/.test(w.msg)),
        'the placeholder namespace must be called out'
    );
});

test('a stale RERANK_MODEL_VERSION that disagrees with the model in use is reported', () => {
    const logger = makeLogger();
    makeService({ modelName: LOCAL_MODEL, declaredModelVersion: 'ms-marco-minilm-l12-v2', logger });

    const warn = logger.warns.find(w => /RERANK_MODEL_VERSION no longer sets/.test(w.msg));
    assert.ok(warn, 'a leftover label must not be silently ignored');
    assert.equal(warn.ctx.declaredModelVersion, 'ms-marco-minilm-l12-v2');
    assert.equal(warn.ctx.modelVersion, 'cross-encoder-ms-marco-minilm-l-6-v2');
});

test('a coherent reranker configuration logs nothing at construction', () => {
    const logger = makeLogger();
    makeService({
        modelName: LOCAL_MODEL,
        declaredModelVersion: 'cross-encoder-ms-marco-minilm-l-6-v2',
        logger
    });

    assert.deepEqual(logger.warns, []);
    assert.deepEqual(logger.errors, []);
});

test('a service that reports reranking disabled is reported as a configuration mismatch', async () => {
    const logger = makeLogger();
    const { svc } = makeService({
        modelName: LOCAL_MODEL,
        logger,
        rerank: async () => { throw new Error('Embedding service error: 404'); }
    });

    const { results, reranked, reason } = await svc.rerank('graphene', docs());

    assert.equal(reranked, false);
    assert.equal(reason, 'disabled');
    assert.deepEqual(results.map(r => r._id), ['doc-1', 'doc-2'], 'first-stage order must survive');
    for (const r of results) assert.ok(!('_firstStageScore' in r), 'internal field must not leak');

    assert.equal(logger.errors.length, 1, 'a config mismatch must be louder than a warning');
    assert.match(logger.errors[0].msg, /RERANK_ENABLED=true/);
    assert.match(logger.errors[0].msg, /services\/embedding\/\.env/);
});

test('the gRPC form of a disabled reranker is classified the same way', async () => {
    const logger = makeLogger();
    const { svc } = makeService({
        modelName: LOCAL_MODEL,
        logger,
        rerank: async () => {
            throw new Error('Embedding gRPC Rerank failed: 12 UNIMPLEMENTED: reranking is disabled');
        }
    });

    const { reason } = await svc.rerank('graphene', docs());
    assert.equal(reason, 'disabled');
    assert.equal(logger.errors.length, 1);
});

test('a loaded-but-absent reranker model is reported separately from being switched off', async () => {
    const logger = makeLogger();
    const { svc } = makeService({
        modelName: LOCAL_MODEL,
        logger,
        rerank: async () => {
            throw new Error('Embedding gRPC Rerank failed: 14 UNAVAILABLE: reranker not loaded');
        }
    });

    const { reason } = await svc.rerank('graphene', docs());
    assert.equal(reason, 'not-loaded');
    assert.match(logger.errors[0].msg, /no cross-encoder loaded/);
});

test('a standing mismatch is reported once per window, not once per request', async () => {
    const logger = makeLogger();
    const { svc } = makeService({
        modelName: LOCAL_MODEL,
        logger,
        extra: { mismatchLogIntervalMs: 300000 },
        rerank: async () => { throw new Error('Embedding service error: 404'); }
    });

    await svc.rerank('graphene', docs());
    await svc.rerank('catalysis', docs());

    assert.equal(logger.errors.length, 1, 'the full remediation text must not repeat per request');
    assert.equal(logger.warns.length, 1, 'later occurrences still leave a trace');
    assert.match(logger.warns[0].msg, /already reported/);
});

test('a mismatch is re-reported once the reporting window has passed', async () => {
    const logger = makeLogger();
    const { svc } = makeService({
        modelName: LOCAL_MODEL,
        logger,
        extra: { mismatchLogIntervalMs: 0 },
        rerank: async () => { throw new Error('Embedding service error: 404'); }
    });

    await svc.rerank('graphene', docs());
    await svc.rerank('catalysis', docs());

    assert.equal(logger.errors.length, 2, 'a long-lived process must keep surfacing the condition');
});

test('a reranker outage stays a warning and still returns first-stage results', async () => {
    const logger = makeLogger();
    const { svc } = makeService({
        modelName: LOCAL_MODEL,
        logger,
        rerank: async () => { throw new Error('Embedding service timeout'); }
    });

    const { results, reranked, reason } = await svc.rerank('graphene', docs());

    assert.equal(reranked, false);
    assert.equal(reason, 'error');
    assert.deepEqual(results.map(r => r._id), ['doc-1', 'doc-2']);
    assert.equal(logger.errors.length, 0, 'a transient outage must not be dressed up as misconfiguration');
    assert.match(logger.warns[0].msg, /keeping first-stage order/);
});

test('a plain 503 is treated as an outage, since a restarting service looks identical', async () => {
    const logger = makeLogger();
    const { svc } = makeService({
        modelName: LOCAL_MODEL,
        logger,
        rerank: async () => { throw new Error('Embedding service error: 503'); }
    });

    const { reason } = await svc.rerank('graphene', docs());
    assert.equal(reason, 'error');
    assert.equal(logger.errors.length, 0);
});
