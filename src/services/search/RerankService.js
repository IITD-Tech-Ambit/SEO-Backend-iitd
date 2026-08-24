import crypto from 'crypto';

/**
 * Cross-encoder rerank of first-stage candidates. Cache misses go to the embedding service;
 * any failure keeps first-stage order.
 * fused = alpha * norm(rerank) + (1 - alpha) * norm(firstStage) + literalTitleBonus
 */
function minMaxNormalize(values) {
    if (!values.length) return [];
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const range = max - min;
    if (range < 1e-9) return values.map(() => 0.5);
    return values.map(v => (v - min) / range);
}

/** 404 / UNIMPLEMENTED = reranker switched off. 503 is not classified (could be a restart). */
function classifyRerankFailure(message) {
    const text = String(message || '');
    if (/reranking is disabled/i.test(text) || /error: 404\b/.test(text) || /\bUNIMPLEMENTED\b/.test(text)) {
        return 'disabled';
    }
    if (/reranker not loaded/i.test(text)) return 'not-loaded';
    return null;
}

const MISMATCH_MESSAGES = {
    disabled: 'Reranker configuration mismatch: this API has RERANK_ENABLED=true but the embedding '
        + 'service refuses /rerank because reranking is disabled there. Every advanced search is '
        + 'paying for a wasted call and serving UNRERANKED first-stage order. Set RERANK_ENABLED=true '
        + 'in the embedding service environment (services/embedding/.env for a local run, the '
        + 'embedding service block of docker-compose.services.yml for containers) and restart it.',
    'not-loaded': 'Reranker configuration mismatch: the embedding service has reranking enabled but '
        + 'no cross-encoder loaded — check RERANK_MODEL_NAME there and its model cache/download. '
        + 'Search is serving UNRERANKED first-stage order until it loads.'
};

export default class RerankService {
    constructor({ embeddingService, redis, rerankConfig, logger }) {
        this.embeddingService = embeddingService;
        this.redis = redis;
        this.rerankConfig = rerankConfig || {};
        this.logger = logger;
        this.fusionAlpha = this.rerankConfig.fusionAlpha ?? 0.7;
        this.literalTitleBonus = this.rerankConfig.literalTitleBonus ?? 0.3;
        this.modelVersion = this.rerankConfig.modelVersion || 'unset-model';
        this.mismatchLogIntervalMs = this.rerankConfig.mismatchLogIntervalMs ?? 300000;
        this._mismatchLoggedAt = 0;
        this._reportModelIdentityGaps();
    }

    _reportModelIdentityGaps() {
        const { modelName, declaredModelVersion } = this.rerankConfig;

        if (!modelName) {
            this.logger.warn(
                { modelVersion: this.modelVersion },
                'RERANK_MODEL_NAME is unset on the API, so cached rerank scores are namespaced by a '
                + 'placeholder: two environments running different cross-encoders would share cache '
                + 'entries. Set it to the same model the embedding service loads.'
            );
        }

        if (declaredModelVersion && declaredModelVersion !== this.modelVersion) {
            this.logger.warn(
                { declaredModelVersion, modelVersion: this.modelVersion },
                'RERANK_MODEL_VERSION no longer sets the rerank cache namespace (it is derived from '
                + 'RERANK_MODEL_NAME) and the value left in the environment disagrees with the model '
                + 'in use. Remove it, or bump RERANK_MODEL_REVISION if the weights changed.'
            );
        }
    }

    _reportMismatch(kind, message) {
        const now = Date.now();
        if (now - this._mismatchLoggedAt < this.mismatchLogIntervalMs) {
            this.logger.warn(
                { err: message, mismatch: kind },
                'Reranker still unavailable for a configuration reason already reported, keeping first-stage order'
            );
            return;
        }
        this._mismatchLoggedAt = now;
        this.logger.error({ err: message, mismatch: kind }, MISMATCH_MESSAGES[kind]);
    }

    async rerank(query, results) {
        const modelVersion = this.modelVersion;
        const queryHash = crypto.createHash('sha256').update(query).digest('hex').slice(0, 12);
        const ttl = this.rerankConfig.scoreCacheTTL || 3600;

        const documents = results.map(r => {
            const title = r.title || '';
            const abstract = r.abstract || '';
            return `${title}\n${abstract}`.slice(0, 1200);
        });

        const cacheKeys = results.map(r => `rerank:${modelVersion}:${queryHash}:${r._id}`);
        let cachedScores;
        try {
            cachedScores = await this.redis.mget(...cacheKeys);
        } catch {
            cachedScores = new Array(cacheKeys.length).fill(null);
        }

        const missingIndices = [];
        const missingDocs = [];
        const scores = new Array(results.length);

        for (let i = 0; i < results.length; i++) {
            if (cachedScores[i] != null) {
                scores[i] = parseFloat(cachedScores[i]);
            } else {
                missingIndices.push(i);
                missingDocs.push(documents[i]);
            }
        }

        if (missingDocs.length > 0) {
            try {
                const rerankResults = await this.embeddingService.rerank(query, missingDocs);

                const scoreByRerankIndex = {};
                for (const rr of rerankResults) scoreByRerankIndex[rr.index] = rr.score;

                const pipeline = this.redis.pipeline();
                for (let j = 0; j < missingIndices.length; j++) {
                    const origIdx = missingIndices[j];
                    const score = scoreByRerankIndex[j] ?? 0;
                    scores[origIdx] = score;
                    pipeline.setex(cacheKeys[origIdx], ttl, String(score));
                }
                pipeline.exec().catch(err =>
                    this.logger.warn({ err }, 'Redis rerank score cache write failed')
                );
            } catch (err) {
                const mismatch = classifyRerankFailure(err.message);
                if (mismatch) {
                    this._reportMismatch(mismatch, err.message);
                } else {
                    this.logger.warn({ err: err.message }, 'Reranker failed, keeping first-stage order');
                }
                return {
                    results: results.map(({ _firstStageScore, ...rest }) => rest),
                    reranked: false,
                    reason: mismatch || 'error'
                };
            }
        }

        const rerankNorm = minMaxNormalize(scores);
        const firstStageNorm = minMaxNormalize(results.map(r => (typeof r._firstStageScore === 'number' ? r._firstStageScore : 0)));
        const queryLower = query.trim().toLowerCase();
        const alpha = this.fusionAlpha;

        const fused = results.map((r, i) => {
            let fusedScore = alpha * rerankNorm[i] + (1 - alpha) * firstStageNorm[i];
            // Pin exact literal title matches: a perfect phrase hit must not be demoted by a
            // semantically-similar distractor with a higher cross-encoder score.
            if (queryLower.length >= 3 && (r.title || '').toLowerCase().includes(queryLower)) {
                fusedScore += this.literalTitleBonus;
            }
            return { result: r, score: scores[i], fusedScore };
        });
        fused.sort((a, b) => b.fusedScore - a.fusedScore);

        return {
            results: fused.map(({ result, score, fusedScore }) => {
                const { _firstStageScore, ...rest } = result;
                return { ...rest, rerank_score: score, fused_score: fusedScore };
            }),
            reranked: true
        };
    }
}

/**
 * ranked_window: actual rerank size, not intent.
 * succeeded / deep page → min(total, K); this page should have reranked and didn't → 0;
 * rerank not in play → total.
 */
export function resolveRankedWindow({ didRerank, rerankApplicable, rerankEligible, total, candidateK }) {
    const window = Math.min(total, candidateK);
    if (didRerank) return window;
    if (rerankApplicable && !rerankEligible) return window;
    if (rerankApplicable) return 0;
    return total;
}
