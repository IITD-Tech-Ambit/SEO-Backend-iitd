import { ipSearchRequestSchema, ipSearchResponseSchema, ipDocumentParamsSchema, errorResponseSchema, ipFacultyForQueryRequestSchema, ipFacultyForQueryResponseSchema, inventorScopedSearchRequestSchema, inventorScopedSearchResponseSchema } from '../schemas/ipSearch.js';
import { ipSuggestRequestSchema, ipSuggestResponseSchema } from '../schemas/ipSuggest.js';
import { search, searchHealth, getIpDocument, getAllFacultyForQuery, inventorScopedSearch } from '../controllers/ipSearchController.js';
import { ipSuggest } from '../controllers/ipSuggestController.js';

export default async function ipSearchRoutes(fastify, options) {
    const { ipSearchService, ipSuggestService } = options;

    fastify.get('/ip/suggest', {
        schema: {
            description: 'Blended, intent-aware autocomplete across IP inventors and documents',
            tags: ['ip-search'],
            querystring: ipSuggestRequestSchema,
            response: {
                200: ipSuggestResponseSchema
            }
        },
        handler: (request, reply) => ipSuggest(request, reply, ipSuggestService)
    });

    fastify.post('/ip/search', {
        schema: {
            description: 'Search IP/patent documents with hybrid BM25 + semantic search',
            tags: ['ip-search'],
            body: ipSearchRequestSchema,
            response: {
                200: ipSearchResponseSchema,
                400: errorResponseSchema,
                500: errorResponseSchema
            }
        },
        handler: (request, reply) => search(request, reply, ipSearchService)
    });

    fastify.post('/ip/search/inventor-scope', {
        schema: {
            description: 'Rank one IITD faculty inventor\'s patents for a query (Explore sidebar drill-down)',
            tags: ['ip-search'],
            body: inventorScopedSearchRequestSchema,
            response: {
                200: inventorScopedSearchResponseSchema,
                400: errorResponseSchema,
                500: errorResponseSchema
            }
        },
        handler: (request, reply) => inventorScopedSearch(request, reply, ipSearchService)
    });

    fastify.get('/ip/faculty-for-query', {
        schema: {
            description: 'Get all IITD faculty inventors matching a query across the full IP result set (people sidebar)',
            tags: ['ip-search'],
            querystring: ipFacultyForQueryRequestSchema,
            response: {
                200: ipFacultyForQueryResponseSchema,
                400: errorResponseSchema,
                500: errorResponseSchema
            }
        },
        handler: (request, reply) => getAllFacultyForQuery(request, reply, ipSearchService)
    });

    fastify.get('/ip/search/health', {
        schema: {
            description: 'Health check for IP search services',
            tags: ['health']
        },
        handler: searchHealth
    });

    fastify.get('/ip/document/:id', {
        schema: {
            description: 'Get a single IP document by MongoDB id',
            tags: ['ip-documents'],
            params: ipDocumentParamsSchema,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        document: { type: 'object', additionalProperties: true }
                    }
                },
                404: errorResponseSchema,
                500: errorResponseSchema
            }
        },
        handler: (request, reply) => getIpDocument(request, reply, ipSearchService)
    });
}
