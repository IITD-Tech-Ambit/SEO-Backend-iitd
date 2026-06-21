import crypto from 'crypto';

/**
 * Cross-encoder reranking of first-stage candidates. Per-doc rerank scores are cached in
 * Redis so only cache misses are sent to the embedding service. On any failure the original
 * first-stage order is returned unchanged (graceful degradation).
 */
export default class RerankService {
    constructor({ embeddingService, redis, rerankConfig, logger }) {
        this.embeddingService = embeddingService;
        this.redis = redis;
        this.rerankConfig = rerankConfig || {};
        this.logger = logger;
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
                return { results, reranked: false };
            }
        }

        const indexed = results.map((r, i) => ({ result: r, score: scores[i] }));
        indexed.sort((a, b) => b.score - a.score);

        return {
            results: indexed.map(x => ({ ...x.result, rerank_score: x.score })),
            reranked: true
        };
    }
}
