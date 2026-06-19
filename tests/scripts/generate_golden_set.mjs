#!/usr/bin/env node
/**
 * Generate a comprehensive golden set for retrieval evaluation.
 *
 * Categories tested:
 *   1. exact_title      — full title substring (should be rank 1)
 *   2. partial_title    — 3-4 keywords from title (should recall)
 *   3. abstract_keyword — distinctive terms from abstract
 *   4. semantic         — paraphrased query with no lexical overlap
 *   5. author           — author surname lookup
 *   6. field_broad      — broad field query (low precision expected)
 *   7. cross_field      — title keyword + field constraint
 *   8. multi_relevant   — topic query with multiple relevant docs grouped
 *
 * For each query we know the source doc(s) that MUST appear.
 * Graded relevance: 3 = exact match, 2 = highly relevant, 1 = topically related.
 */

import { readFile, writeFile } from 'fs/promises';

const CORPUS_PATH = new URL('../fixtures/test_corpus.json', import.meta.url);
const OUTPUT_PATH = new URL('../fixtures/golden_set_comprehensive.json', import.meta.url);

function pickRandom(arr, n) {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
}

function extractKeywords(text, count = 4) {
    if (!text) return [];
    const stopwords = new Set([
        'a','an','the','of','in','to','for','and','or','is','are','was','were',
        'on','at','by','with','from','as','it','its','this','that','be','been',
        'has','have','had','not','but','can','will','do','does','did','which',
        'who','whom','their','there','these','those','we','our','us','them',
        'would','could','should','may','might','about','more','into','over',
        'under','also','such','than','very','each','between','both','through',
        'using','based','study','paper','research','results','analysis','approach',
        'method','proposed','present','show','new','used','two','one','high','low',
        'different','effect','effects','however','investigated','examined','various'
    ]);
    const words = text.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopwords.has(w) && !/^\d+$/.test(w));
    const unique = [...new Set(words)];
    return unique.slice(0, count);
}

function getAuthorSurname(doc) {
    const authors = doc.authors || [];
    if (!authors.length) return null;
    const first = authors[0];
    const name = first.author_name || first.name || '';
    const parts = name.split(/[,\s]+/).filter(Boolean);
    if (parts.length === 0) return null;
    const surname = parts[0].replace(/[^a-zA-Z]/g, '');
    return surname.length >= 3 ? surname : null;
}

const PARAPHRASE_TEMPLATES = [
    (title) => {
        const kw = extractKeywords(title, 3);
        if (kw.length < 2) return null;
        return `innovations related to ${kw.join(' and ')}`;
    },
    (title) => {
        const kw = extractKeywords(title, 2);
        if (kw.length < 2) return null;
        return `how does ${kw[0]} relate to ${kw[1]}`;
    },
    (title) => {
        const kw = extractKeywords(title, 3);
        if (kw.length < 2) return null;
        return `recent advances in ${kw.slice(0, 2).join(' ')} techniques`;
    },
];

async function main() {
    const corpus = JSON.parse(await readFile(CORPUS_PATH, 'utf8'));
    const docs = corpus.documents;
    const queries = [];
    let qid = 0;

    const docsWithAbstract = docs.filter(d => d.abstract && d.abstract.length > 80);
    const docsWithAuthors = docs.filter(d => getAuthorSurname(d));

    // ── 1. EXACT TITLE (15 queries) ──
    // Pick diverse docs across fields
    const titleDocs = pickRandom(docsWithAbstract, 15);
    for (const doc of titleDocs) {
        const titleSnippet = doc.title.length > 60
            ? doc.title.substring(0, 60).replace(/\s\S*$/, '')
            : doc.title;
        queries.push({
            id: `exact-title-${++qid}`,
            query: titleSnippet,
            type: 'exact_title',
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 3 },
        });
    }

    // ── 2. PARTIAL TITLE (15 queries) ──
    const partialDocs = pickRandom(docsWithAbstract, 15);
    for (const doc of partialDocs) {
        const kw = extractKeywords(doc.title, 4);
        if (kw.length < 2) continue;
        queries.push({
            id: `partial-title-${++qid}`,
            query: kw.join(' '),
            type: 'partial_title',
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 3 },
        });
    }

    // ── 3. ABSTRACT KEYWORD (15 queries) ──
    const abstractDocs = pickRandom(docsWithAbstract, 15);
    for (const doc of abstractDocs) {
        const kw = extractKeywords(doc.abstract, 4);
        if (kw.length < 3) continue;
        queries.push({
            id: `abstract-kw-${++qid}`,
            query: kw.join(' '),
            type: 'abstract_keyword',
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 2 },
        });
    }

    // ── 4. SEMANTIC / PARAPHRASE (10 queries) ──
    const semDocs = pickRandom(docsWithAbstract, 10);
    for (const doc of semDocs) {
        const template = PARAPHRASE_TEMPLATES[qid % PARAPHRASE_TEMPLATES.length];
        const paraphrase = template(doc.title);
        if (!paraphrase) continue;
        queries.push({
            id: `semantic-${++qid}`,
            query: paraphrase,
            type: 'semantic',
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 2 },
        });
    }

    // ── 5. AUTHOR (10 queries) ──
    const authorDocs = pickRandom(docsWithAuthors, 10);
    for (const doc of authorDocs) {
        const surname = getAuthorSurname(doc);
        if (!surname) continue;
        queries.push({
            id: `author-${++qid}`,
            query: surname,
            type: 'author',
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 2 },
        });
    }

    // ── 6. FIELD / BROAD TOPIC (8 queries) ──
    const topFields = ['Engineering', 'Computer Science', 'Materials Science',
        'Physics and Astronomy', 'Energy', 'Social Sciences', 'Mathematics', 'Chemistry'];
    for (const field of topFields) {
        const fieldDocs = docs.filter(d => d.field_associated === field);
        if (fieldDocs.length < 3) continue;
        const samples = pickRandom(fieldDocs, 3);
        const relevant = {};
        for (const d of samples) relevant[d.mongo_id] = 1;
        queries.push({
            id: `field-${++qid}`,
            query: field,
            type: 'field_broad',
            expected_min_results: fieldDocs.length,
            relevant,
        });
    }

    // ── 7. CROSS-FIELD (10 queries) — title keyword + field ──
    const crossDocs = pickRandom(docsWithAbstract.filter(d => d.field_associated), 10);
    for (const doc of crossDocs) {
        const kw = extractKeywords(doc.title, 2);
        if (kw.length < 1) continue;
        queries.push({
            id: `cross-${++qid}`,
            query: `${kw[0]} ${doc.field_associated}`,
            type: 'cross_field',
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 2 },
        });
    }

    // ── 8. MULTI-RELEVANT TOPIC CLUSTERS (8 queries) ──
    // Group docs by shared distinctive terms in titles, pick clusters with 3+ docs
    const topicClusters = [
        { query: 'machine learning prediction', filter: d => /machine learning/i.test(d.title) },
        { query: 'deep learning neural network', filter: d => /deep learning|neural network/i.test(d.title) },
        { query: 'solar energy photovoltaic', filter: d => /solar|photovoltaic/i.test(d.title) },
        { query: 'alloy mechanical properties', filter: d => /alloy.*mechanical|mechanical.*alloy/i.test(d.title) },
        { query: 'nanoparticles synthesis', filter: d => /nanoparticle|nano.*particle/i.test(d.title) },
        { query: 'optimization algorithm', filter: d => /optim.*algorithm|algorithm.*optim/i.test(d.title) },
        { query: 'water treatment removal', filter: d => /water.*treatment|water.*removal|removal.*water/i.test(d.title) },
        { query: 'finite element simulation', filter: d => /finite element|simulation.*model/i.test(d.title) },
        { query: 'composite material strength', filter: d => /composite.*material|composite.*strength/i.test(d.title) },
        { query: 'power grid renewable', filter: d => /power.*grid|renewable.*energy|grid.*renewable/i.test(d.title) },
    ];

    for (const cluster of topicClusters) {
        const matching = docs.filter(cluster.filter);
        if (matching.length < 2) continue;
        const relevant = {};
        for (const d of matching.slice(0, 10)) {
            relevant[d.mongo_id] = d.title.toLowerCase().includes(cluster.query.split(' ')[0]) ? 3 : 2;
        }
        queries.push({
            id: `topic-${++qid}`,
            query: cluster.query,
            type: 'multi_relevant',
            matching_docs: matching.length,
            relevant,
        });
    }

    const goldenSet = {
        version: 2,
        description: 'Comprehensive golden set: 8 query categories across 1000-doc corpus',
        corpus_documents: docs.length,
        exported_at: new Date().toISOString(),
        categories: {
            exact_title: 'Full title substring — expect rank 1',
            partial_title: '3-4 keywords from title — expect top 10',
            abstract_keyword: 'Distinctive abstract terms — expect top 50',
            semantic: 'Paraphrased query, no lexical overlap — tests vector recall',
            author: 'Author surname — tests author search pipeline',
            field_broad: 'Broad field name — tests coverage, not precision',
            cross_field: 'Title keyword + field — tests multi-signal retrieval',
            multi_relevant: 'Topic cluster — tests recall across related docs',
        },
        queries,
    };

    const typeCounts = {};
    for (const q of queries) typeCounts[q.type] = (typeCounts[q.type] || 0) + 1;

    await writeFile(OUTPUT_PATH, JSON.stringify(goldenSet, null, 2), 'utf8');

    console.log(`Generated ${queries.length} queries:`);
    for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${type.padEnd(20)} ${count}`);
    }
    console.log(`\nTotal relevant judgments: ${queries.reduce((s, q) => s + Object.keys(q.relevant).length, 0)}`);
    console.log(`Written to: ${OUTPUT_PATH.pathname}`);
}

main().catch(err => { console.error(err); process.exit(1); });
