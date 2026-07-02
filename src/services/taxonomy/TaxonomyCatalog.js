/**
 * In-memory catalog of the small, near-static reference collections the
 * taxonomy read path needs on every request: taxonomy nodes (~230 docs,
 * slug-addressed in URLs) and departments (code-addressed in URLs).
 *
 * Loaded once at startup and refreshed on an interval — the underlying data
 * only changes when the offline ingest/rollup scripts run.
 *
 * Single responsibility: identifier resolution + node listing. No counts,
 * no Redis, no HTTP.
 */
export default class TaxonomyCatalog {
    constructor({ mongoose, logger, refreshMs }) {
        this.mongoose = mongoose;
        this.logger = logger;
        this.refreshMs = refreshMs;

        this.themesBySlug = new Map();
        this.domainsBySlug = new Map();
        this.subdomainsBySlug = new Map();
        this.departmentsByCode = new Map();
        this.subdomainsByDomainId = new Map();

        this._timer = null;
    }

    async init() {
        await this.refresh();
        this._timer = setInterval(() => {
            this.refresh().catch(err =>
                this.logger.warn({ err }, 'taxonomy catalog: refresh failed'));
        }, this.refreshMs);
        this._timer.unref();
    }

    async refresh() {
        const [themes, domains, subdomains, departments] = await Promise.all([
            this.mongoose.model('ThematicArea').find({}).sort({ display_order: 1 }).lean(),
            this.mongoose.model('Domain').find({}).sort({ display_order: 1 }).lean(),
            this.mongoose.model('Subdomain').find({}).sort({ display_order: 1 }).lean(),
            this.mongoose.model('Department').find({}).lean()
        ]);

        this.themesBySlug = new Map(themes.map(n => [n.slug, n]));
        this.domainsBySlug = new Map(domains.map(n => [n.slug, n]));
        this.subdomainsBySlug = new Map(subdomains.map(n => [n.slug, n]));
        this.departmentsByCode = new Map(departments.map(d => [String(d.code).toLowerCase(), d]));

        this.subdomainsByDomainId = new Map();
        for (const s of subdomains) {
            const key = String(s.domain_id);
            if (!this.subdomainsByDomainId.has(key)) this.subdomainsByDomainId.set(key, []);
            this.subdomainsByDomainId.get(key).push(s);
        }

        this.logger.info(
            { themes: themes.length, domains: domains.length, subdomains: subdomains.length },
            'taxonomy catalog: refreshed'
        );
    }

    themes() { return [...this.themesBySlug.values()]; }
    domains() { return [...this.domainsBySlug.values()]; }
    subdomainsOf(domainId) { return this.subdomainsByDomainId.get(String(domainId)) || []; }

    themeBySlug(slug) { return slug ? this.themesBySlug.get(slug) || null : null; }
    domainBySlug(slug) { return slug ? this.domainsBySlug.get(slug) || null : null; }
    subdomainBySlug(slug) { return slug ? this.subdomainsBySlug.get(slug) || null : null; }
    departmentByCode(code) { return code ? this.departmentsByCode.get(String(code).toLowerCase()) || null : null; }

    close() {
        if (this._timer) clearInterval(this._timer);
    }
}
