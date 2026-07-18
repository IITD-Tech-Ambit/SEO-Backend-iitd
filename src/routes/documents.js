import { documentParamsSchema, errorResponseSchema, similarRequestSchema, coauthorsParamsSchema } from '../schemas/search.js';
import { getDocument, getDocumentsByAuthor, getSimilarDocuments, getCoAuthors } from '../controllers/documentController.js';

export default async function documentRoutes(fastify, options) {
    const { documentService } = options;

    fastify.get('/document/:id', {
        schema: {
            description: 'Get a single research document by ID',
            tags: ['documents'],
            params: documentParamsSchema,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        document: { type: 'object' }
                    }
                },
                404: errorResponseSchema,
                500: errorResponseSchema
            }
        },
        handler: (request, reply) => getDocument(request, reply, documentService)
    });

    fastify.get('/documents/by-author/:authorId', {
        schema: {
            description: 'Get all documents by a specific author',
            tags: ['documents'],
            params: {
                type: 'object',
                required: ['authorId'],
                properties: {
                    authorId: { type: 'string' }
                }
            },
            querystring: {
                type: 'object',
                properties: {
                    page: { type: 'integer', minimum: 1, default: 1 },
                    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
                }
            }
        },
        handler: (request, reply) => getDocumentsByAuthor(request, reply, documentService)
    });

    fastify.get('/document/:id/similar', {
        schema: {
            description: 'Find semantically similar papers using embeddings',
            tags: ['documents'],
            params: documentParamsSchema,
            querystring: similarRequestSchema,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        source: { type: 'object' },
                        similar: { type: 'array' }
                    }
                },
                404: errorResponseSchema,
                500: errorResponseSchema
            }
        },
        handler: (request, reply) => getSimilarDocuments(request, reply, documentService)
    });

    fastify.get('/author/:id/collaborators', {
        schema: {
            description: 'Get co-authors and collaboration network for an author',
            tags: ['authors'],
            params: coauthorsParamsSchema,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        author_id: { type: 'string' },
                        total_papers: { type: 'integer' },
                        collaborators: { type: 'array' }
                    }
                },
                500: errorResponseSchema
            }
        },
        handler: (request, reply) => getCoAuthors(request, reply, documentService)
    });
}
