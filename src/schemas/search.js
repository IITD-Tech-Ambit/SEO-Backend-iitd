// Search Request/Response Validation Schemas

export const searchRequestSchema = {
    type: 'object',
    required: ['query'],
    properties: {
        query: {
            type: 'string',
            minLength: 1,
            maxLength: 500,
            description: 'Search query string'
        },
        filters: {
            type: 'object',
            properties: {
                year_from: {
                    type: 'integer',
                    minimum: 1900,
                    maximum: 2100
                },
                year_to: {
                    type: 'integer',
                    minimum: 1900,
                    maximum: 2100
                },
                field_associated: {
                    type: 'string',
                    description: 'Department/field filter'
                },
                document_type: {
                    type: 'string',
                    description: 'Article, Review, Conference Paper, etc.'
                },
                subject_area: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Subject area codes'
                }
            },
            additionalProperties: false
        },
        sort: {
            type: 'string',
            enum: ['relevance', 'date', 'citations'],
            default: 'relevance'
        },
        page: {
            type: 'integer',
            minimum: 1,
            default: 1
        },
        per_page: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: 20
        },
        search_in: {
            type: 'array',
            items: {
                type: 'string',
                enum: ['title', 'abstract', 'author', 'subject_area', 'field']
            },
            default: ['title', 'abstract', 'author'],
            description: 'Fields to search in. Default: hybrid (title, abstract, author). Use specific fields for targeted search.'
        }
    },
    additionalProperties: false
};

export const searchResponseSchema = {
    type: 'object',
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    _id: { type: 'string' },
                    title: { type: 'string' },
                    abstract: { type: 'string' },
                    authors: { type: 'array' },
                    publication_year: { type: 'integer' },
                    document_type: { type: 'string' },
                    field_associated: { type: 'string' },
                    citation_count: { type: 'integer' },
                    link: { type: 'string' }
                }
            }
        },
        facets: {
            type: 'object',
            properties: {
                years: { type: 'array' },
                document_types: { type: 'array' },
                fields: { type: 'array' }
            }
        },
        pagination: {
            type: 'object',
            properties: {
                page: { type: 'integer' },
                per_page: { type: 'integer' },
                total: { type: 'integer' },
                total_pages: { type: 'integer' }
            }
        },
        meta: {
            type: 'object',
            properties: {
                took_ms: { type: 'number' },
                cache_hit: { type: 'boolean' }
            }
        }
    }
};

export const documentParamsSchema = {
    type: 'object',
    required: ['id'],
    properties: {
        id: {
            type: 'string',
            description: 'MongoDB ObjectId or OpenSearch document ID'
        }
    }
};

export const errorResponseSchema = {
    type: 'object',
    properties: {
        error: { type: 'string' },
        message: { type: 'string' },
        statusCode: { type: 'integer' }
    }
};
