import crypto from 'crypto';

/**
 * Redis-cached facade over an injected EmbeddingTransport (HTTP for local
 * dev, gRPC-via-Envoy in production — see services/embedding/*). Callers
 * only ever see embedQuery/embedBatch/rerank/health, so the wire protocol
 * is swappable without touching search code.
 */
export default class EmbeddingService {
    constructor(config, redis, redisTTL, logger, transport) {
        this.transport = transport;
        this.redis = redis;
        this.redisTTL = redisTTL;
        this.logger = logger;
    }

    _getCacheKey(text) {
        const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
        return `embed:${hash}`;
    }

    async embedQuery(text) {
        const cacheKey = this._getCacheKey(text);

        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                this.logger.debug({ text: text.slice(0, 50) }, 'Embedding cache hit');
                return JSON.parse(cached);
            }
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed');
        }

        const embeddings = await this.transport.embed([text]);
        const embedding = embeddings[0];

        try {
            await this.redis.setex(
                cacheKey,
                this.redisTTL.queryEmbedding,
                JSON.stringify(embedding)
            );
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache write failed');
        }

        return embedding;
    }

    /** Batch embed (used by indexer). */
    async embedBatch(texts) {
        return this.transport.embed(texts);
    }

    /**
     * Rerank documents against a query via the cross-encoder.
     * Returns [{ index, score }] sorted by score descending.
     * Throws on timeout/error — callers should catch and fall back to first-stage order.
     */
    async rerank(query, documents, topN = null) {
        return this.transport.rerank(query, documents, topN);
    }

    async health() {
        return this.transport.health();
    }
}
