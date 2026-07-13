import { TaxonomyNotFoundError, TaxonomyBadRequestError } from '../services/taxonomy/errors.js';

/**
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

export async function listDepartments(request, reply, taxonomyService) {
    return respond(request, reply, () =>
        taxonomyService.listDepartments());
}

export async function listThemes(request, reply, taxonomyService) {
    const { department } = request.query;
    return respond(request, reply, () =>
        taxonomyService.listThemes({ department }));
}

export async function listDomains(request, reply, taxonomyService) {
    const { theme, department } = request.query;
    return respond(request, reply, () =>
        taxonomyService.listDomains({ theme, department }));
}

export async function listSubdomains(request, reply, taxonomyService) {
    const { domainSlug } = request.params;
    const { theme, department } = request.query;
    return respond(request, reply, () =>
        taxonomyService.listSubdomains({ domain: domainSlug, theme, department }));
}

export async function getCounts(request, reply, taxonomyService) {
    const { theme, domain, subdomain, department } = request.query;
    return respond(request, reply, () =>
        taxonomyService.getCounts({ theme, domain, subdomain, department }));
}

export async function getFaculty(request, reply, taxonomyService) {
    const { theme, domain, subdomain, department, page, per_page } = request.query;
    return respond(request, reply, () =>
        taxonomyService.getFaculty({ theme, domain, subdomain, department, page, per_page }));
}

export async function getFacultyPapers(request, reply, taxonomyService) {
    const { kerberos } = request.params;
    const { theme, domain, subdomain, page, per_page } = request.query;
    return respond(request, reply, () =>
        taxonomyService.getFacultyPapers({ kerberos, theme, domain, subdomain, page, per_page }));
}
