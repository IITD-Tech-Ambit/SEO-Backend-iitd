import { TaxonomyNotFoundError, TaxonomyBadRequestError } from '../services/taxonomy/errors.js';

/**
 * Taxonomy Controller
 * Thin HTTP layer over TaxonomyService: unpack request, map typed domain
 * errors to statuses, attach meta. No data logic here.
 */

async function respond(request, reply, serve) {
    const startTime = Date.now();
    try {
        const { value, cacheHit } = await serve();
        return {
            ...value,
            meta: { took_ms: Date.now() - startTime, cache_hit: cacheHit }
        };
    } catch (error) {
        if (error instanceof TaxonomyNotFoundError) {
            return reply.status(404).send({
                error: 'Not Found',
                message: error.message,
                statusCode: 404
            });
        }
        if (error instanceof TaxonomyBadRequestError) {
            return reply.status(400).send({
                error: 'Bad Request',
                message: error.message,
                statusCode: 400
            });
        }
        request.log.error({ error }, 'Taxonomy request failed');
        return reply.status(500).send({
            error: 'Internal Server Error',
            message: error.message,
            statusCode: 500
        });
    }
}

export async function listDepartments(request, reply) {
    return respond(request, reply, () =>
        request.server.taxonomyService.listDepartments());
}

export async function listThemes(request, reply) {
    const { department } = request.query;
    return respond(request, reply, () =>
        request.server.taxonomyService.listThemes({ department }));
}

export async function listDomains(request, reply) {
    const { theme, department } = request.query;
    return respond(request, reply, () =>
        request.server.taxonomyService.listDomains({ theme, department }));
}

export async function listSubdomains(request, reply) {
    const { domainSlug } = request.params;
    const { theme, department } = request.query;
    return respond(request, reply, () =>
        request.server.taxonomyService.listSubdomains({ domain: domainSlug, theme, department }));
}

export async function getCounts(request, reply) {
    const { theme, domain, subdomain, department } = request.query;
    return respond(request, reply, () =>
        request.server.taxonomyService.getCounts({ theme, domain, subdomain, department }));
}

export async function getFaculty(request, reply) {
    const { theme, domain, subdomain, department, page, per_page } = request.query;
    return respond(request, reply, () =>
        request.server.taxonomyService.getFaculty({ theme, domain, subdomain, department, page, per_page }));
}

export async function getFacultyPapers(request, reply) {
    const { kerberos } = request.params;
    const { theme, domain, subdomain, page, per_page } = request.query;
    return respond(request, reply, () =>
        request.server.taxonomyService.getFacultyPapers({ kerberos, theme, domain, subdomain, page, per_page }));
}
