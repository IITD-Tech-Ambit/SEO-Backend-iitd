import TaxonomyCatalog from './TaxonomyCatalog.js';
import TaxonomyRepository from './TaxonomyRepository.js';
import TaxonomyCache from './TaxonomyCache.js';
import { TaxonomyNotFoundError, TaxonomyBadRequestError } from './errors.js';

/**
 * Orchestrates the taxonomy browse read path: resolves URL identifiers
 * (slugs / department code) through the in-memory catalog, serves responses
 * Redis-first, and reads precomputed rollup rows through the repository.
 * Nothing here computes counts — the rollup job already did.
 */
export default class TaxonomyService {
    constructor({ mongoose, redis, logger, config }) {
        this.logger = logger;
        this.cfg = config.taxonomy;

        this.catalog = new TaxonomyCatalog({
            mongoose,
            logger,
            refreshMs: this.cfg.catalogRefreshMs
        });
        this.repository = new TaxonomyRepository({ mongoose });
        this.cache = new TaxonomyCache({ redis, logger });
    }

    async init() {
        await this.catalog.init();
    }

    close() {
        this.catalog.close();
    }

    /**
     * Resolve the browse configuration from URL identifiers to ObjectIds.
     * A subdomain implies its parent domain (and must match one given explicitly).
     * Throws TaxonomyNotFoundError / TaxonomyBadRequestError.
     */
    resolveConfig({ theme, domain, subdomain, department } = {}) {
        const themeDoc = this.catalog.themeBySlug(theme);
        if (theme && !themeDoc) throw new TaxonomyNotFoundError('theme', theme);

        let domainDoc = this.catalog.domainBySlug(domain);
        if (domain && !domainDoc) throw new TaxonomyNotFoundError('domain', domain);

        const subdomainDoc = this.catalog.subdomainBySlug(subdomain);
        if (subdomain && !subdomainDoc) throw new TaxonomyNotFoundError('subdomain', subdomain);
        if (subdomainDoc) {
            if (domainDoc && String(subdomainDoc.domain_id) !== String(domainDoc._id)) {
                throw new TaxonomyBadRequestError(
                    `Subdomain "${subdomain}" does not belong to domain "${domain}"`
                );
            }
            domainDoc = domainDoc || this.catalog.domains()
                .find(d => String(d._id) === String(subdomainDoc.domain_id)) || null;
        }

        const departmentDoc = this.catalog.departmentByCode(department);
        if (department && !departmentDoc) throw new TaxonomyNotFoundError('department', department);

        return {
            themeId: themeDoc?._id ?? null,
            domainId: domainDoc?._id ?? null,
            subdomainId: subdomainDoc?._id ?? null,
            departmentId: departmentDoc?._id ?? null,
            themeDoc, domainDoc, subdomainDoc, departmentDoc
        };
    }

    static _nodeView(node, counts) {
        return {
            id: String(node._id),
            name: node.name,
            slug: node.slug,
            paper_count: counts?.paper_count ?? node.stats?.paper_count ?? 0,
            faculty_count: counts?.faculty_count ?? node.stats?.faculty_count ?? 0
        };
    }

    /** Join cube rows onto catalog nodes; nodes without a row have zero papers and are omitted. */
    static _joinCounts(nodes, rows, rowIdField) {
        const byNode = new Map(rows.map(r => [String(r[rowIdField]), r]));
        return nodes
            .filter(n => byNode.has(String(n._id)))
            .map(n => TaxonomyService._nodeView(n, byNode.get(String(n._id))));
    }

    async listDepartments() {
        const key = this.cache.key('departments');
        return this.cache.through(key, this.cfg.redisTtl, async () => {
            const rows = await this.repository.listDepartmentsWithPapers();
            return {
                departments: rows.map(r => ({ id: String(r._id), name: r.name, code: r.code }))
            };
        });
    }

    async listThemes({ department } = {}) {
        const { departmentId } = this.resolveConfig({ department });
        const key = this.cache.key('themes', department);
        return this.cache.through(key, this.cfg.redisTtl, async () => {
            const nodes = this.catalog.themes();
            if (!departmentId) {
                return { themes: nodes.map(n => TaxonomyService._nodeView(n)) };
            }
            const rows = await this.repository.listThemeCounts({ departmentId });
            return { themes: TaxonomyService._joinCounts(nodes, rows, 'thematic_area_id') };
        });
    }

    async listDomains({ theme, department } = {}) {
        const { themeId, departmentId } = this.resolveConfig({ theme, department });
        const key = this.cache.key('domains', theme, department);
        return this.cache.through(key, this.cfg.redisTtl, async () => {
            const nodes = this.catalog.domains();
            const withSubCount = (view, node) => ({
                ...view,
                subdomain_count: node.stats?.subdomain_count ?? 0
            });
            if (!themeId && !departmentId) {
                return { domains: nodes.map(n => withSubCount(TaxonomyService._nodeView(n), n)) };
            }
            const rows = await this.repository.listDomainCounts({ themeId, departmentId });
            const byNode = new Map(nodes.map(n => [String(n._id), n]));
            return {
                domains: TaxonomyService._joinCounts(nodes, rows, 'domain_id')
                    .map(v => withSubCount(v, byNode.get(v.id)))
            };
        });
    }

    async listSubdomains({ domain, theme, department } = {}) {
        const { themeId, domainId, domainDoc, departmentId } =
            this.resolveConfig({ domain, theme, department });
        if (!domainDoc) throw new TaxonomyNotFoundError('domain', domain);

        const key = this.cache.key('subdomains', domain, theme, department);
        return this.cache.through(key, this.cfg.redisTtl, async () => {
            const nodes = this.catalog.subdomainsOf(domainId);
            const domainView = { id: String(domainDoc._id), name: domainDoc.name, slug: domainDoc.slug };
            if (!themeId && !departmentId) {
                return { domain: domainView, subdomains: nodes.map(n => TaxonomyService._nodeView(n)) };
            }
            const rows = await this.repository.listSubdomainCounts({ domainId, themeId, departmentId });
            return { domain: domainView, subdomains: TaxonomyService._joinCounts(nodes, rows, 'subdomain_id') };
        });
    }

    async getCounts({ theme, domain, subdomain, department } = {}) {
        const { themeId, domainId, subdomainId, departmentId } =
            this.resolveConfig({ theme, domain, subdomain, department });
        const key = this.cache.key('counts', theme, domain, subdomain, department);
        return this.cache.through(key, this.cfg.redisTtl, async () => {
            const row = await this.repository.getConfigCounts({ themeId, domainId, subdomainId, departmentId });
            return {
                paper_count: row?.paper_count ?? 0,
                faculty_count: row?.faculty_count ?? 0
            };
        });
    }

    async getFaculty({ theme, domain, subdomain, department, page, per_page } = {}) {
        const { themeId, domainId, subdomainId, departmentId } =
            this.resolveConfig({ theme, domain, subdomain, department });

        // Cache the whole precomputed list once, slice per request in-process —
        // cheaper than one cache entry per page.
        const key = this.cache.key('faculty', theme, domain, subdomain, department);
        const { value, cacheHit } = await this.cache.through(key, this.cfg.redisTtl, async () => {
            const row = await this.repository.getConfigMembers({ themeId, domainId, subdomainId, departmentId });
            return {
                kerberos_list: row?.kerberos_list ?? [],
                faculty_total: row?.faculty_total ?? 0
            };
        });

        const perPage = Math.min(per_page || this.cfg.defaultPerPage, this.cfg.maxPerPage);
        const currentPage = page || 1;
        const start = (currentPage - 1) * perPage;
        return {
            value: {
                kerberos_list: value.kerberos_list.slice(start, start + perPage),
                faculty_total: value.faculty_total,
                pagination: {
                    page: currentPage,
                    per_page: perPage,
                    total: value.faculty_total,
                    total_pages: Math.ceil(value.faculty_total / perPage)
                }
            },
            cacheHit
        };
    }

    async getFacultyPapers({ kerberos, theme, domain, subdomain, page, per_page } = {}) {
        const { themeId, domainId, subdomainId } = this.resolveConfig({ theme, domain, subdomain });
        const normalizedKerberos = String(kerberos || '').toLowerCase().trim();
        if (!normalizedKerberos) throw new TaxonomyBadRequestError('kerberos is required');

        const perPage = Math.min(per_page || this.cfg.defaultPerPage, this.cfg.maxPerPage);
        const currentPage = page || 1;

        const key = this.cache.key('papers', normalizedKerberos, theme, domain, subdomain, currentPage, perPage);
        return this.cache.through(key, this.cfg.papersRedisTtl, async () => {
            const { items, total } = await this.repository.findPapersInContext({
                themeId, domainId, subdomainId,
                kerberos: normalizedKerberos,
                page: currentPage,
                perPage
            });
            return {
                results: items.map(p => ({
                    id: String(p._id),
                    title: p.title,
                    abstract: p.abstract,
                    link: p.link ?? null,
                    publication_year: p.publication_year ?? null,
                    document_type: p.document_type ?? null,
                    citation_count: p.citation_count ?? 0,
                    topics: p.classification?.topics ?? []
                })),
                pagination: {
                    page: currentPage,
                    per_page: perPage,
                    total,
                    total_pages: Math.ceil(total / perPage)
                }
            };
        });
    }
}
