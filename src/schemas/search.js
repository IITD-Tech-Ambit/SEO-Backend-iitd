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
                document_types: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Multiple document types (Article, Review, etc.)'
                },
                subject_area: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Subject area codes'
                },
                // Nested author filters (Phase 2)
                author_id: {
                    type: 'string',
                    description: 'Filter by specific author ID'
                },
                affiliation: {
                    type: 'string',
                    description: 'Filter by author affiliation/institution'
                },
                first_author_only: {
                    type: 'boolean',
                    description: 'Only return first-author papers'
                },
                interdisciplinary: {
                    type: 'boolean',
                    description: 'Papers spanning 3+ subject areas'
                }
            },
            additionalProperties: false
        },
        sort: {
            type: 'string',
            enum: ['relevance', 'date', 'citations', 'impact', 'normalized'],
            default: 'relevance',
            description: 'Sort order. impact = citation-weighted, normalized = balanced BM25+kNN'
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
                    subject_area: { type: 'array' },
                    citation_count: { type: 'integer' },
                    link: { type: 'string' }
                }
            }
        },
        related_faculty: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    _id: { type: 'string' },
                    name: { type: 'string' },
                    email: { type: 'string' },
                    department: { 
                        type: 'object',
                        properties: {
                            _id: { type: 'string' },
                            name: { type: 'string' }
                        },
                        nullable: true
                    },
                    paperCount: { type: 'integer' }
                }
            }
        },
        facets: {
            type: 'object',
            properties: {
                years: { type: 'array' },
                year_ranges: { type: 'array' },
                document_types: { type: 'array' },
                fields: { type: 'array' },
                subject_areas: { type: 'array' }
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

export const similarRequestSchema = {
    type: 'object',
    properties: {
        limit: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            default: 10,
            description: 'Number of similar papers to return'
        }
    }
};

export const coauthorsParamsSchema = {
    type: 'object',
    required: ['id'],
    properties: {
        id: {
            type: 'string',
            description: 'Author ID to find collaborators for'
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
