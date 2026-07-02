/**
 * One-time ingestion of the ML classification snapshot (tmp/data.csv) into
 * ResearchMetaDataScopus.{classification, iitd_authors} plus the taxonomy node
 * collections (ThematicArea / Domain / Subdomain).
 *
 * Each CSV row carries MongoDB_ID — the document's own _id — so matching is a
 * direct lookup, not a fuzzy title/kerberos match. A document can still have
 * multiple CSV rows (the upstream classifier occasionally emits more than one
 * row per id, e.g. generic titles like "Preface"); those are grouped and a
 * single winner is picked per axis, same as before.
 *
 * Usage:
 *   MONGODB_URI=mongodb://... node scripts/taxonomy/ingest.js [--csv=tmp/data.csv] [--dry-run] [--batch-size=500]
 *
 * Run scripts/taxonomy/rollup.js after this completes and is spot-checked.
 */
import path from 'node:path';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

import '../../src/models/index.js';
import { readClassificationCsv } from './lib/csvReader.js';
import DepartmentResolver from './lib/departmentResolver.js';
import FacultyResolver from './lib/facultyResolver.js';
import TaxonomyBootstrapper from './lib/taxonomyBootstrapper.js';
import IitdAuthorsBuilder from './lib/iitdAuthorsBuilder.js';
import { selectClassification } from './lib/classificationSelector.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const DRY_RUN = process.argv.includes('--dry-run');
const CSV_PATH = (process.argv.find(a => a.startsWith('--csv=')) || '').split('=')[1]
    || path.resolve(import.meta.dirname, '../../tmp/data.csv');
const BATCH_SIZE = parseInt((process.argv.find(a => a.startsWith('--batch-size=')) || '').split('=')[1] || '500', 10);
const FETCH_CHUNK_SIZE = 2000;

if (!MONGODB_URI) {
    console.error('ERROR: MONGODB_URI is not set');
    process.exit(1);
}

const isValidObjectId = (id) => /^[a-f0-9]{24}$/i.test(id);

function chunk(array, size) {
    const out = [];
    for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
    return out;
}

await mongoose.connect(MONGODB_URI);
console.log(`Connected to MongoDB${DRY_RUN ? ' [DRY RUN — no writes]' : ''}`);
console.log(`CSV: ${CSV_PATH}\n`);

const ThematicArea = mongoose.model('ThematicArea');
const Domain = mongoose.model('Domain');
const Subdomain = mongoose.model('Subdomain');
const Department = mongoose.model('Department');
const Faculty = mongoose.model('Faculty');
const ResearchDocument = mongoose.model('ResearchMetaDataScopus');

// --- Phase 1: reference data, each loaded exactly once -----------------------

const rows = readClassificationCsv(CSV_PATH);
console.log(`CSV rows           : ${rows.length}`);

const departmentResolver = new DepartmentResolver(await Department.find({}).lean());
const facultyResolver = new FacultyResolver(await Faculty.find({}).lean());

// --- Phase 2: bootstrap taxonomy nodes --------------------------------------

const bootstrapper = new TaxonomyBootstrapper({ ThematicArea, Domain, Subdomain });
const nodeCounts = bootstrapper.collect(rows);
console.log(`Taxonomy nodes     : ${nodeCounts.themes} themes, ${nodeCounts.domains} domains, ${nodeCounts.subdomains} subdomains`);
await bootstrapper.upsertNodes(DRY_RUN);

// --- Phase 3: group rows by MongoDB_ID, bulk-fetch matched documents ---------

const rowsById = new Map();
const invalidIdRows = [];
for (const row of rows) {
    const id = String(row.MongoDB_ID || '').trim();
    if (!isValidObjectId(id)) {
        invalidIdRows.push(row);
        continue;
    }
    if (!rowsById.has(id)) rowsById.set(id, []);
    rowsById.get(id).push(row);
}
console.log(`Distinct paper ids : ${rowsById.size}${invalidIdRows.length ? ` (${invalidIdRows.length} rows with invalid MongoDB_ID skipped)` : ''}\n`);

const distinctIds = [...rowsById.keys()];
const paperById = new Map(); // id string -> { kerberos, authorIds }
for (const idChunk of chunk(distinctIds, FETCH_CHUNK_SIZE)) {
    const docs = await ResearchDocument.find(
        { _id: { $in: idChunk.map(id => new mongoose.Types.ObjectId(id)) } },
        { kerberos: 1, 'authors.author_id': 1 }
    ).lean();
    for (const doc of docs) {
        paperById.set(String(doc._id), {
            kerberos: doc.kerberos,
            authorIds: (doc.authors || []).map(a => String(a.author_id ?? '').trim()).filter(Boolean)
        });
    }
}

// --- Phase 4: per-paper resolution, buffer writes -----------------------------

const authorsBuilder = new IitdAuthorsBuilder({ facultyResolver, departmentResolver });
const classifiedAt = new Date();
const unmatched = [];
const duplicateGroupSizes = [];
let ops = [];
let written = 0;

async function flush() {
    if (ops.length === 0 || DRY_RUN) {
        ops = [];
        return;
    }
    const result = await ResearchDocument.collection.bulkWrite(ops, { ordered: false });
    written += result.modifiedCount;
    ops = [];
}

for (const [id, group] of rowsById) {
    if (group.length > 1) duplicateGroupSizes.push(group.length);

    const paper = paperById.get(id);
    if (!paper) {
        unmatched.push({ id, title: group[0].Title, rows: group.length });
        continue;
    }

    const selection = selectClassification(group);
    const iitdAuthors = authorsBuilder.build(paper.kerberos, paper.authorIds, selection.fallbackDepartmentName);

    ops.push({
        updateOne: {
            filter: { _id: new mongoose.Types.ObjectId(id) },
            update: {
                $set: {
                    iitd_authors: iitdAuthors,
                    classification: {
                        thematic_area_id: bootstrapper.themeIdByName.get(selection.themeName) ?? null,
                        domain_id: bootstrapper.domainIdByName.get(selection.domainName) ?? null,
                        subdomain_id: bootstrapper.subdomainIdByName.get(selection.subdomainName) ?? null,
                        topics: selection.topics,
                        classified_at: classifiedAt
                    }
                }
            }
        }
    });
    if (ops.length >= BATCH_SIZE) await flush();
}
await flush();

// --- Phase 5: report ----------------------------------------------------------

const matchedTotal = rowsById.size - unmatched.length;
console.log('--- Ingestion report ---');
console.log(`Matched papers     : ${matchedTotal} / ${rowsById.size}`);
console.log(`Unmatched papers   : ${unmatched.length} (MongoDB_ID not found in ResearchMetaDataScopus)`);
console.log(`Duplicate-row ids  : ${duplicateGroupSizes.length} (max group size: ${duplicateGroupSizes.length ? Math.max(...duplicateGroupSizes) : 0})`);
console.log(`Documents updated  : ${DRY_RUN ? '(dry run)' : written}`);
console.log(`iitd_authors       : ${authorsBuilder.stats.faculty} via faculty, ${authorsBuilder.stats.csv_fallback} csv_fallback (${authorsBuilder.stats.null_department} with null department)`);

const unresolvedDepts = departmentResolver.unresolvedReport();
if (unresolvedDepts.length > 0) {
    console.log('\n--- Unresolved departments (admin decision needed: create Department doc or accept null) ---');
    for (const d of unresolvedDepts) console.log(`  "${d.name}"  (${d.rows} rows)`);
}

if (unmatched.length > 0) {
    console.log(`\n--- First 20 unmatched ids (of ${unmatched.length}) ---`);
    for (const u of unmatched.slice(0, 20)) console.log(`  [${u.id}] ${u.title}`);
}
if (invalidIdRows.length > 0) {
    console.log(`\n--- First 10 rows with an invalid MongoDB_ID (of ${invalidIdRows.length}) ---`);
    for (const r of invalidIdRows.slice(0, 10)) console.log(`  "${r.MongoDB_ID}" | ${r.Title}`);
}

await mongoose.disconnect();
console.log('\nDone.');
