import crypto from 'crypto';

/**
 * Embedding Service Client
 * Communicates with Python FastAPI embedding service
 */
export default class EmbeddingService {
    constructor(config, redis, redisTTL, logger) {
        this.baseUrl = config.url;
        this.timeout = config.timeout;
        this.redis = redis;
        this.redisTTL = redisTTL;
        this.logger = logger;
    }

    /**
     * Generate cache key for query embedding
     */
    _getCacheKey(text) {
        const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
        return `embed:${hash}`;
    }

    /**
     * Get embedding for a single query text
     * Uses Redis cache to avoid redundant embedding generation
     */
    async embedQuery(text) {
        const cacheKey = this._getCacheKey(text);

        // Check cache first
        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                this.logger.debug({ text: text.slice(0, 50) }, 'Embedding cache hit');
                return JSON.parse(cached);
            }
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed');
        }

        // Call embedding service
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
            const response = await fetch(`${this.baseUrl}/embed`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ texts: [text] }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Embedding service error: ${response.status}`);
            }

            const data = await response.json();
            const embedding = data.embeddings[0];

            // Cache the embedding
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

        } catch (error) {
            clearTimeout(timeoutId);

            if (error.name === 'AbortError') {
                throw new Error('Embedding service timeout');
            }
            throw error;
        }
    }

    /**
     * Batch embed multiple texts (used by indexer)
     */
    async embedBatch(texts) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout * 2);

        try {
            const response = await fetch(`${this.baseUrl}/embed`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ texts }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Embedding service error: ${response.status}`);
            }

            const data = await response.json();
            return data.embeddings;

        } catch (error) {
            clearTimeout(timeoutId);

            if (error.name === 'AbortError') {
                throw new Error('Embedding service timeout');
            }
            throw error;
        }
    }

    /**
     * Health check
     */
    async health() {
        try {
            const response = await fetch(`${this.baseUrl}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(2000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}
