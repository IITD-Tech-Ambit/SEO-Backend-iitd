import { searchRequestSchema, searchResponseSchema, errorResponseSchema } from '../schemas/search.js';
import { search, searchHealth } from '../controllers/searchController.js';

/**
 * Search Routes
 * POST /search - Hybrid semantic + keyword search
 * GET /search/health - Health check for search services
 */
export default async function searchRoutes(fastify, options) {
    fastify.post('/search', {
        schema: {
            description: 'Search research documents with hybrid BM25 + semantic search',
            tags: ['search'],
            body: searchRequestSchema,
            response: {
                200: searchResponseSchema,
                400: errorResponseSchema,
                500: errorResponseSchema
            }
        },
        handler: search
    });

    fastify.get('/search/health', {
        schema: {
            description: 'Health check for search services',
            tags: ['health']
        },
        handler: searchHealth
    });
}
