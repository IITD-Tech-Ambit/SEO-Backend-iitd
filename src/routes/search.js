import { searchRequestSchema, searchResponseSchema, errorResponseSchema, authorScopedSearchRequestSchema, authorScopedSearchResponseSchema, facultyForQueryRequestSchema, facultyForQueryResponseSchema } from '../schemas/search.js';
import { suggestRequestSchema, suggestResponseSchema } from '../schemas/suggest.js';
import { search, searchHealth, authorScopedSearch, getAllFacultyForQuery } from '../controllers/searchController.js';
import { suggest } from '../controllers/suggestController.js';

export default async function searchRoutes(fastify, options) {
    const { searchService, suggestService } = options;

    fastify.get('/suggest', {
        schema: {
            description: 'Blended, intent-aware autocomplete across authors and papers',
            tags: ['search'],
            querystring: suggestRequestSchema,
            response: {
                200: suggestResponseSchema
            }
        },
        handler: (request, reply) => suggest(request, reply, suggestService)
    });

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
        handler: (request, reply) => search(request, reply, searchService)
    });

    fastify.post('/search/author-scope', {
        schema: {
            description: 'Search within a specific author\'s papers using semantic similarity',
            tags: ['search'],
            body: authorScopedSearchRequestSchema,
            response: {
                200: authorScopedSearchResponseSchema,
                400: errorResponseSchema,
                500: errorResponseSchema
            }
        },
        handler: (request, reply) => authorScopedSearch(request, reply, searchService)
    });

    fastify.get('/search/faculty-for-query', {
        schema: {
            description: 'Get all IITD faculty matching a query across the full result set',
            tags: ['search'],
            querystring: facultyForQueryRequestSchema,
            response: {
                200: facultyForQueryResponseSchema,
                400: errorResponseSchema,
                500: errorResponseSchema
            }
        },
        handler: (request, reply) => getAllFacultyForQuery(request, reply, searchService)
    });

    fastify.get('/search/health', {
        schema: {
            description: 'Health check for search services',
            tags: ['health']
        },
        handler: searchHealth
    });
}
