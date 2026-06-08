/**
 * Bootstrap / seed the `authors_suggest` OpenSearch index from MongoDB `faculties`.
 *
 * This is the low-risk path to populate the typeahead author index without rebuilding
 * the Go indexer binary. It (re)creates the index with the canonical mapping, resolves
 * each faculty's department ObjectId -> name, builds name variants, optionally derives
 * paper_count from the existing research_documents index, and bulk-indexes one doc per
 * author.
 *
 * Usage (env is read the same way the API reads it — from opensearch/.env):
 *   node scripts/seedAuthorsSuggest.js                # create-if-missing + upsert all authors
 *   node scripts/seedAuthorsSuggest.js --recreate     # delete + recreate the index first
 *   node scripts/seedAuthorsSuggest.js --no-paper-count # skip the paper_count aggregation
 *
 * Reuses src/config so OPENSEARCH_NODE / MONGODB_URI / OPENSEARCH_AUTHORS_INDEX all apply.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { Client } from '@opensearch-project/opensearch';

import config from '../src/config/index.js';
import Faculty from '../src/models/faculty.js';
import Department from '../src/models/departments.js';
import {
    authorsSuggestMapping,
    buildNameVariants,
    buildPrimaryName
} from '../src/services/authorsSuggestIndex.js';

const RECREATE = process.argv.includes('--recreate');
const NO_PAPER_COUNT = process.argv.includes('--no-paper-count');

const INDEX = config.opensearch.authorsSuggestIndex;
const PAPERS_INDEX = config.opensearch.indexName;
const BATCH = 500;

function log(...args) {
    console.log('[seedAuthorsSuggest]', ...args);
}

const os = new Client({
    node: config.opensearch.node,
    auth: config.opensearch.auth,
    ssl: config.opensearch.ssl
});

async function indexExists() {
    const res = await os.indices.exists({ index: INDEX });
    return res.statusCode === 200;
}

async function ensureIndex() {
    if (RECREATE && (await indexExists())) {
        log(`Deleting existing index ${INDEX} (--recreate)`);
        await os.indices.delete({ index: INDEX });
    }
    if (!(await indexExists())) {
        log(`Creating index ${INDEX}`);
        await os.indices.create({ index: INDEX, body: authorsSuggestMapping });
    } else {
        log(`Index ${INDEX} already exists (upserting documents)`);
    }
}

/**
 * Derive papers-per-scopus-author-id via a single terms aggregation on the flat
 * `author_ids` field of research_documents. Returns Map<scopus_id, count>.
 */
async function loadPaperCounts() {
    if (NO_PAPER_COUNT) return new Map();
    try {
        const res = await os.search({
            index: PAPERS_INDEX,
            body: {
                size: 0,
                aggs: {
                    by_author: {
                        terms: { field: 'author_ids', size: 100000 }
                    }
                }
            }
        });
        const buckets = res.body?.aggregations?.by_author?.buckets || [];
        const map = new Map();
        for (const b of buckets) map.set(String(b.key), b.doc_count);
        log(`Loaded paper counts for ${map.size} scopus author ids`);
        return map;
    } catch (err) {
        log(`WARN: paper_count aggregation failed (${err.message}); seeding with paper_count=0`);
        return new Map();
    }
}

function buildAuthorDoc(faculty, deptName, paperCounts) {
    const name = buildPrimaryName(faculty.firstName, faculty.lastName);
    const name_variants = buildNameVariants(faculty.title, faculty.firstName, faculty.lastName);
    const scopusIds = Array.isArray(faculty.scopus_id)
        ? faculty.scopus_id.map(String).filter(Boolean)
        : [];
    const primaryScopus = scopusIds[0] || '';

    let paper_count = 0;
    for (const sid of scopusIds) {
        paper_count += paperCounts.get(String(sid)) || 0;
    }

    return {
        expert_id: faculty.expert_id || '',
        scopus_id: primaryScopus,
        name,
        name_variants,
        department: deptName || '',
        designation: faculty.designation || '',
        image_url: faculty.profile_image_url || '',
        h_index: Number.isFinite(faculty.h_index) ? faculty.h_index : 0,
        citation_count: Number.isFinite(faculty.citation_count) ? faculty.citation_count : 0,
        paper_count
    };
}

async function bulkIndex(docs) {
    if (docs.length === 0) return { indexed: 0, errors: 0 };
    const body = [];
    for (const doc of docs) {
        // Use expert_id as the deterministic _id so re-runs upsert instead of duplicating.
        body.push({ index: { _index: INDEX, _id: doc.expert_id || undefined } });
        body.push(doc);
    }
    const res = await os.bulk({ refresh: false, body });
    let errors = 0;
    if (res.body.errors) {
        for (const item of res.body.items) {
            if (item.index?.error) errors++;
        }
    }
    return { indexed: docs.length - errors, errors };
}

async function main() {
    if (!config.mongodb.uri) {
        console.error('ERROR: MONGODB_URI not set');
        process.exit(1);
    }

    log(`OpenSearch: ${config.opensearch.node}  index=${INDEX}`);
    await mongoose.connect(config.mongodb.uri, config.mongodb.options);
    log('Connected to MongoDB');

    await ensureIndex();

    const departments = await Department.find({}).lean();
    const deptById = new Map(departments.map((d) => [String(d._id), d.name]));
    log(`Loaded ${departments.length} departments`);

    const paperCounts = await loadPaperCounts();

    const faculties = await Faculty.find({}).lean();
    log(`Loaded ${faculties.length} faculties`);

    let buffer = [];
    let totalIndexed = 0;
    let totalErrors = 0;

    for (const f of faculties) {
        const deptName = deptById.get(String(f.department)) || '';
        buffer.push(buildAuthorDoc(f, deptName, paperCounts));
        if (buffer.length >= BATCH) {
            const { indexed, errors } = await bulkIndex(buffer);
            totalIndexed += indexed;
            totalErrors += errors;
            buffer = [];
        }
    }
    if (buffer.length) {
        const { indexed, errors } = await bulkIndex(buffer);
        totalIndexed += indexed;
        totalErrors += errors;
    }

    await os.indices.refresh({ index: INDEX });
    log(`Done. indexed=${totalIndexed} errors=${totalErrors}`);

    await mongoose.disconnect();
    await os.close();
}

main().catch(async (err) => {
    console.error('[seedAuthorsSuggest] FAILED:', err);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
