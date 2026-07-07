/**
 * Document Controller
 * Handles document-related HTTP requests
 */

import { resolveFacultyByAuthorId } from '../utils/facultyIdentity.js';

/**
 * Get a single document by ID
 */
export async function getDocument(request, reply) {
    const { id } = request.params;
    const searchService = request.server.searchService;

    try {
        const document = await searchService.getDocument(id);

        if (!document) {
            return reply.status(404).send({
                error: 'Not Found',
                message: `Document with ID ${id} not found`,
                statusCode: 404
            });
        }

        return { document };

    } catch (error) {
        request.log.error({ error, id }, 'Document fetch failed');

        return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Failed to fetch document',
            statusCode: 500
        });
    }
}

/**
 * Get documents by author ID.
 * Uses BOTH kerberos (from Faculty.email prefix) and scopus_id to find all papers
 * for the given faculty, matching the dual-mapping strategy used everywhere else.
 */
export async function getDocumentsByAuthor(request, reply) {
    const { authorId } = request.params;
    const { page = 1, per_page = 20 } = request.query;
    const mongoose = request.server.mongoose;
    const redis = request.server.redis;
    const cacheKey = `author-docs:${authorId}:${page}:${per_page}`;

    try {
        try {
            const cached = await redis.get(cacheKey);
            if (cached) return JSON.parse(cached);
        } catch (err) {
            request.log.warn({ err }, 'Redis cache read failed (getDocumentsByAuthor)');
        }

        const ResearchDocument = mongoose.model('ResearchMetaDataScopus');
        const Faculty = mongoose.model('Faculty');
        const skip = (page - 1) * per_page;

        // authorId may be a scopus_id or an expert_id — resolveFacultyByAuthorId tries both
        const { kerberos, scopusIds } = await resolveFacultyByAuthorId(Faculty, authorId);

        const orClauses = [];
        if (kerberos) orClauses.push({ kerberos });
        if (scopusIds.length > 0) {
            orClauses.push({ 'authors.author_id': { $in: scopusIds } });
        } else {
            orClauses.push({ 'authors.author_id': authorId });
        }

        const filter = orClauses.length > 1 ? { $or: orClauses } : orClauses[0];

        const [documents, total] = await Promise.all([
            ResearchDocument.find(filter)
                .select('-__v')
                .sort({ publication_year: -1 })
                .skip(skip)
                .limit(per_page)
                .lean(),
            ResearchDocument.countDocuments(filter)
        ]);

        const response = {
            documents,
            pagination: {
                page,
                per_page,
                total,
                total_pages: Math.ceil(total / per_page)
            }
        };

        try {
            await redis.setex(cacheKey, request.server.redisTTL.authorDocuments, JSON.stringify(response));
        } catch (err) {
            request.log.warn({ err }, 'Redis cache write failed (getDocumentsByAuthor)');
        }

        return response;

    } catch (error) {
        request.log.error({ error, authorId }, 'Author documents fetch failed');

        return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Failed to fetch author documents',
            statusCode: 500
        });
    }
}

/**
 * Get similar documents using k-NN embeddings
 */
export async function getSimilarDocuments(request, reply) {
    const { id } = request.params;
    const { limit = 10 } = request.query;
    const searchService = request.server.searchService;

    try {
        const result = await searchService.findSimilar(id, limit);
        return result;

    } catch (error) {
        request.log.error({ error, id }, 'Similar documents fetch failed');

        if (error.message === 'Document not found in search index') {
            return reply.status(404).send({
                error: 'Not Found',
                message: `Document with ID ${id} not found in search index`,
                statusCode: 404
            });
        }

        return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Failed to fetch similar documents',
            statusCode: 500
        });
    }
}

/**
 * Get co-authors for a specific author
 */
export async function getCoAuthors(request, reply) {
    const { id } = request.params;
    const searchService = request.server.searchService;

    try {
        const result = await searchService.getCoAuthors(id);
        return result;

    } catch (error) {
        request.log.error({ error, id }, 'Co-authors fetch failed');

        return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Failed to fetch co-authors',
            statusCode: 500
        });
    }
}
