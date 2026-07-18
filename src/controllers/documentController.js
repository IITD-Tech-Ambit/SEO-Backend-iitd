/**
 * Get a single document by ID
 */
export async function getDocument(request, reply, documentService) {
    const { id } = request.params;

    try {
        const document = await documentService.getDocument(id);

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
export async function getDocumentsByAuthor(request, reply, documentService) {
    const { authorId } = request.params;
    const { page = 1, per_page = 20 } = request.query;

    try {
        return await documentService.getDocumentsByAuthor(authorId, { page, per_page });

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
export async function getSimilarDocuments(request, reply, documentService) {
    const { id } = request.params;
    const { limit = 10 } = request.query;

    try {
        const result = await documentService.findSimilar(id, limit);
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
export async function getCoAuthors(request, reply, documentService) {
    const { id } = request.params;

    try {
        const result = await documentService.getCoAuthors(id);
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
