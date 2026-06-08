import { searchRequestSchema, searchResponseSchema, errorResponseSchema, authorScopedSearchRequestSchema, authorScopedSearchResponseSchema, facultyForQueryRequestSchema, facultyForQueryResponseSchema } from '../schemas/search.js';
import { suggestRequestSchema, suggestResponseSchema } from '../schemas/suggest.js';
import { search, searchHealth, authorScopedSearch, getAllFacultyForQuery } from '../controllers/searchController.js';
import { suggest } from '../controllers/suggestController.js';

/**
 * Search Routes
 * POST /search - Hybrid semantic + keyword search
 * POST /search/author-scope - Author-scoped semantic search
 * GET /search/faculty-for-query - Get all faculty for a query (aggregation)
 * GET /suggest - Blended, intent-aware typeahead (authors + papers)
 * GET /search/health - Health check for search services
 */
export default async function searchRoutes(fastify, options) {
    fastify.get('/suggest', {
        schema: {
            description: 'Blended, intent-aware autocomplete across authors and papers',
            tags: ['search'],
            querystring: suggestRequestSchema,
            response: {
                200: suggestResponseSchema
            }
        },
        handler: suggest
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
        handler: search
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
        handler: authorScopedSearch
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
        handler: getAllFacultyForQuery
    });

    fastify.get('/search/health', {
        schema: {
            description: 'Health check for search services',
            tags: ['health']
        },
        handler: searchHealth
    });
}
