/**
 * JSON schemas for the taxonomy browse endpoints.
 * Browse state is carried by optional, freely combinable query params:
 * theme / domain / subdomain (slugs) and department (code).
 */

const slugPattern = '^[a-z0-9][a-z0-9-]*$';

const browseFilterProps = {
    theme: { type: 'string', pattern: slugPattern },
    domain: { type: 'string', pattern: slugPattern },
    subdomain: { type: 'string', pattern: slugPattern },
    department: { type: 'string', minLength: 1, maxLength: 32 }
};

const paginationProps = {
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
};

const metaSchema = {
    type: 'object',
    properties: {
        took_ms: { type: 'integer' },
        cache_hit: { type: 'boolean' }
    }
};

const paginationSchema = {
    type: 'object',
    properties: {
        page: { type: 'integer' },
        per_page: { type: 'integer' },
        total: { type: 'integer' },
        total_pages: { type: 'integer' }
    }
};

const nodeSchema = {
    type: 'object',
    properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        slug: { type: 'string' },
        paper_count: { type: 'integer' },
        faculty_count: { type: 'integer' },
        subdomain_count: { type: 'integer' }
    }
};

export const departmentsResponseSchema = {
    type: 'object',
    properties: {
        departments: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    code: { type: 'string' }
                }
            }
        },
        meta: metaSchema
    }
};

export const themesRequestSchema = {
    type: 'object',
    properties: { department: browseFilterProps.department }
};

export const themesResponseSchema = {
    type: 'object',
    properties: {
        themes: { type: 'array', items: nodeSchema },
        meta: metaSchema
    }
};

export const domainsRequestSchema = {
    type: 'object',
    properties: {
        theme: browseFilterProps.theme,
        department: browseFilterProps.department
    }
};

export const domainsResponseSchema = {
    type: 'object',
    properties: {
        domains: { type: 'array', items: nodeSchema },
        meta: metaSchema
    }
};

export const subdomainsRequestSchema = domainsRequestSchema;

export const subdomainsParamsSchema = {
    type: 'object',
    required: ['domainSlug'],
    properties: {
        domainSlug: { type: 'string', pattern: slugPattern }
    }
};

export const subdomainsResponseSchema = {
    type: 'object',
    properties: {
        domain: {
            type: 'object',
            properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                slug: { type: 'string' }
            }
        },
        subdomains: { type: 'array', items: nodeSchema },
        meta: metaSchema
    }
};

export const countsRequestSchema = {
    type: 'object',
    properties: browseFilterProps
};

export const countsResponseSchema = {
    type: 'object',
    properties: {
        paper_count: { type: 'integer' },
        faculty_count: { type: 'integer' },
        meta: metaSchema
    }
};

export const facultyRequestSchema = {
    type: 'object',
    properties: { ...browseFilterProps, ...paginationProps }
};

export const facultyResponseSchema = {
    type: 'object',
    properties: {
        kerberos_list: { type: 'array', items: { type: 'string' } },
        faculty_total: { type: 'integer' },
        pagination: paginationSchema,
        meta: metaSchema
    }
};

export const facultyPapersParamsSchema = {
    type: 'object',
    required: ['kerberos'],
    properties: {
        kerberos: { type: 'string', minLength: 1, maxLength: 64 }
    }
};

export const facultyPapersRequestSchema = {
    type: 'object',
    properties: {
        theme: browseFilterProps.theme,
        domain: browseFilterProps.domain,
        subdomain: browseFilterProps.subdomain,
        ...paginationProps
    }
};

export const facultyPapersResponseSchema = {
    type: 'object',
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                    abstract: { type: 'string' },
                    link: { type: ['string', 'null'] },
                    publication_year: { type: ['integer', 'null'] },
                    document_type: { type: ['string', 'null'] },
                    citation_count: { type: 'integer' },
                    topics: { type: 'array', items: { type: 'string' } }
                }
            }
        },
        pagination: paginationSchema,
        meta: metaSchema
    }
};
