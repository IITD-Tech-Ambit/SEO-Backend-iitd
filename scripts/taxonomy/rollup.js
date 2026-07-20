/**
 * Taxonomy rollup — precomputes everything the browse read paths serve:
 *   1. ThematicArea/Domain/Subdomain.stats (paper/faculty counts per node)
 *   2. taxonomyfacetcounts — the sparse configuration cube: one row per
 *      (theme?, domain?, subdomain?, department?) combination with papers
 *   3. taxonomyfacetmembers — area-paper-count-ordered kerberos list per combination
 *
 * Run manually, once, after scripts/taxonomy/ingest.js has been verified.
 * Rebuilds the two rollup collections from scratch (delete + insert), so it
 * is idempotent and never leaves stale rows behind.
 *
 * Usage:
 *   MONGODB_URI=mongodb://... node scripts/taxonomy/rollup.js [--dry-run]
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

import '../../src/models/index.js';
import { MASKS, paperCountPipeline, facultyCountPipeline, membersPipeline } from './lib/rollupAggregations.js';
import { computeRecommendedCount } from './lib/recommendedCount.js';
import { invalidateTaxonomyCache } from './lib/cacheInvalidator.js';
import TaxonomyCache from '../../src/services/taxonomy/TaxonomyCache.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const DRY_RUN = process.argv.includes('--dry-run');
const MEMBERS_CAP = 500;
// Default-visible-count ceiling: domain is the leaf level where faculty
// actually get browsed (tighter), theme-only is the broad pre-drill-down
// view (looser). See scripts/taxonomy/lib/recommendedCount.js.
const recommendedCeilingFor = (row) => (row.domain_id ? 12 : 48);

if (!MONGODB_URI) {
    console.error('ERROR: MONGODB_URI is not set');
    process.exit(1);
}

await mongoose.connect(MONGODB_URI);
console.log(`Connected to MongoDB${DRY_RUN ? ' [DRY RUN — no writes]' : ''}\n`);

const ThematicArea = mongoose.model('ThematicArea');
const Domain = mongoose.model('Domain');
const Subdomain = mongoose.model('Subdomain');
const Department = mongoose.model('Department');
const TaxonomyFacetCounts = mongoose.model('TaxonomyFacetCounts');
const TaxonomyFacetMembers = mongoose.model('TaxonomyFacetMembers');
const ResearchDocument = mongoose.model('ResearchMetaDataScopus');

// Reference maps, loaded once
const deptById = new Map(
    (await Department.find({}).lean()).map(d => [String(d._id), d])
);
const comboKey = (id) => [
    id.thematic_area_id ?? '', id.domain_id ?? '', id.subdomain_id ?? '', id.department_id ?? ''
].join('|');

// --- Run all pipelines, merge into one row per configuration -----------------

const rowsByCombo = new Map();

function comboRow(id) {
    const key = comboKey(id);
    if (!rowsByCombo.has(key)) {
        const dept = id.department_id ? deptById.get(String(id.department_id)) : null;
        rowsByCombo.set(key, {
            thematic_area_id: id.thematic_area_id ?? null,
            domain_id: id.domain_id ?? null,
            subdomain_id: id.subdomain_id ?? null,
            department_id: id.department_id ?? null,
            department_name: dept?.name ?? null,
            department_code: dept?.code ?? null,
            paper_count: 0,
            faculty_count: 0,
            member_paper_counts: []
        });
    }
    return rowsByCombo.get(key);
}

for (const mask of MASKS) {
    for (const withDepartment of [false, true]) {
        const [papers, faculty, members] = await Promise.all([
            ResearchDocument.aggregate(paperCountPipeline(mask, withDepartment)),
            ResearchDocument.aggregate(facultyCountPipeline(mask, withDepartment)),
            ResearchDocument.aggregate(membersPipeline(mask, withDepartment))
        ]);
        for (const r of papers) comboRow(r._id).paper_count = r.paper_count;
        for (const r of faculty) comboRow(r._id).faculty_count = r.faculty_count;
        for (const r of members) comboRow(r._id).member_paper_counts = r.member_paper_counts;
    }
    console.log(`Aggregated mask [${mask.join(', ')}]`);
}

const allRows = [...rowsByCombo.values()].filter(r => r.paper_count > 0);
const now = new Date();

// --- 1. Node stats ------------------------------------------------------------

// Node-level stats come from each level's own-mask, all-departments rows:
//   theme     -> mask (T):    theme set, domain/subdomain/department null
//   domain    -> mask (D):    domain set, theme/subdomain/department null
//   subdomain -> mask (D,S):  subdomain set (parent domain always set with it),
//                             theme/department null
const NODE_STATS_ROW_PREDICATE = {
    thematic_area_id: r => r.thematic_area_id && !r.domain_id && !r.subdomain_id && !r.department_id,
    domain_id: r => r.domain_id && !r.thematic_area_id && !r.subdomain_id && !r.department_id,
    subdomain_id: r => r.subdomain_id && !r.thematic_area_id && !r.department_id,
};

async function writeNodeStats(Model, idField) {
    const perNode = allRows.filter(NODE_STATS_ROW_PREDICATE[idField]);

    if (DRY_RUN) {
        console.log(`${Model.modelName}.stats: would update ${perNode.length} nodes`);
        return;
    }
    if (perNode.length > 0) {
        await Model.bulkWrite(perNode.map(r => ({
            updateOne: {
                filter: { _id: r[idField] },
                update: {
                    $set: {
                        'stats.paper_count': r.paper_count,
                        'stats.faculty_count': r.faculty_count,
                        'stats.updated_at': now
                    }
                }
            }
        })));
    }
    console.log(`${Model.modelName}.stats: updated ${perNode.length} nodes`);
}

await writeNodeStats(ThematicArea, 'thematic_area_id');
await writeNodeStats(Domain, 'domain_id');
await writeNodeStats(Subdomain, 'subdomain_id');

if (!DRY_RUN) {
    const subdomainCounts = await Subdomain.aggregate([
        { $group: { _id: '$domain_id', count: { $sum: 1 } } }
    ]);
    await Domain.bulkWrite(subdomainCounts.map(r => ({
        updateOne: {
            filter: { _id: r._id },
            update: { $set: { 'stats.subdomain_count': r.count } }
        }
    })));
}

// --- 2 & 3. Facet cube + member lists (rebuild from scratch) -------------------

const countDocs = allRows.map(({ member_paper_counts, ...row }) => ({ ...row, updated_at: now }));
const memberDocs = allRows
    .filter(r => r.member_paper_counts.length > 0)
    .map(r => {
        const sorted = [...r.member_paper_counts].sort(
            (a, b) => b.paper_count - a.paper_count || String(a.kerberos).localeCompare(String(b.kerberos))
        );
        const recommendedCount = computeRecommendedCount(sorted, { max: recommendedCeilingFor(r) });
        return {
            thematic_area_id: r.thematic_area_id,
            domain_id: r.domain_id,
            subdomain_id: r.subdomain_id,
            department_id: r.department_id,
            kerberos_list: sorted.map((m) => m.kerberos).slice(0, MEMBERS_CAP),
            faculty_total: sorted.length,
            recommended_count: recommendedCount,
            updated_at: now
        };
    });

if (DRY_RUN) {
    console.log(`\nWould write ${countDocs.length} facet-count rows and ${memberDocs.length} member rows.`);
} else {
    await TaxonomyFacetCounts.deleteMany({});
    await TaxonomyFacetCounts.insertMany(countDocs, { ordered: false });
    await TaxonomyFacetMembers.deleteMany({});
    await TaxonomyFacetMembers.insertMany(memberDocs, { ordered: false });
    console.log(`\nWrote ${countDocs.length} facet-count rows and ${memberDocs.length} member rows.`);

    // The read API caches responses under this namespace with a long TTL;
    // rewriting the rollup collections makes those entries stale.
    const flushed = await invalidateTaxonomyCache({
        redisUrl: process.env.REDIS_URL,
        prefix: TaxonomyCache.PREFIX
    });
    console.log(`Invalidated ${flushed} cached taxonomy responses.`);
}

await mongoose.disconnect();
console.log('Done.');
