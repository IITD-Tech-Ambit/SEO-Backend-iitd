export const ipSearchRequestSchema = {
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
                type_of_ip: {
                    type: 'string',
                    description: 'IP type (e.g. Patent, Copyright, Design)'
                },
                type_of_ip_list: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Multiple IP types'
                },
                field_of_invention: {
                    type: 'string',
                    description: 'Exact field-of-invention filter (keyword)'
                },
                classification: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Classification codes (keyword array)'
                },
                department: {
                    type: 'string',
                    description: 'Department id (department_id keyword)'
                },
                country: {
                    type: 'string',
                    description: 'Filing jurisdiction (e.g. IN)'
                },
                kerberos: {
                    type: 'string',
                    description: 'Filter by faculty inventor kerberos id'
                },
                primary_inventor_only: {
                    type: 'boolean',
                    description: 'Only filings where the match is a primary inventor (inventor_position 0)'
                }
            },
            additionalProperties: false
        },
        sort: {
            type: 'string',
            enum: ['relevance', 'date', 'normalized'],
            default: 'relevance',
            description: 'Sort order. date = newest publication_year then filing_date, normalized = balanced BM25+kNN'
        },
        page: {
            type: 'integer',
            minimum: 1,
            maximum: 10000,
            default: 1,
            description: 'Page number. Deep pages beyond the reranked window are served in raw hybrid-score order; total_pages is clamped so a valid page never exceeds OpenSearch max_result_window.'
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
                enum: ['title', 'abstract', 'inventor', 'field_of_invention', 'classification']
            },
            description: 'When omitted or empty, search all default fields. When set, each query term must match at least one selected field (AND across terms).'
        },
        mode: {
            type: 'string',
            enum: ['basic', 'advanced'],
            default: 'advanced',
            description: 'basic = BM25 keyword only (no ML). advanced = hybrid BM25 + semantic.'
        },
        refine_within: {
            type: 'string',
            maxLength: 500,
            description: 'Original query to refine within. Legacy single-step form of refine_chain.'
        },
        refine_chain: {
            type: 'array',
            items: { type: 'string', maxLength: 500 },
            maxItems: 8,
            description: 'Ordered prior queries (oldest first) for multi-step refinement; each entry is applied as a strict lexical filter so the result set narrows monotonically.'
        },
        rerank: {
            type: 'boolean',
            description: 'Advanced mode only. When false, returns the first-stage hybrid ranking without cross-encoder reranking. Defaults to the server reranker setting.'
        }
    },
    additionalProperties: false
};

export const ipSearchResponseSchema = {
    type: 'object',
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    _id: { type: 'string' },
                    application_number: { type: 'string' },
                    title: { type: 'string' },
                    abstract: { type: 'string' },
                    type_of_ip: { type: 'string' },
                    field_of_invention: { type: 'string' },
                    department: {
                        type: 'object',
                        properties: {
                            _id: { type: 'string' },
                            name: { type: 'string' },
                            code: { type: 'string' }
                        },
                        nullable: true
                    },
                    classification: { type: 'array' },
                    inventors: { type: 'array' },
                    applicants: { type: 'array' },
                    country: { type: 'string' },
                    publication_year: { type: 'integer' },
                    filing_date: { type: 'string' },
                    publication_date: { type: 'string' },
                    open_search_id: { type: 'string' },
                    rerank_score: { type: 'number', description: 'Cross-encoder rerank score (present when reranking is applied)' },
                    fused_score: { type: 'number', description: 'Final fused score: alpha*norm(rerank) + (1-alpha)*norm(firstStage) + literal-title bonus' }
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
                    expert_id: { type: 'string' },
                    kerberos: { type: 'string' },
                    department: {
                        type: 'object',
                        properties: {
                            _id: { type: 'string' },
                            name: { type: 'string' }
                        },
                        nullable: true
                    },
                    ipCount: { type: 'integer' }
                }
            }
        },
        facets: {
            type: 'object',
            properties: {
                years: { type: 'array' },
                type_of_ip: { type: 'array' },
                field_of_invention: { type: 'array' },
                country: { type: 'array' },
                classification: { type: 'array' }
            }
        },
        pagination: {
            type: 'object',
            properties: {
                page: { type: 'integer' },
                per_page: { type: 'integer' },
                total: { type: 'integer' },
                ranked_window: { type: 'integer', description: 'Number of top candidates cross-encoder reranked (transparency only).' },
                total_pages: { type: 'integer', description: 'Derived from the true match count (total), clamped to the deepest page servable within OpenSearch max_result_window.' }
            }
        },
        meta: {
            type: 'object',
            properties: {
                took_ms: { type: 'number' },
                cache_hit: { type: 'boolean' }
            }
        },
        suggestions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Did-you-mean spelling suggestions'
        },
        fuzzy_fallback: {
            type: 'boolean',
            description: 'True if results came from fuzzy fallback search'
        },
        mode: {
            type: 'string',
            enum: ['basic', 'advanced'],
            description: 'Search mode used: basic (BM25-only) or advanced (hybrid BM25 + semantic)'
        },
        match_tier: {
            type: 'string',
            enum: ['phrase', 'terms'],
            description: 'Basic mode only: which recall tier produced the results — "phrase" (contiguous phrase match, tried first) or "terms" (strict per-term AND fallback, used when the phrase tier recalled nothing).'
        },
        message: {
            type: 'string',
            description: 'Optional message about the search results'
        }
    }
};

export const ipDocumentParamsSchema = {
    type: 'object',
    required: ['id'],
    properties: {
        id: {
            type: 'string',
            description: 'MongoDB ObjectId of the IP document'
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
