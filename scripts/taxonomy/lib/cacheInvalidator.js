import Redis from 'ioredis';

/**
 * Invalidates the taxonomy Redis cache namespace after the rollup rewrites
 * the precomputed collections. Uses SCAN (never KEYS) so it is safe against
 * a shared production Redis. Failure-tolerant: an unreachable Redis logs a
 * warning telling the operator to flush manually — it never fails the rollup.
 */
export async function invalidateTaxonomyCache({ redisUrl, prefix, logger = console }) {
    if (!redisUrl) {
        logger.warn(`REDIS_URL not set — flush "${prefix}*" keys manually or stale responses persist up to the cache TTL`);
        return 0;
    }

    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
        await redis.connect();
        let cursor = '0';
        let deleted = 0;
        do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
            cursor = next;
            if (keys.length > 0) deleted += await redis.del(...keys);
        } while (cursor !== '0');
        return deleted;
    } catch (err) {
        logger.warn(`Could not invalidate taxonomy cache (${err.message}) — flush "${prefix}*" keys manually`);
        return 0;
    } finally {
        redis.disconnect();
    }
}
