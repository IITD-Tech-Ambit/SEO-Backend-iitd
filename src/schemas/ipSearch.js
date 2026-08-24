import { createEncodedFiltersParser } from './search.js';

/** Reject unknown filter keys. Fastify strips extras under additionalProperties:false. */
const closedFilters = (properties) => ({
    type: 'object',
    properties,
    propertyNames: { enum: Object.keys(properties) },
    additionalProperties: false
});

/** Reject unknown top-level request fields. */
const closedRequest = (schema) => ({
    ...schema,
    propertyNames: { enum: Object.keys(schema.properties) },
    additionalProperties: false
});

export const ipSearchRequestSchema = closedRequest({
    type: 'object',
    required: ['query'],
    properties: {
        query: {
            type: 'string',
            minLength: 0,
            maxLength: 500,
            description: 'Search query string. Empty string with filters set runs a filter-only browse (e.g. "browse by department") with no text-relevance gate.'
        },
        filters: closedFilters({
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
                description: 'Exact department name filter (department_name.keyword)'
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
        }),
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
    }
});

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
                    highlight: {
                        type: 'object',
                        properties: {
                            title: { type: 'string' },
                            abstract: { type: 'string' }
                        }
                    },
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
                    profile_image_url: { type: 'string', nullable: true },
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
                classification: { type: 'array' },
                department: { type: 'array' }
            }
        },
        pagination: {
            type: 'object',
            properties: {
                page: { type: 'integer' },
                per_page: { type: 'integer' },
                total: { type: 'integer' },
                ranked_window: { type: 'integer', description: 'Number of top candidates the cross-encoder actually reranked (0 if this page was supposed to be reranked and the call failed or was skipped).' },
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
        reranked: {
            type: 'boolean',
            description: 'True only when this page\'s results were reordered by the cross-encoder. False when rerank failed, was disabled, was declined (`rerank: false`), or this page is past the reranked window.'
        },
        mode: {
            type: 'string',
            enum: ['basic', 'advanced', 'browse'],
            description: 'Search mode used: basic (BM25-only), advanced (hybrid BM25 + semantic), or browse (filter-only, no query text)'
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
        details: { type: 'array', items: { type: 'object', additionalProperties: true } },
        statusCode: { type: 'integer' }
    }
};

export const inventorScopedSearchRequestSchema = closedRequest({
    type: 'object',
    required: ['query', 'inventor_id'],
    properties: {
        query: {
            type: 'string',
            minLength: 0,
            maxLength: 500,
            description: 'Search query string. Empty string runs a filter-only browse of this inventor\'s patents (e.g. a department chip click), with no text-relevance gate.'
        },
        inventor_id: {
            type: 'string',
            minLength: 1,
            description: 'Faculty expert_id OR kerberos of the IITD inventor to scope to'
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
                enum: ['title', 'abstract', 'inventor', 'field_of_invention', 'classification']
            },
            description: 'Same as POST /ip/search. When set, constrains BM25 to those fields.'
        },
        // Same facet filters as POST /ip/search (minus kerberos, which this endpoint sets
        // itself from inventor_id) so the drill-down patent count matches the People
        // sidebar per-inventor count for the same query+filters.
        filters: closedFilters({
            year_from: { type: 'integer', minimum: 1900, maximum: 2100 },
            year_to: { type: 'integer', minimum: 1900, maximum: 2100 },
            type_of_ip: { type: 'string' },
            type_of_ip_list: { type: 'array', items: { type: 'string' } },
            field_of_invention: { type: 'string' },
            classification: { type: 'array', items: { type: 'string' } },
            department: { type: 'string' },
            country: { type: 'string' },
            primary_inventor_only: { type: 'boolean' }
        })
    }
});

export const inventorScopedSearchResponseSchema = {
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
                    highlight: {
                        type: 'object',
                        properties: {
                            title: { type: 'string' },
                            abstract: { type: 'string' }
                        }
                    },
                    type_of_ip: { type: 'string' },
                    field_of_invention: { type: 'string' },
                    classification: { type: 'array' },
                    inventors: { type: 'array' },
                    applicants: { type: 'array' },
                    country: { type: 'string' },
                    publication_year: { type: 'integer' },
                    filing_date: { type: 'string' },
                    publication_date: { type: 'string' },
                    open_search_id: { type: 'string' },
                    similarity_score: { type: 'number' }
                }
            }
        },
        inventor: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                inventor_id: { type: 'string' },
                total_patents: { type: 'integer' }
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

export const ipFacultyForQueryRequestSchema = closedRequest({
    type: 'object',
    required: ['query'],
    properties: {
        query: {
            type: 'string',
            minLength: 0,
            maxLength: 500,
            description: 'Search query to find related inventors. Empty string with filters set runs a filter-only browse, matching POST /ip/search.'
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
            description: 'Comma-separated field list matching POST /ip/search search_in'
        },
        refine_chain: {
            type: 'string',
            maxLength: 2000,
            description: 'JSON-encoded array of ordered prior queries, matching POST /ip/search refine_chain'
        },
        filters: {
            type: 'string',
            maxLength: 2000,
            description: 'JSON-encoded facet filters identical to POST /ip/search filters, so total_matching_ip matches POST /ip/search pagination.total. Keys are validated against the POST /ip/search allow-list after parsing (see parseIpFacultyForQueryFilters); an unsupported key is a 400, not a silent drop.'
        }
    }
});

export const parseIpFacultyForQueryFilters = createEncodedFiltersParser(ipSearchRequestSchema.properties.filters);

export const ipFacultyForQueryResponseSchema = {
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
                                _id: { type: 'string' },
                                name: { type: 'string' },
                                expert_id: { type: 'string' },
                                kerberos: { type: 'string' },
                                profile_image_url: { type: 'string', nullable: true },
                                ipCount: { type: 'integer' }
                            }
                        }
                    },
                    total_ip_count: { type: 'integer' }
                }
            }
        },
        total_faculty: { type: 'integer' },
        total_matching_ip: { type: 'integer' },
        meta: {
            type: 'object',
            properties: {
                took_ms: { type: 'number' },
                cache_hit: { type: 'boolean' }
            }
        }
    }
};
