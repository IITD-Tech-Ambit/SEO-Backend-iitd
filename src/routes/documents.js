import { documentParamsSchema, errorResponseSchema, similarRequestSchema, coauthorsParamsSchema } from '../schemas/search.js';
import { getDocument, getDocumentsByAuthor, getSimilarDocuments, getCoAuthors } from '../controllers/documentController.js';

/**
 * Document Routes
 * GET /document/:id - Get single document by ID
 * GET /documents/by-author/:authorId - Get documents by author
 */
export default async function documentRoutes(fastify, options) {
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
        handler: getDocument
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
        handler: getDocumentsByAuthor
    });

    // Find similar papers using k-NN
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
        handler: getSimilarDocuments
    });

    // Get co-authors for an author (Phase 2 - after nested indexing)
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
        handler: getCoAuthors
    });
}
