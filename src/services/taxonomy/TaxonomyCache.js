/**
 * Redis read-through cache for taxonomy responses. Failure-tolerant: a Redis
 * outage degrades to direct reads (logged), never to request failures —
 * the same posture as the suggest/search caches.
 *
 * Single responsibility: keyed JSON get/set with a namespace and TTL.
 */
export default class TaxonomyCache {
    static PREFIX = 'taxonomy:v1:';

    constructor({ redis, logger }) {
        this.redis = redis;
        this.logger = logger;
    }

    key(...parts) {
        return TaxonomyCache.PREFIX + parts
            .map(p => (p === null || p === undefined || p === '' ? 'all' : String(p)))
            .join(':');
    }

    async get(key) {
        try {
            const hit = await this.redis.get(key);
            return hit ? JSON.parse(hit) : null;
        } catch (err) {
            this.logger.warn({ err, key }, 'taxonomy cache: read failed');
            return null;
        }
    }

    async set(key, value, ttlSeconds) {
        try {
            await this.redis.setex(key, ttlSeconds, JSON.stringify(value));
        } catch (err) {
            this.logger.warn({ err, key }, 'taxonomy cache: write failed');
        }
    }

    /**
     * Read-through helper: cached value, or produce() then cache.
     * Returns { value, cacheHit }.
     */
    async through(key, ttlSeconds, produce) {
        const cached = await this.get(key);
        if (cached !== null) return { value: cached, cacheHit: true };
        const value = await produce();
        await this.set(key, value, ttlSeconds);
        return { value, cacheHit: false };
    }
}
