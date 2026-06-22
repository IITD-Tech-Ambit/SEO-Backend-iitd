#!/usr/bin/env node
/**
 * Generate golden_set_hard.json from test_corpus.json.
 *
 * Usage:
 *   npm run test:golden:hard
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import { buildHardGoldenSet } from './build_hard_golden_set.mjs';
import { calibrateHardSet } from './calibrate_hard_set.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(ROOT, '.env') });

const CORPUS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/test_corpus.json');
const OUTPUT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/golden_set_hard.json');
const API_BASE = process.env.SEARCH_API_URL || `http://localhost:${process.env.PORT || 3000}/api/v1`;
const VERIFY = process.env.VERIFY_HARD !== '0';

async function main() {
    if (!existsSync(CORPUS_PATH)) {
        console.error('test_corpus.json missing. Run: npm run test:dump');
        process.exit(1);
    }

    const corpus = JSON.parse(await readFile(CORPUS_PATH, 'utf8'));
    const goldenSet = buildHardGoldenSet(corpus);

    if (VERIFY) {
        try {
            const health = await fetch(`${API_BASE.replace(/\/api\/v1$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
            if (health.ok) {
                console.log('Calibrating hard set against live search (top 50)...');
                const dropped = await calibrateHardSet(goldenSet);
                if (dropped) console.log(`  Dropped ${dropped} uncalibratable queries`);
            }
        } catch {
            console.log('API unreachable — skipping live calibration');
        }
    }

    await writeFile(OUTPUT_PATH, JSON.stringify(goldenSet, null, 2));

    const byType = {};
    for (const q of goldenSet.queries) byType[q.type] = (byType[q.type] || 0) + 1;

    console.log(`\nHard golden set: ${goldenSet.queries.length} queries`);
    for (const [type, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${type.padEnd(28)} ${n}`);
    }
    console.log(`Judgments: ${goldenSet.queries.reduce((s, q) => s + Object.keys(q.relevant).length, 0)}`);
    console.log(`Written to: ${OUTPUT_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });
