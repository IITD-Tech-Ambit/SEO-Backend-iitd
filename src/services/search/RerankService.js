import crypto from 'crypto';

/**
 * Cross-encoder reranking of first-stage candidates. Per-doc rerank scores are cached in
 * Redis so only cache misses are sent to the embedding service. On any failure the original
 * first-stage order is returned unchanged (graceful degradation).
 *
 * Final ordering fuses the cross-encoder score with the (normalized) first-stage hybrid score
 * so a strong lexical/phrase match is never demoted by a merely semantically-similar distractor:
 *   fused = alpha * norm(rerank) + (1 - alpha) * norm(firstStage) + literalTitleBonus
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

export default class RerankService {
    constructor({ embeddingService, redis, rerankConfig, logger }) {
        this.embeddingService = embeddingService;
        this.redis = redis;
        this.rerankConfig = rerankConfig || {};
        this.logger = logger;
        this.fusionAlpha = this.rerankConfig.fusionAlpha ?? 0.7;
        this.literalTitleBonus = this.rerankConfig.literalTitleBonus ?? 0.3;
    }

    async rerank(query, results) {
        const modelVersion = this.rerankConfig.modelVersion || 'bge-reranker-base-v1';
        const queryHash = crypto.createHash('sha256').update(query).digest('hex').slice(0, 12);
        const ttl = this.rerankConfig.scoreCacheTTL || 3600;

        const documents = results.map(r => {
            const title = r.title || '';
            const abstract = r.abstract || '';
            return `${title}\n${abstract}`.slice(0, 1200);
        });

        const cacheKeys = results.map(r => `rerank:${modelVersion}:${queryHash}:${r.mongo_id}`);
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
                this.logger.warn({ err: err.message }, 'Reranker failed, keeping first-stage order');
                return { results: results.map(({ _firstStageScore, ...rest }) => rest), reranked: false };
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
