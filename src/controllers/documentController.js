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
