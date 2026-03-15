/**
 * Document Controller
 * Handles document-related HTTP requests
 */

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
 * Get documents by author ID
 */
export async function getDocumentsByAuthor(request, reply) {
    const { authorId } = request.params;
    const { page = 1, per_page = 20 } = request.query;
    const mongoose = request.server.mongoose;

    try {
        const ResearchDocument = mongoose.model('ResearchMetaDataScopus');
        const skip = (page - 1) * per_page;

        const [documents, total] = await Promise.all([
            ResearchDocument.find({ 'authors.author_id': authorId })
                .select('-__v')
                .sort({ publication_year: -1 })
                .skip(skip)
                .limit(per_page)
                .lean(),
            ResearchDocument.countDocuments({ 'authors.author_id': authorId })
        ]);

        return {
            documents,
            pagination: {
                page,
                per_page,
                total,
                total_pages: Math.ceil(total / per_page)
            }
        };

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
