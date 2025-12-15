import fp from 'fastify-plugin';
import { Client } from '@opensearch-project/opensearch';

async function opensearchPlugin(fastify, options) {
    const client = new Client({
        node: options.node,
        auth: options.auth,
        ssl: options.ssl
    });

    try {
        // Verify connection
        const health = await client.cluster.health();
        fastify.log.info(`OpenSearch connected. Cluster: ${health.body.cluster_name}, Status: ${health.body.status}`);

        // Decorate fastify with client and index name
        fastify.decorate('opensearch', client);
        fastify.decorate('opensearchIndex', options.indexName);

        // Graceful shutdown
        fastify.addHook('onClose', async () => {
            await client.close();
            fastify.log.info('OpenSearch connection closed');
        });

    } catch (error) {
        fastify.log.error('OpenSearch connection failed:', error);
        throw error;
    }
}

export default fp(opensearchPlugin, {
    name: 'opensearch',
    dependencies: []
});
