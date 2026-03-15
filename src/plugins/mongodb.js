import fp from 'fastify-plugin';
import mongoose from 'mongoose';

async function mongodbPlugin(fastify, options) {
    const { uri, options: mongoOptions } = options;

    try {
        await mongoose.connect(uri, mongoOptions);
        fastify.log.info('MongoDB connected successfully');

        // Add mongoose to fastify instance
        fastify.decorate('mongoose', mongoose);

        // Graceful shutdown
        fastify.addHook('onClose', async () => {
            await mongoose.connection.close();
            fastify.log.info('MongoDB connection closed');
        });

    } catch (error) {
        fastify.log.error('MongoDB connection failed:', error);
        throw error;
    }
}

export default fp(mongodbPlugin, {
    name: 'mongodb',
    dependencies: []
});
