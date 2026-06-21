#!/usr/bin/env node
/**
 * Hard-set evaluation harness — stresses all IR metrics on difficult corpus queries.
 *
 * Usage:
 *   npm run test:eval:hard
 *   npm run test:eval:hard -- --verbose
 */

import { readFile } from 'fs/promises';
import { computeAll, averageMetrics } from './metrics.mjs';

const API_BASE = process.env.SEARCH_API_URL || `http://localhost:${process.env.PORT || 3000}/api/v1`;
const ROOT_BASE = API_BASE.replace(/\/api\/v1$/, '');
const GOLDEN_PATH = process.env.HARD_GOLDEN_SET_PATH
    || new URL('../fixtures/golden_set_hard.json', import.meta.url);

const MIN_THRESHOLDS = {
    hard_exact_rank1: { mrr: 0.5, precision_1: 0.4, ndcg_10: 0.5 },
    hard_partial_common: { mrr: 0.2, recall_50: 0.5, precision_10: 0.05 },
    hard_graded_cluster: { ndcg_10: 0.3, recall_50: 0.25 },
    hard_ambiguous_recall: { recall_50: 0.15 },
    hard_abstract_gap: { mrr: 0.1, recall_50: 0.3 },
    hard_paraphrase: { mrr: 0.05, recall_50: 0.2 },
    hard_author_disambiguation: { mrr: 0.2, precision_5: 0.05 },
    hard_distractor_ranking: { ndcg_10: 0.4, mrr: 0.25 },
    hard_cross_field: { mrr: 0.15, precision_10: 0.05 },
};

async function searchQuery(query, { mode = 'advanced', sort = 'relevance', perPage = 50 } = {}) {
    const res = await fetch(`${API_BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, mode, sort, per_page: perPage, page: 1 }),
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function runConfig(goldenSet, configLabel, { mode = 'advanced', sort = 'relevance' } = {}) {
    const results = [];
    const errors = [];

    for (const entry of goldenSet.queries) {
        try {
            const resp = await searchQuery(entry.query, { mode, sort });
            const retrievedIds = (resp.results || []).map(r => r.mongo_id || r._id);
            const metrics = computeAll(retrievedIds, entry.relevant);
            results.push({ id: entry.id, query: entry.query, type: entry.type, difficulty: entry.difficulty, ...metrics });
        } catch (err) {
            errors.push({ id: entry.id, error: err.message });
        }
    }

    return { configLabel, perQuery: results, errors, average: averageMetrics(results) };
}

function categoryBreakdown(perQuery) {
    const cats = {};
    for (const r of perQuery) {
        if (!cats[r.type]) cats[r.type] = [];
        cats[r.type].push(r);
    }
    const out = {};
    for (const [type, rows] of Object.entries(cats)) {
        const n = rows.length;
        const avg = (key) => rows.reduce((s, r) => s + (r[key] ?? 0), 0) / n;
        out[type] = {
            count: n,
            recall_50: avg('recall_50'),
            precision_1: avg('precision_1'),
            precision_5: avg('precision_5'),
            precision_10: avg('precision_10'),
            ndcg_10: avg('ndcg_10'),
            mrr: avg('mrr'),
        };
    }
    return out;
}

function checkThresholds(breakdown) {
    const failures = [];
    for (const [type, stats] of Object.entries(breakdown)) {
        const min = MIN_THRESHOLDS[type];
        if (!min) continue;
        for (const [metric, floor] of Object.entries(min)) {
            if (stats[metric] < floor) {
                failures.push({ type, metric, actual: stats[metric], floor });
            }
        }
    }
    return failures;
}

function fmt(v) {
    return v === null || v === undefined ? 'N/A   ' : v.toFixed(3).padStart(6);
}

function printReport(report, { verbose = false } = {}) {
    console.log(`\n${'='.repeat(90)}`);
    console.log(`  Config: ${report.configLabel}`);
    console.log(`${'='.repeat(90)}`);

    if (report.errors.length) {
        console.log(`  Errors: ${report.errors.length}`);
        for (const e of report.errors) console.log(`    - ${e.id}: ${e.error}`);
    }

    const breakdown = categoryBreakdown(report.perQuery);
    console.log(`\n  Per-category (hard) breakdown:`);
    console.log(`  ${'─'.repeat(86)}`);
    console.log(`  ${'Category'.padEnd(28)} ${'N'.padStart(3)}   R@50    P@1     P@5     P@10    nDCG@10 MRR`);
    console.log(`  ${'─'.repeat(86)}`);
    for (const [type, c] of Object.entries(breakdown).sort((a, b) => a[0].localeCompare(b[0]))) {
        console.log(`  ${type.padEnd(28)} ${String(c.count).padStart(3)}  ${fmt(c.recall_50)} ${fmt(c.precision_1)} ${fmt(c.precision_5)} ${fmt(c.precision_10)} ${fmt(c.ndcg_10)} ${fmt(c.mrr)}`);
    }

    const a = report.average;
    console.log(`\n  Aggregate:`);
    console.log(`    Recall@50:    ${a.recall_50?.toFixed(4) ?? 'N/A'}`);
    console.log(`    Precision@1:  ${a.precision_1?.toFixed(4) ?? 'N/A'}`);
    console.log(`    Precision@5:  ${a.precision_5?.toFixed(4) ?? 'N/A'}`);
    console.log(`    Precision@10: ${a.precision_10?.toFixed(4) ?? 'N/A'}`);
    console.log(`    nDCG@10:      ${a.ndcg_10?.toFixed(4) ?? 'N/A'}`);
    console.log(`    MRR:          ${a.mrr?.toFixed(4) ?? 'N/A'}`);
    console.log(`    Queries:      ${a.queries_evaluated}`);

    const failures = checkThresholds(breakdown);
    if (failures.length) {
        console.log(`\n  Below minimum thresholds (${failures.length}):`);
        for (const f of failures) {
            console.log(`    ${f.type}.${f.metric}: ${f.actual.toFixed(3)} < ${f.floor}`);
        }
    }

    if (verbose) {
        console.log(`\n  Per-query detail:`);
        for (const r of report.perQuery) {
            console.log(`    ${r.id.padEnd(22)} ${fmt(r.recall_50)} ${fmt(r.precision_1)} ${fmt(r.precision_10)} ${fmt(r.ndcg_10)} ${fmt(r.mrr)}  ${r.query.slice(0, 40)}`);
        }
    }

    return failures;
}

function printComparison(reports) {
    console.log(`\n${'='.repeat(90)}`);
    console.log('  HARD SET — COMPARISON');
    console.log(`${'='.repeat(90)}`);
    console.log(`  ${'Config'.padEnd(30)} R@50    P@1     P@5     P@10    nDCG@10 MRR`);
    console.log(`  ${'─'.repeat(80)}`);
    for (const r of reports) {
        const a = r.average;
        console.log(`  ${r.configLabel.padEnd(30)} ${fmt(a.recall_50)} ${fmt(a.precision_1)} ${fmt(a.precision_5)} ${fmt(a.precision_10)} ${fmt(a.ndcg_10)} ${fmt(a.mrr)}`);
    }
}

async function main() {
    const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
    const goldenSet = JSON.parse(await readFile(GOLDEN_PATH, 'utf8'));

    console.log(`\nHard golden set: ${goldenSet.queries.length} queries, ${goldenSet.queries.reduce((s, q) => s + Object.keys(q.relevant).length, 0)} judgments`);
    console.log(`API: ${API_BASE}`);

    const health = await fetch(`${ROOT_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) {
        console.error('API not reachable');
        process.exit(1);
    }

    const reports = [];
    let allFailures = [];

    console.log('\n[1/3] Basic...');
    const basic = await runConfig(goldenSet, 'basic (BM25-only)', { mode: 'basic' });
    allFailures = allFailures.concat(printReport(basic, { verbose }));
    reports.push(basic);

    console.log('\n[2/3] Advanced (no rerank)...');
    const noRerank = await runConfig(goldenSet, 'advanced (no rerank)', { mode: 'advanced', sort: 'impact' });
    allFailures = allFailures.concat(printReport(noRerank, { verbose }));
    reports.push(noRerank);

    console.log('\n[3/3] Advanced (+ reranker)...');
    const full = await runConfig(goldenSet, 'advanced (+ reranker)', { mode: 'advanced', sort: 'relevance' });
    allFailures = allFailures.concat(printReport(full, { verbose }));
    reports.push(full);

    printComparison(reports);

    const hasErrors = reports.some(r => r.errors.length > 0);
    console.log(`\nOverall: ${hasErrors ? 'FAIL (errors)' : allFailures.length ? 'WARN (below thresholds)' : 'PASS'}`);
    process.exit(hasErrors ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
