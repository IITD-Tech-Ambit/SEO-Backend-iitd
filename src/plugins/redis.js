import fp from 'fastify-plugin';
import fastifyRedis from '@fastify/redis';

async function redisPlugin(fastify, options) {
    await fastify.register(fastifyRedis, {
        url: options.url,
        closeClient: true
    });

    fastify.log.info('Redis connected successfully');

    // Add TTL config to fastify
    fastify.decorate('redisTTL', options.ttl);
}

export default fp(redisPlugin, {
    name: 'redis-wrapper',
    dependencies: []
});
