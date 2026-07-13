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
                author_id: {
                    type: 'string',
                    description: 'Filter by specific author ID'
                },
                first_author_only: {
                    type: 'boolean',
                    description: 'Only return first-author papers'
                },
                interdisciplinary: {
                    type: 'boolean',
                    description: 'Papers spanning 3+ subject areas'
                },
                kerberos: {
                    type: 'string',
                    description: 'Filter by faculty kerberos ID (matches email prefix)'
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
            maximum: 10000,
            default: 1,
            description: 'Page number. Deep pages beyond the reranked window are served in raw hybrid-score order; the service clamps total_pages so a valid page never exceeds OpenSearch max_result_window (from + size ≤ 10000).'
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
            description: 'Original query to refine within. When set, results must match BOTH this AND the main query. Legacy single-step form of refine_chain.'
        },
        refine_chain: {
            type: 'array',
            items: { type: 'string', maxLength: 500 },
            maxItems: 8,
            description: 'Ordered prior queries (oldest first) for multi-step refinement. Results must match the main query AND every entry; each entry is applied as a strict lexical filter so the result set narrows monotonically.'
        },
        rerank: {
            type: 'boolean',
            description: 'Advanced mode only. When false, returns the first-stage hybrid ranking without cross-encoder reranking. Defaults to the server reranker setting.'
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
                    reference_count: { type: 'integer' },
                    link: { type: 'string' },
                    document_eid: { type: 'string' },
                    document_scopus_id: { type: 'string' },
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
                ranked_window: { type: 'integer', description: 'Number of top candidates cross-encoder reranked (transparency only). Pages within this window are reranked; deeper pages are paginated in raw hybrid-score order.' },
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
        message: {
            type: 'string',
            description: 'Optional message about the search results'
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

export const authorScopedSearchRequestSchema = {
    type: 'object',
    required: ['query', 'author_id'],
    properties: {
        query: {
            type: 'string',
            minLength: 1,
            maxLength: 500,
            description: 'Search query string'
        },
        author_id: {
            type: 'string',
            minLength: 1,
            description: 'Scopus author ID'
        },
        page: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 1
        },
        per_page: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: 20
        },
        mode: {
            type: 'string',
            enum: ['basic', 'advanced'],
            default: 'advanced'
        },
        refine_within: {
            type: 'string',
            maxLength: 500,
            description: 'Original query to refine within. When set, results must match BOTH this AND the main query. Legacy single-step form of refine_chain.'
        },
        refine_chain: {
            type: 'array',
            items: { type: 'string', maxLength: 500 },
            maxItems: 8,
            description: 'Ordered prior queries (oldest first) for multi-step refinement; each entry is a strict lexical filter that narrows the result set.'
        },
        search_in: {
            type: 'array',
            items: {
                type: 'string',
                enum: ['title', 'abstract', 'author', 'subject_area', 'field']
            },
            description: 'Same as POST /search. When set, constrains BM25 (and refine_within) to those fields; basic = strict, advanced = fuzzy where applicable.'
        },
        filters: {
            // Same facet filters as POST /search so the drill-down paper count matches the
            // People sidebar per-faculty count for the same query+filters.
            type: 'object',
            properties: {
                year_from: { type: 'integer', minimum: 1900, maximum: 2100 },
                year_to: { type: 'integer', minimum: 1900, maximum: 2100 },
                field_associated: { type: 'string' },
                document_type: { type: 'string' },
                document_types: { type: 'array', items: { type: 'string' } },
                subject_area: { type: 'array', items: { type: 'string' } },
                author_id: { type: 'string' },
                first_author_only: { type: 'boolean' },
                interdisciplinary: { type: 'boolean' },
                kerberos: { type: 'string' }
            },
            additionalProperties: false
        }
    },
    additionalProperties: false
};

export const authorScopedSearchResponseSchema = {
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
                    reference_count: { type: 'integer' },
                    link: { type: 'string' },
                    document_eid: { type: 'string' },
                    document_scopus_id: { type: 'string' },
                    open_search_id: { type: 'string' },
                    similarity_score: { type: 'number' }
                }
            }
        },
        author: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                author_id: { type: 'string' },
                total_papers: { type: 'integer' }
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

export const errorResponseSchema = {
    type: 'object',
    properties: {
        error: { type: 'string' },
        message: { type: 'string' },
        statusCode: { type: 'integer' }
    }
};

export const facultyForQueryRequestSchema = {
    type: 'object',
    required: ['query'],
    properties: {
        query: {
            type: 'string',
            minLength: 1,
            maxLength: 500,
            description: 'Search query to find related faculty'
        },
        mode: {
            type: 'string',
            enum: ['basic', 'advanced'],
            default: 'advanced',
            description: 'Search mode to apply keyword strictness'
        },
        search_in: {
            type: 'string',
            maxLength: 200,
            description: 'Comma-separated field list matching POST /search search_in (e.g. author or title,abstract)'
        },
        refine_within: {
            type: 'string',
            maxLength: 500,
            description: 'Optional base query when refining (same as POST /search refine_within)'
        },
        refine_chain: {
            type: 'string',
            maxLength: 2000,
            description: 'JSON-encoded array of ordered prior queries (oldest first) for multi-step refinement, matching POST /search refine_chain. Parsed and applied as strict lexical filters.'
        },
        filters: {
            type: 'string',
            maxLength: 2000,
            description: 'JSON-encoded facet filters identical to POST /search filters (year_from, year_to, document_type, etc.). Applied so total_matching_papers matches POST /search pagination.total.'
        }
    },
    additionalProperties: false
};

export const facultyForQueryResponseSchema = {
    type: 'object',
    properties: {
        departments: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    faculty: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                author_id: { type: 'string' },
                                paper_count: { type: 'integer' },
                                relevance_score: { type: 'number' }
                            }
                        }
                    },
                    total_paper_count: { type: 'integer' }
                }
            }
        },
        total_faculty: { type: 'integer' },
        total_matching_papers: { type: 'integer' },
        meta: {
            type: 'object',
            properties: {
                took_ms: { type: 'number' },
                cache_hit: { type: 'boolean' }
            }
        }
    }
};
