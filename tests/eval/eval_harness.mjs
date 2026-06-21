#!/usr/bin/env node
/**
 * Relevance Evaluation Harness
 *
 * Runs the golden-set queries against a live search API and computes
 * recall@50, nDCG@10, MRR, and precision@10.
 *
 * Usage:
 *   # Default: compare first-stage-only vs +reranker
 *   node tests/eval/eval_harness.mjs
 *
 *   # Custom API base URL
 *   SEARCH_API_URL=http://localhost:3001 node tests/eval/eval_harness.mjs
 *
 *   # Specific config: rerank disabled
 *   RERANK_OVERRIDE=off node tests/eval/eval_harness.mjs
 *
 * The golden set lives in tests/fixtures/golden_set.json.
 * Populate the `relevant` maps with real mongo_ids before running.
 */

import { readFile } from 'fs/promises';
import { computeAll, averageMetrics } from './metrics.mjs';

const API_BASE = process.env.SEARCH_API_URL || `http://localhost:${process.env.PORT || 3000}/api/v1`;
const ROOT_BASE = API_BASE.replace(/\/api\/v1$/, '');
const RERANK_OVERRIDE = process.env.RERANK_OVERRIDE; // 'on', 'off', or unset (runs both)

async function searchQuery(query, { mode = 'advanced', sort = 'relevance', perPage = 50 } = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
        const res = await fetch(`${API_BASE}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, mode, sort, per_page: perPage, page: 1 }),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        return await res.json();
    } catch (err) {
        clearTimeout(timeoutId);
        throw err;
    }
}

async function runConfig(goldenSet, configLabel, { mode = 'advanced', sort = 'relevance' } = {}) {
    const results = [];
    const skipped = [];
    const errors = [];

    for (const entry of goldenSet.queries) {
        if (Object.keys(entry.relevant).length === 0) {
            skipped.push(entry.id);
            continue;
        }

        try {
            const resp = await searchQuery(entry.query, { mode, sort });
            const retrievedIds = (resp.results || []).map(r => r.mongo_id || r._id);
            const metrics = computeAll(retrievedIds, entry.relevant);
            results.push({ id: entry.id, query: entry.query, type: entry.type, ...metrics });
        } catch (err) {
            errors.push({ id: entry.id, error: err.message });
        }
    }

    const avg = averageMetrics(results);

    return { configLabel, perQuery: results, skipped, errors, average: avg };
}

function computeCategoryBreakdown(perQuery) {
    const cats = {};
    for (const r of perQuery) {
        if (!cats[r.type]) cats[r.type] = [];
        cats[r.type].push(r);
    }
    const breakdown = {};
    for (const [type, rows] of Object.entries(cats)) {
        const n = rows.length;
        breakdown[type] = {
            count: n,
            recall_50: rows.reduce((s, r) => s + (r.recall_50 ?? 0), 0) / n,
            precision_1: rows.reduce((s, r) => s + (r.precision_1 ?? 0), 0) / n,
            precision_5: rows.reduce((s, r) => s + (r.precision_5 ?? 0), 0) / n,
            precision_10: rows.reduce((s, r) => s + (r.precision_10 ?? 0), 0) / n,
            ndcg_10: rows.reduce((s, r) => s + (r.ndcg_10 ?? 0), 0) / n,
            mrr: rows.reduce((s, r) => s + (r.mrr ?? 0), 0) / n,
        };
    }
    return breakdown;
}

function printReport(report, { verbose = false } = {}) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`  Config: ${report.configLabel}`);
    console.log(`${'='.repeat(70)}`);

    if (report.skipped.length) {
        console.log(`  Skipped (no relevance judgments): ${report.skipped.length} queries`);
    }
    if (report.errors.length) {
        console.log(`  Errors: ${report.errors.length}`);
        for (const e of report.errors) {
            console.log(`    - ${e.id}: ${e.error}`);
        }
    }

    if (verbose && report.perQuery.length > 0) {
        console.log(`\n  Per-query results (${report.perQuery.length} evaluated):`);
        console.log(`  ${'─'.repeat(86)}`);
        console.log(
            `  ${'Query ID'.padEnd(22)} ${'Type'.padEnd(18)} R@50    P@1     P@5     P@10    nDCG@10 MRR`
        );
        console.log(`  ${'─'.repeat(86)}`);
        for (const r of report.perQuery) {
            const fmt = (v) => v === null ? 'N/A   ' : v.toFixed(3).padStart(6);
            console.log(
                `  ${r.id.padEnd(22)} ${r.type.padEnd(18)} ${fmt(r.recall_50)} ${fmt(r.precision_1)} ${fmt(r.precision_5)} ${fmt(r.precision_10)} ${fmt(r.ndcg_10)} ${fmt(r.mrr)}`
            );
        }
    }

    // Category breakdown
    const breakdown = computeCategoryBreakdown(report.perQuery);
    const catOrder = ['exact_title','partial_title','abstract_keyword','semantic',
                      'author','field_broad','cross_field','multi_relevant'];
    const catKeys = catOrder.filter(k => breakdown[k]);
    // Add any extra categories not in the predefined order
    for (const k of Object.keys(breakdown)) {
        if (!catKeys.includes(k)) catKeys.push(k);
    }

    if (catKeys.length > 0) {
        console.log(`\n  Per-category breakdown:`);
        console.log(`  ${'─'.repeat(86)}`);
        console.log(
            `  ${'Category'.padEnd(22)} ${'N'.padStart(3)}   R@50    P@1     P@5     P@10    nDCG@10 MRR`
        );
        console.log(`  ${'─'.repeat(86)}`);
        const fmt = (v) => v.toFixed(3).padStart(6);
        for (const type of catKeys) {
            const c = breakdown[type];
            console.log(
                `  ${type.padEnd(22)} ${String(c.count).padStart(3)}  ${fmt(c.recall_50)} ${fmt(c.precision_1)} ${fmt(c.precision_5)} ${fmt(c.precision_10)} ${fmt(c.ndcg_10)} ${fmt(c.mrr)}`
            );
        }
    }

    console.log(`\n  Aggregate metrics:`);
    const a = report.average;
    console.log(`    Recall@50:    ${a.recall_50 !== null ? a.recall_50.toFixed(4) : 'N/A'}`);
    console.log(`    Precision@1:  ${a.precision_1 !== null ? a.precision_1.toFixed(4) : 'N/A'}`);
    console.log(`    Precision@5:  ${a.precision_5 !== null ? a.precision_5.toFixed(4) : 'N/A'}`);
    console.log(`    Precision@10: ${a.precision_10 !== null ? a.precision_10.toFixed(4) : 'N/A'}`);
    console.log(`    nDCG@10:      ${a.ndcg_10 !== null ? a.ndcg_10.toFixed(4) : 'N/A'}`);
    console.log(`    MRR:          ${a.mrr !== null ? a.mrr.toFixed(4) : 'N/A'}`);
    console.log(`    Queries evaluated:       ${a.queries_evaluated}`);
    console.log(`    Queries with judgments:   ${a.queries_with_judgments}`);
}

function printComparison(reports) {
    console.log(`\n${'='.repeat(90)}`);
    console.log(`  COMPARISON ACROSS CONFIGS`);
    console.log(`${'='.repeat(90)}`);
    console.log(
        `  ${'Config'.padEnd(30)} R@50    P@1     P@5     P@10    nDCG@10 MRR`
    );
    console.log(`  ${'─'.repeat(80)}`);
    const fmt = (v) => v === null ? 'N/A   ' : v.toFixed(4).padStart(7);
    for (const r of reports) {
        const a = r.average;
        console.log(
            `  ${r.configLabel.padEnd(30)} ${fmt(a.recall_50)} ${fmt(a.precision_1)} ${fmt(a.precision_5)} ${fmt(a.precision_10)} ${fmt(a.ndcg_10)} ${fmt(a.mrr)}`
        );
    }

    // Show delta if we have exactly 2+ reports
    if (reports.length >= 2) {
        const base = reports[0].average;
        for (let i = 1; i < reports.length; i++) {
            const curr = reports[i].average;
            const delta = (key) => {
                if (base[key] === null || curr[key] === null) return '   N/A';
                const d = curr[key] - base[key];
                const sign = d >= 0 ? '+' : '';
                return `${sign}${d.toFixed(4)}`.padStart(7);
            };
            console.log(
                `  ${'  Δ vs ' + reports[0].configLabel}`.substring(0,30).padEnd(30) +
                ` ${delta('recall_50')} ${delta('precision_1')} ${delta('precision_5')} ${delta('precision_10')} ${delta('ndcg_10')} ${delta('mrr')}`
            );
        }
    }
}

async function main() {
    const goldenPath = process.env.GOLDEN_SET_PATH
        || new URL('../fixtures/golden_set_comprehensive.json', import.meta.url);
    const goldenSet = JSON.parse(await readFile(goldenPath, 'utf8'));
    const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

    const judgedCount = goldenSet.queries.filter(q => Object.keys(q.relevant).length > 0).length;
    console.log(`\nLoaded golden set v${goldenSet.version}: ${goldenSet.queries.length} queries (${judgedCount} with judgments)`);

    if (judgedCount === 0) {
        console.log('\n  No queries have relevance judgments yet.');
        console.log('   Populate the "relevant" maps with mongo_id -> grade (1-3) pairs, then re-run.');
        process.exit(0);
    }

    console.log(`API: ${API_BASE}`);

    // Verify API is reachable
    try {
        const health = await fetch(`${ROOT_BASE}/health`, { signal: AbortSignal.timeout(3000) });
        if (!health.ok) throw new Error(`Health check failed: ${health.status}`);
        console.log('API health check: OK');
    } catch (err) {
        console.error(`\nAPI not reachable at ${API_BASE}: ${err.message}`);
        console.error('Start the search API and re-run.');
        process.exit(1);
    }

    const reports = [];

    if (RERANK_OVERRIDE) {
        const report = await runConfig(goldenSet, `rerank=${RERANK_OVERRIDE}`);
        printReport(report, { verbose });
        reports.push(report);
    } else {
        // Run all three configs: basic, advanced (no rerank), advanced (with rerank)
        console.log('\nRunning 3 configs: basic, advanced (first-stage only), advanced (+ reranker)');
        console.log('This will take a few minutes...\n');

        // 1. Basic mode (BM25-only)
        console.log('[1/3] Basic mode (BM25-only)...');
        const basicReport = await runConfig(goldenSet, 'basic (BM25-only)', { mode: 'basic' });
        printReport(basicReport, { verbose });
        reports.push(basicReport);

        // 2. Advanced mode — first stage only (rerank disabled via sort=impact which skips rerank)
        console.log('\n[2/3] Advanced mode (hybrid BM25+kNN, no rerank)...');
        const noRerankReport = await runConfig(goldenSet, 'advanced (no rerank)', { mode: 'advanced', sort: 'impact' });
        printReport(noRerankReport, { verbose });
        reports.push(noRerankReport);

        // 3. Advanced mode — full pipeline with reranker
        console.log('\n[3/3] Advanced mode (hybrid BM25+kNN + reranker)...');
        const fullReport = await runConfig(goldenSet, 'advanced (+ reranker)', { mode: 'advanced', sort: 'relevance' });
        printReport(fullReport, { verbose });
        reports.push(fullReport);

        printComparison(reports);
    }

    const hasErrors = reports.some(r => r.errors.length > 0);
    console.log(`\nOverall: ${hasErrors ? 'FAIL (errors above)' : 'PASS'}`);
    process.exit(hasErrors ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
