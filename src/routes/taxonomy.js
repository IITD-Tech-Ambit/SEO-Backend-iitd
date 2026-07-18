import {
    departmentsResponseSchema,
    themesRequestSchema, themesResponseSchema,
    domainsRequestSchema, domainsResponseSchema,
    subdomainsRequestSchema, subdomainsParamsSchema, subdomainsResponseSchema,
    countsRequestSchema, countsResponseSchema,
    facultyRequestSchema, facultyResponseSchema,
    facultyPapersParamsSchema, facultyPapersRequestSchema, facultyPapersResponseSchema
} from '../schemas/taxonomy.js';
import { errorResponseSchema } from '../schemas/search.js';
import {
    listDepartments, listThemes, listDomains, listSubdomains,
    getCounts, getFaculty, getFacultyPapers
} from '../controllers/taxonomyController.js';

/**
 * Browse state = optional, freely combinable query params:
 *   ?theme=<slug> & domain=<slug> & subdomain=<slug> & department=<code>
 */
export default async function taxonomyRoutes(fastify, options) {
    const { taxonomyService } = options;

    fastify.get('/taxonomy/departments', {
        schema: {
            description: 'Departments that have classified papers (for the department filter)',
            tags: ['taxonomy'],
            response: { 200: departmentsResponseSchema, 500: errorResponseSchema }
        },
        handler: (request, reply) => listDepartments(request, reply, taxonomyService)
    });

    fastify.get('/taxonomy/themes', {
        schema: {
            description: 'List thematic areas with paper/faculty counts, optionally department-filtered',
            tags: ['taxonomy'],
            querystring: themesRequestSchema,
            response: { 200: themesResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema }
        },
        handler: (request, reply) => listThemes(request, reply, taxonomyService)
    });

    fastify.get('/taxonomy/domains', {
        schema: {
            description: 'List domains with counts, optionally filtered by theme and/or department',
            tags: ['taxonomy'],
            querystring: domainsRequestSchema,
            response: { 200: domainsResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema }
        },
        handler: (request, reply) => listDomains(request, reply, taxonomyService)
    });

    fastify.get('/taxonomy/domains/:domainSlug/subdomains', {
        schema: {
            description: 'List subdomains of a domain with counts, optionally filtered by theme and/or department',
            tags: ['taxonomy'],
            params: subdomainsParamsSchema,
            querystring: subdomainsRequestSchema,
            response: { 200: subdomainsResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema }
        },
        handler: (request, reply) => listSubdomains(request, reply, taxonomyService)
    });

    fastify.get('/taxonomy/counts', {
        schema: {
            description: 'Paper/faculty counts for one exact browse configuration',
            tags: ['taxonomy'],
            querystring: countsRequestSchema,
            response: { 200: countsResponseSchema, 400: errorResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema }
        },
        handler: (request, reply) => getCounts(request, reply, taxonomyService)
    });

    fastify.get('/taxonomy/faculty', {
        schema: {
            description: 'Kerberos IDs of faculty in a browse configuration (cards resolve via the directory API)',
            tags: ['taxonomy'],
            querystring: facultyRequestSchema,
            response: { 200: facultyResponseSchema, 400: errorResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema }
        },
        handler: (request, reply) => getFaculty(request, reply, taxonomyService)
    });

    fastify.get('/taxonomy/faculty/:kerberos/papers', {
        schema: {
            description: "One faculty member's papers within a browse configuration",
            tags: ['taxonomy'],
            params: facultyPapersParamsSchema,
            querystring: facultyPapersRequestSchema,
            response: { 200: facultyPapersResponseSchema, 400: errorResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema }
        },
        handler: (request, reply) => getFacultyPapers(request, reply, taxonomyService)
    });
}
