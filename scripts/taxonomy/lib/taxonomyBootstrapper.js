import { slugifyUnique } from './slugify.js';

/**
 * Bootstraps the taxonomy node collections (ThematicArea, Domain, Subdomain)
 * from the distinct values in the classification CSV, and exposes name -> _id
 * maps for the per-paper write phase.
 *
 * Re-verifies (rather than trusts) that Sub_Domain -> Domain is 1:1: throws
 * if any subdomain appears under two different domains in the CSV.
 */
export default class TaxonomyBootstrapper {
    constructor({ ThematicArea, Domain, Subdomain }) {
        this.ThematicArea = ThematicArea;
        this.Domain = Domain;
        this.Subdomain = Subdomain;

        this.themeNames = new Set();
        this.domainNames = new Set();
        this.subdomainToDomain = new Map();

        this.themeIdByName = new Map();
        this.domainIdByName = new Map();
        this.subdomainIdByName = new Map();
    }

    collect(rows) {
        for (const row of rows) {
            const theme = String(row.Broad_Theme || '').trim();
            const domain = String(row.Domain || '').trim();
            const subdomain = String(row.Sub_Domain || '').trim();
            if (theme) this.themeNames.add(theme);
            if (domain) this.domainNames.add(domain);
            if (subdomain && domain) {
                const existing = this.subdomainToDomain.get(subdomain);
                if (existing && existing !== domain) {
                    throw new Error(
                        `Sub_Domain -> Domain is not 1:1: "${subdomain}" maps to both "${existing}" and "${domain}"`
                    );
                }
                this.subdomainToDomain.set(subdomain, domain);
            }
        }
        return {
            themes: this.themeNames.size,
            domains: this.domainNames.size,
            subdomains: this.subdomainToDomain.size
        };
    }

    /**
     * Idempotent upserts keyed on name; safe to re-run. Populates the id maps.
     * @param {boolean} dryRun when true, writes nothing and fills id maps with nulls
     */
    async upsertNodes(dryRun) {
        if (dryRun) {
            for (const name of this.themeNames) this.themeIdByName.set(name, null);
            for (const name of this.domainNames) this.domainIdByName.set(name, null);
            for (const name of this.subdomainToDomain.keys()) this.subdomainIdByName.set(name, null);
            return;
        }

        const themeSlugs = slugifyUnique([...this.themeNames].sort());
        await this.ThematicArea.bulkWrite([...themeSlugs.entries()].map(([name, slug], i) => ({
            updateOne: {
                filter: { name },
                update: { $set: { slug }, $setOnInsert: { name, display_order: i } },
                upsert: true
            }
        })));

        const domainSlugs = slugifyUnique([...this.domainNames].sort());
        await this.Domain.bulkWrite([...domainSlugs.entries()].map(([name, slug], i) => ({
            updateOne: {
                filter: { name },
                update: { $set: { slug }, $setOnInsert: { name, display_order: i } },
                upsert: true
            }
        })));

        for (const doc of await this.ThematicArea.find({}).lean()) {
            this.themeIdByName.set(doc.name, doc._id);
        }
        for (const doc of await this.Domain.find({}).lean()) {
            this.domainIdByName.set(doc.name, doc._id);
        }

        const subdomainNames = [...this.subdomainToDomain.keys()].sort();
        const subdomainSlugs = slugifyUnique(subdomainNames);
        await this.Subdomain.bulkWrite(subdomainNames.map((name, i) => ({
            updateOne: {
                filter: { name, domain_id: this.domainIdByName.get(this.subdomainToDomain.get(name)) },
                update: {
                    $set: { slug: subdomainSlugs.get(name) },
                    $setOnInsert: { name, display_order: i }
                },
                upsert: true
            }
        })));

        for (const doc of await this.Subdomain.find({}).lean()) {
            this.subdomainIdByName.set(doc.name, doc._id);
        }
    }
}
