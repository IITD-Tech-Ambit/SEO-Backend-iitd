#!/usr/bin/env node
/**
 * Dump the test corpus from the search index.
 *
 * Queries the search API for a broad set of terms, collects unique documents,
 * fetches their full details from MongoDB, and writes them to a JSON file.
 * Also auto-populates the golden set with candidate relevant documents.
 *
 * Output:
 *   tests/fixtures/test_corpus.json  — full document details for all indexed docs
 *   tests/fixtures/golden_set.json   — updated with candidate mongo_ids (if empty)
 *
 * Usage:
 *   MONGODB_URI=mongodb://localhost:27017/research_db node tests/scripts/dump_test_corpus.mjs
 *
 * Environment:
 *   MONGODB_URI    — MongoDB connection string (default: mongodb://localhost:27017/research_db)
 *   SEARCH_API_URL — Search API base URL (default: http://localhost:3001)
 */

import mongoose from 'mongoose';
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// Load project env (search API + indexer)
dotenv.config({ path: path.join(ROOT, '.env') });
dotenv.config({ path: path.join(ROOT, 'indexer_go/.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/research_db';
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || 'researchmetadatascopus';
const API_BASE = process.env.SEARCH_API_URL || process.env.API_BASE || `http://localhost:${process.env.PORT || 3000}/api/v1`;
const CORPUS_PATH = path.resolve(__dirname, '../fixtures/test_corpus.json');
const GOLDEN_SET_PATH = path.resolve(__dirname, '../fixtures/golden_set.json');
const GOLDEN_SET_CORPUS_PATH = path.resolve(__dirname, '../fixtures/golden_set_corpus.json');
const CORPUS_LIMIT = parseInt(process.env.CORPUS_LIMIT || '0', 10);

async function fetchAllIndexedDocs() {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    const db = mongoose.connection.db;
    const collection = db.collection(MONGODB_COLLECTION);
    console.log(`  Collection: ${MONGODB_COLLECTION}`);

    // Find all documents that have been indexed (open_search_id is set and not pending)
    let cursor = collection.find({
        open_search_id: { $exists: true, $ne: null, $ne: '' },
        $expr: {
            $not: { $regexMatch: { input: '$open_search_id', regex: /^pending_/ } }
        }
    }).project({
        _id: 1,
        title: 1,
        abstract: 1,
        authors: 1,
        publication_year: 1,
        document_type: 1,
        field_associated: 1,
        subject_area: 1,
        citation_count: 1,
        reference_count: 1,
        document_eid: 1,
        document_scopus_id: 1,
        link: 1,
        kerberos: 1,
        open_search_id: 1,
    }).sort({ _id: 1 });

    if (CORPUS_LIMIT > 0) {
        cursor = cursor.limit(CORPUS_LIMIT);
    }

    const docs = await cursor.toArray();

    await mongoose.disconnect();
    return docs;
}

async function searchAndCollect(query, mode = 'basic') {
    try {
        const res = await fetch(`${API_BASE}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query,
                mode,
                sort: 'relevance',
                per_page: 50,
                page: 1,
            }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.results || []).map(r => ({
            mongo_id: r.mongo_id || r._id,
            title: r.title,
            score: r.rerank_score ?? null,
        }));
    } catch {
        return [];
    }
}

async function autoPopulateGoldenSet(goldenSet) {
    console.log('\nAuto-populating golden set with search results...');
    let updated = 0;

    for (const entry of goldenSet.queries) {
        if (Object.keys(entry.relevant).length > 0) {
            console.log(`  [${entry.id}] already has ${Object.keys(entry.relevant).length} judgments, skipping`);
            continue;
        }

        const results = await searchAndCollect(entry.query);
        if (results.length === 0) {
            console.log(`  [${entry.id}] "${entry.query}" — no results`);
            continue;
        }

        // Add top results as candidates with relevance grade 2 (to be manually reviewed)
        const topN = Math.min(5, results.length);
        for (let i = 0; i < topN; i++) {
            if (results[i].mongo_id) {
                entry.relevant[results[i].mongo_id] = 2;
            }
        }

        // Add a note about auto-population
        entry.notes = (entry.notes || '') +
            ` [AUTO: top ${topN} results added as grade 2 — review and adjust grades]`;
        updated++;
        console.log(`  [${entry.id}] "${entry.query}" — added ${topN} candidates (${results.slice(0, 3).map(r => r.title?.slice(0, 40) + '...').join('; ')})`);
    }

    return updated;
}

function titleQuery(title) {
    const words = (title || '').split(/\s+/).filter(Boolean);
    if (words.length <= 4) return words.join(' ');
    return words.slice(0, 5).join(' ');
}

function buildCorpusGoldenSet(corpus) {
    const docs = corpus.documents.filter(d => d.title && d.title.length > 10);
    const picked = [];
    const seenFields = new Set();

    // One doc per distinct field_associated (up to 12)
    for (const doc of docs) {
        const field = doc.field_associated || 'unknown';
        if (seenFields.has(field)) continue;
        seenFields.add(field);
        picked.push(doc);
        if (picked.length >= 12) break;
    }
    // Fill with high-citation docs if needed
    for (const doc of [...docs].sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0))) {
        if (picked.length >= 15) break;
        if (!picked.find(p => p.mongo_id === doc.mongo_id)) picked.push(doc);
    }

    const queries = picked.map((doc, i) => {
        const author = doc.authors?.[0]?.name?.split(/[,\s]/).filter(Boolean)[0] || '';
        const variants = [
            { type: 'title', query: titleQuery(doc.title) },
            author ? { type: 'author', query: `${author} ${doc.field_associated || ''}`.trim() } : null,
            doc.field_associated ? { type: 'field', query: doc.field_associated } : null,
        ].filter(Boolean);

        const chosen = variants[i % variants.length];
        return {
            id: `corpus-${String(i + 1).padStart(2, '0')}`,
            query: chosen.query,
            type: chosen.type,
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 3 },
            notes: `Auto-generated from indexed test corpus (${doc.document_type}, ${doc.publication_year})`,
        };
    });

    return {
        version: 1,
        description: 'Golden set aligned to the 1000-doc test corpus. Source doc is grade 3; search hits may be added as grade 2.',
        corpus_documents: corpus.total_documents,
        exported_at: new Date().toISOString(),
        queries,
    };
}

async function enrichCorpusGoldenSet(goldenSet) {
    let updated = 0;
    for (const entry of goldenSet.queries) {
        const results = await searchAndCollect(entry.query, 'basic');
        const topN = Math.min(5, results.length);
        for (let i = 0; i < topN; i++) {
            const id = results[i].mongo_id;
            if (id && !entry.relevant[id]) {
                entry.relevant[id] = 2;
            }
        }
        if (topN > 0) updated++;
        console.log(`  [${entry.id}] "${entry.query.slice(0, 50)}" — ${topN} search hits`);
    }
    return updated;
}

async function main() {
    console.log('=== Test Corpus Dump ===\n');

    // 1. Dump all indexed documents from MongoDB
    const docs = await fetchAllIndexedDocs();
    console.log(`Found ${docs.length} indexed documents in MongoDB`);

    if (docs.length === 0) {
        console.log('\nNo indexed documents found. Run the indexer first:');
        console.log('  npm run test:setup');
        process.exit(1);
    }

    // Build corpus with stats
    const corpus = {
        exported_at: new Date().toISOString(),
        total_documents: docs.length,
        fields_summary: {
            with_abstract: docs.filter(d => d.abstract && d.abstract !== '(No abstract available)').length,
            with_authors: docs.filter(d => d.authors && d.authors.length > 0).length,
            document_types: [...new Set(docs.map(d => d.document_type).filter(Boolean))],
            year_range: {
                min: Math.min(...docs.map(d => d.publication_year).filter(Boolean)),
                max: Math.max(...docs.map(d => d.publication_year).filter(Boolean)),
            },
            subject_areas: [...new Set(docs.flatMap(d => d.subject_area || []))].sort(),
        },
        documents: docs.map(d => ({
            mongo_id: d._id.toString(),
            title: d.title,
            abstract: d.abstract,
            authors: (d.authors || []).map(a => ({
                name: a.author_name,
                id: a.author_id,
            })),
            publication_year: d.publication_year,
            document_type: d.document_type,
            field_associated: d.field_associated,
            subject_area: d.subject_area,
            citation_count: d.citation_count || 0,
            reference_count: d.reference_count || 0,
            kerberos: d.kerberos,
        })),
    };

    await writeFile(CORPUS_PATH, JSON.stringify(corpus, null, 2));
    console.log(`\nCorpus written to: ${CORPUS_PATH}`);
    console.log(`  Documents: ${corpus.total_documents}`);
    console.log(`  With abstracts: ${corpus.fields_summary.with_abstract}`);
    console.log(`  With authors: ${corpus.fields_summary.with_authors}`);
    console.log(`  Year range: ${corpus.fields_summary.year_range.min}–${corpus.fields_summary.year_range.max}`);
    console.log(`  Subject areas: ${corpus.fields_summary.subject_areas.length}`);
    console.log(`  Document types: ${corpus.fields_summary.document_types.join(', ')}`);

    // 2. Build corpus-aligned golden set (queries that match the indexed papers)
    const corpusGolden = buildCorpusGoldenSet(corpus);
    let apiOk = false;
    try {
        const healthRes = await fetch(`${API_BASE.replace(/\/api\/v1$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
        apiOk = healthRes.ok;
    } catch { /* ignore */ }

    if (apiOk) {
        console.log('\nEnriching corpus golden set from live search...');
        await enrichCorpusGoldenSet(corpusGolden);
    }
    await writeFile(GOLDEN_SET_CORPUS_PATH, JSON.stringify(corpusGolden, null, 2));
    console.log(`\nCorpus golden set: ${GOLDEN_SET_CORPUS_PATH}`);
    console.log(`  Queries: ${corpusGolden.queries.length} (each with grade-3 source doc)`);

    // 3. Auto-populate the generic golden set if the search API is reachable
    if (apiOk) {
        try {
            const goldenSet = JSON.parse(await readFile(GOLDEN_SET_PATH, 'utf8'));
            console.log('\nAuto-populating generic golden set...');
            const updated = await autoPopulateGoldenSet(goldenSet);

            if (updated > 0) {
                await writeFile(GOLDEN_SET_PATH, JSON.stringify(goldenSet, null, 2));
                console.log(`\nGolden set updated: ${updated} queries auto-populated`);
                console.log(`Written to: ${GOLDEN_SET_PATH}`);
            } else {
                console.log('\nGeneric golden set: no new judgments (queries may not match this corpus)');
            }
        } catch (err) {
            console.log(`\nGeneric golden set skip: ${err.message}`);
        }
    } else {
        console.log('\nSearch API not reachable — corpus golden set has source-doc judgments only.');
        console.log('Start the API and run: npm run test:dump');
    }

    // 4. Print sample documents for quick review
    console.log('\n=== Sample Documents ===\n');
    const samples = corpus.documents.slice(0, 5);
    for (const doc of samples) {
        console.log(`  [${doc.mongo_id}]`);
        console.log(`    Title: ${doc.title?.slice(0, 80)}${doc.title?.length > 80 ? '...' : ''}`);
        console.log(`    Year: ${doc.publication_year}, Type: ${doc.document_type}`);
        console.log(`    Field: ${doc.field_associated}, Citations: ${doc.citation_count}`);
        console.log(`    Authors: ${doc.authors.slice(0, 3).map(a => a.name).join(', ')}${doc.authors.length > 3 ? '...' : ''}`);
        console.log('');
    }

    console.log('=== Done ===');
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
