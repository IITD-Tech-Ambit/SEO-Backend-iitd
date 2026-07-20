import grpc from '@grpc/grpc-js';
import { TaxonomyNotFoundError, TaxonomyBadRequestError } from '../../services/taxonomy/errors.js';

/**
 * search.v1.TaxonomyService handlers — thin adapters over the existing
 * TaxonomyService (the same instance the REST /api/v1/taxonomy/* routes use).
 * Every taxonomy read is deterministic, so responses are mapped to typed proto
 * messages (no `*_json`). Domain errors map to gRPC statuses the way the REST
 * controller maps them to HTTP codes.
 */

function metaFor(startTime, cacheHit) {
    return { took_ms: Date.now() - startTime, cache_hit: Boolean(cacheHit) };
}

// Optional slug/code filters arrive as '' when unset (proto3 default); the
// TaxonomyService treats falsy identifiers as "no filter", so pass through as-is.
function optional(v) {
    return v || undefined;
}

export function createTaxonomyServiceHandlers({ taxonomyService, logger }) {
    // Shared error translation: typed domain errors -> gRPC status, matching the
    // REST controller's 404 / 400 / 500 mapping.
    function handleError(error, callback, context) {
        if (error instanceof TaxonomyNotFoundError) {
            return callback({ code: grpc.status.NOT_FOUND, message: error.message });
        }
        if (error instanceof TaxonomyBadRequestError) {
            return callback({ code: grpc.status.INVALID_ARGUMENT, message: error.message });
        }
        logger.error({ err: error, ...context }, 'gRPC taxonomy request failed');
        callback({ code: grpc.status.INTERNAL, message: error.message });
    }

    return {
        // GET /api/v1/taxonomy/departments
        async GetDepartments(call, callback) {
            const startTime = Date.now();
            try {
                const { value, cacheHit } = await taxonomyService.listDepartments();
                callback(null, {
                    departments: (value.departments || []).map((d) => ({
                        id: d.id || '',
                        name: d.name || '',
                        code: d.code || ''
                    })),
                    meta: metaFor(startTime, cacheHit)
                });
            } catch (error) {
                handleError(error, callback, {});
            }
        },

        // GET /api/v1/taxonomy/themes
        async GetThemes(call, callback) {
            const startTime = Date.now();
            try {
                const { value, cacheHit } = await taxonomyService.listThemes({
                    department: optional(call.request.department)
                });
                callback(null, {
                    themes: (value.themes || []).map((t) => ({
                        id: t.id || '',
                        name: t.name || '',
                        slug: t.slug || '',
                        paper_count: t.paper_count || 0,
                        faculty_count: t.faculty_count || 0
                    })),
                    meta: metaFor(startTime, cacheHit)
                });
            } catch (error) {
                handleError(error, callback, {});
            }
        },

        // GET /api/v1/taxonomy/domains
        async GetDomains(call, callback) {
            const startTime = Date.now();
            try {
                const { value, cacheHit } = await taxonomyService.listDomains({
                    theme: optional(call.request.theme),
                    department: optional(call.request.department)
                });
                callback(null, {
                    domains: (value.domains || []).map((d) => ({
                        id: d.id || '',
                        name: d.name || '',
                        slug: d.slug || '',
                        paper_count: d.paper_count || 0,
                        faculty_count: d.faculty_count || 0,
                        subdomain_count: d.subdomain_count || 0
                    })),
                    meta: metaFor(startTime, cacheHit)
                });
            } catch (error) {
                handleError(error, callback, {});
            }
        },

        // GET /api/v1/taxonomy/domains/:domainSlug/subdomains
        async GetSubdomains(call, callback) {
            const startTime = Date.now();
            const { domain_slug: domainSlug } = call.request;
            if (!domainSlug) {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'domain_slug is required' });
            }
            try {
                const { value, cacheHit } = await taxonomyService.listSubdomains({
                    domain: domainSlug,
                    theme: optional(call.request.theme),
                    department: optional(call.request.department)
                });
                callback(null, {
                    domain: {
                        id: value.domain?.id || '',
                        name: value.domain?.name || '',
                        slug: value.domain?.slug || ''
                    },
                    subdomains: (value.subdomains || []).map((s) => ({
                        id: s.id || '',
                        name: s.name || '',
                        slug: s.slug || '',
                        paper_count: s.paper_count || 0,
                        faculty_count: s.faculty_count || 0
                    })),
                    meta: metaFor(startTime, cacheHit)
                });
            } catch (error) {
                handleError(error, callback, { domainSlug });
            }
        },

        // GET /api/v1/taxonomy/counts
        async GetCounts(call, callback) {
            const startTime = Date.now();
            try {
                const { value, cacheHit } = await taxonomyService.getCounts({
                    theme: optional(call.request.theme),
                    domain: optional(call.request.domain),
                    subdomain: optional(call.request.subdomain),
                    department: optional(call.request.department)
                });
                callback(null, {
                    paper_count: value.paper_count || 0,
                    faculty_count: value.faculty_count || 0,
                    meta: metaFor(startTime, cacheHit)
                });
            } catch (error) {
                handleError(error, callback, {});
            }
        },

        // GET /api/v1/taxonomy/faculty
        async GetFaculty(call, callback) {
            const startTime = Date.now();
            const req = call.request;
            try {
                const { value, cacheHit } = await taxonomyService.getFaculty({
                    theme: optional(req.theme),
                    domain: optional(req.domain),
                    subdomain: optional(req.subdomain),
                    department: optional(req.department),
                    page: req.page || undefined,
                    per_page: req.per_page || undefined
                });
                callback(null, {
                    kerberos_list: value.kerberos_list || [],
                    faculty_total: value.faculty_total || 0,
                    pagination: value.pagination,
                    recommended_count: value.recommended_count || 0,
                    meta: metaFor(startTime, cacheHit)
                });
            } catch (error) {
                handleError(error, callback, {});
            }
        },

        // GET /api/v1/taxonomy/faculty/:kerberos/papers
        async GetFacultyPapers(call, callback) {
            const startTime = Date.now();
            const req = call.request;
            if (!req.kerberos) {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'kerberos is required' });
            }
            try {
                const { value, cacheHit } = await taxonomyService.getFacultyPapers({
                    kerberos: req.kerberos,
                    theme: optional(req.theme),
                    domain: optional(req.domain),
                    subdomain: optional(req.subdomain),
                    page: req.page || undefined,
                    per_page: req.per_page || undefined
                });
                callback(null, {
                    results: (value.results || []).map((p) => {
                        // link / publication_year / document_type are proto `optional`:
                        // omit when null so the wire carries absence, not a zero value.
                        const paper = {
                            id: p.id || '',
                            title: p.title || '',
                            abstract: p.abstract || '',
                            citation_count: p.citation_count || 0,
                            topics: p.topics || []
                        };
                        if (p.link != null) paper.link = p.link;
                        if (p.publication_year != null) paper.publication_year = p.publication_year;
                        if (p.document_type != null) paper.document_type = p.document_type;
                        return paper;
                    }),
                    pagination: value.pagination,
                    meta: metaFor(startTime, cacheHit)
                });
            } catch (error) {
                handleError(error, callback, { kerberos: req.kerberos });
            }
        }
    };
}
