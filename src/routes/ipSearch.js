import { ipSearchRequestSchema, ipSearchResponseSchema, ipDocumentParamsSchema, errorResponseSchema } from '../schemas/ipSearch.js';
import { ipSuggestRequestSchema, ipSuggestResponseSchema } from '../schemas/ipSuggest.js';
import { search, searchHealth, getIpDocument } from '../controllers/ipSearchController.js';
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
        handler: getIpDocument
    });
}
