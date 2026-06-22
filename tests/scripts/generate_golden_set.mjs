#!/usr/bin/env node
/**
 * Generate golden_set_comprehensive.json from test_corpus.json.
 *
 * Run after dumping the corpus:
 *   npm run test:dump
 *   npm run test:golden
 */

import { readFile, writeFile } from 'fs/promises';
import { buildComprehensiveGoldenSet } from './build_comprehensive_golden_set.mjs';

const CORPUS_PATH = new URL('../fixtures/test_corpus.json', import.meta.url);
const OUTPUT_PATH = new URL('../fixtures/golden_set_comprehensive.json', import.meta.url);

async function main() {
    let corpus;
    try {
        corpus = JSON.parse(await readFile(CORPUS_PATH, 'utf8'));
    } catch {
        console.error('test_corpus.json not found. Run: npm run test:dump');
        process.exit(1);
    }

    const goldenSet = buildComprehensiveGoldenSet(corpus);
    await writeFile(OUTPUT_PATH, JSON.stringify(goldenSet, null, 2), 'utf8');

    const typeCounts = {};
    for (const q of goldenSet.queries) typeCounts[q.type] = (typeCounts[q.type] || 0) + 1;

    console.log(`Generated ${goldenSet.queries.length} queries from ${corpus.total_documents} corpus docs:`);
    for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${type.padEnd(20)} ${count}`);
    }
    console.log(`\nTotal relevance judgments: ${goldenSet.queries.reduce((s, q) => s + Object.keys(q.relevant).length, 0)}`);
    console.log(`Written to: ${OUTPUT_PATH.pathname}`);
}

main().catch(err => { console.error(err); process.exit(1); });
