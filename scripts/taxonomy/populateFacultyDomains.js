/**
 * One-time (rerunnable) precompute of each faculty's dominant taxonomy
 * Domains, so the directory API's "Research Areas" section can read a plain
 * field instead of aggregating ResearchMetaDataScopus live per request.
 *
 * For each faculty, papers are grouped by classification.domain_id (a paper
 * with several IITD co-authors credits each author once — same dedupe idiom
 * as lib/rollupAggregations.js#membersPipeline, just grouped in the other
 * direction: per faculty instead of per browse-configuration). The sorted
 * (paper_count desc) domain list is then passed through the same Pareto/
 * coverage cutoff already used for faculty-per-area (recommendedCount.js),
 * run here in the inverse direction: domains-per-faculty.
 *
 * Run manually, once, after scripts/taxonomy/ingest.js has been verified
 * (classification.domain_id must already be populated).
 *
 * Usage:
 *   MONGODB_URI=mongodb://... node scripts/taxonomy/populateFacultyDomains.js [--dry-run]
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

import '../../src/models/index.js';
import { computeRecommendedCount } from './lib/recommendedCount.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const DRY_RUN = process.argv.includes('--dry-run');
const SAMPLE_SIZE = 5;

if (!MONGODB_URI) {
    console.error('ERROR: MONGODB_URI is not set');
    process.exit(1);
}

await mongoose.connect(MONGODB_URI);
console.log(`Connected to MongoDB${DRY_RUN ? ' [DRY RUN — no writes]' : ''}\n`);

const Domain = mongoose.model('Domain');
const Faculty = mongoose.model('Faculty');
const ResearchDocument = mongoose.model('ResearchMetaDataScopus');

const domainById = new Map(
    (await Domain.find({}).lean()).map(d => [String(d._id), d])
);

const perFacultyDomainCounts = await ResearchDocument.aggregate([
    { $match: { 'classification.domain_id': { $ne: null } } },
    { $unwind: '$iitd_authors' },
    { $match: { 'iitd_authors.faculty_ref': { $ne: null } } },
    // Dedupe paper per (faculty, domain) first — co-authored papers count once.
    {
        $group: {
            _id: {
                faculty_ref: '$iitd_authors.faculty_ref',
                domain_id: '$classification.domain_id',
                paper: '$_id'
            }
        }
    },
    {
        $group: {
            _id: { faculty_ref: '$_id.faculty_ref', domain_id: '$_id.domain_id' },
            paper_count: { $sum: 1 }
        }
    }
]);

const domainsByFaculty = new Map();
for (const { _id, paper_count } of perFacultyDomainCounts) {
    const key = String(_id.faculty_ref);
    if (!domainsByFaculty.has(key)) domainsByFaculty.set(key, []);
    domainsByFaculty.get(key).push({ domain_id: _id.domain_id, paper_count });
}

const now = new Date();
const ops = [];
const samples = [];

for (const [facultyId, counts] of domainsByFaculty) {
    const sorted = [...counts].sort((a, b) => {
        if (b.paper_count !== a.paper_count) return b.paper_count - a.paper_count;
        const nameA = domainById.get(String(a.domain_id))?.name ?? '';
        const nameB = domainById.get(String(b.domain_id))?.name ?? '';
        return nameA.localeCompare(nameB);
    });

    const keepCount = computeRecommendedCount(sorted, { max: sorted.length });
    const dominant_domains = sorted.slice(0, keepCount).map(({ domain_id, paper_count }) => {
        const domain = domainById.get(String(domain_id));
        return {
            domain_id,
            name: domain?.name ?? null,
            slug: domain?.slug ?? null,
            paper_count
        };
    });

    ops.push({
        updateOne: {
            filter: { _id: facultyId },
            update: { $set: { dominant_domains, dominant_domains_updated_at: now } }
        }
    });

    if (samples.length < SAMPLE_SIZE) {
        samples.push({ facultyId, dominant_domains });
    }
}

console.log(`Computed dominant domains for ${ops.length} faculty.\n`);
console.log(`Sample (${samples.length}):`);
for (const s of samples) {
    console.log(`  ${s.facultyId}: ${s.dominant_domains.map(d => `${d.name} (${d.paper_count})`).join(', ')}`);
}

if (DRY_RUN) {
    console.log(`\nWould update ${ops.length} Faculty documents.`);
} else {
    if (ops.length > 0) {
        const result = await Faculty.bulkWrite(ops, { ordered: false });
        console.log(`\nUpdated ${result.modifiedCount} Faculty documents.`);
    } else {
        console.log('\nNo faculty to update.');
    }
}

await mongoose.disconnect();
console.log('Done.');
