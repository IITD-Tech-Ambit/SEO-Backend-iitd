#!/usr/bin/env node
/**
 * Ad-hoc medium / hard / very-hard retrieval eval from a real Mongo batch.
 *
 * Usage:
 *   node tests/eval/adhoc_difficulty_eval.mjs --corpus=/tmp/retrieval_eval/papers_batch.json --endpoint=paper
 *   node tests/eval/adhoc_difficulty_eval.mjs --corpus=/tmp/retrieval_eval/patents_batch.json --endpoint=ip
 *
 * Env:
 *   SEARCH_API_URL  default http://localhost:3001/api/v1
 *   RERANK          true|false (default false for stable first-stage measurement)
 *   PER_PAGE        default 50
 *   OUT             optional path for JSON report
 */

import { readFile, writeFile } from 'fs/promises';
import { computeAll, averageMetrics } from './metrics.mjs';

const API_BASE = process.env.SEARCH_API_URL || `http://localhost:${process.env.PORT || 3001}/api/v1`;
const RERANK = process.env.RERANK === 'true';
const PER_PAGE = parseInt(process.env.PER_PAGE || '50', 10);
const MODE = process.env.MODE || 'advanced';

const args = Object.fromEntries(
    process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
        const [k, ...rest] = a.slice(2).split('=');
        return [k, rest.join('=') || true];
    })
);

const ENDPOINT = args.endpoint || 'paper'; // paper | ip
const CORPUS_PATH = args.corpus;
const OUT = args.out || process.env.OUT || `/tmp/retrieval_eval/${ENDPOINT}_eval_report.json`;

if (!CORPUS_PATH) {
    console.error('Missing --corpus=...');
    process.exit(1);
}

const STOP = new Set([
    'a', 'an', 'the', 'and', 'or', 'of', 'for', 'in', 'on', 'to', 'with', 'from', 'by',
    'using', 'based', 'into', 'over', 'under', 'via', 'its', 'their', 'this', 'that',
    'are', 'is', 'was', 'were', 'be', 'as', 'at', 'between', 'among', 'during', 'after',
    'before', 'about', 'against', 'through', 'within', 'without', 'method', 'methods',
    'system', 'systems', 'device', 'devices', 'process', 'processes', 'apparatus',
    'present', 'invention', 'discloses', 'relates', 'comprising', 'thereof', 'herein',
]);

const COMMON = new Set([
    'energy', 'power', 'control', 'network', 'sensor', 'wireless', 'machine', 'learning',
    'deep', 'neural', 'data', 'analysis', 'optimization', 'simulation', 'thermal', 'solar',
    'battery', 'water', 'carbon', 'polymer', 'composite', 'structure', 'film', 'thin',
    'image', 'signal', 'algorithm', 'model', 'modeling', 'design', 'performance',
    'efficient', 'novel', 'improved', 'high', 'low', 'multi', 'hybrid', 'smart',
]);

function tokenize(text) {
    return (text || '')
        .toLowerCase()
        .replace(/<[^>]+>/g, ' ')
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w));
}

function uniq(arr) {
    return [...new Set(arr)];
}

function titleWords(doc) {
    return tokenize(doc.title);
}

function abstractOnlyRare(doc, n = 4) {
    const tset = new Set(titleWords(doc));
    return uniq(
        tokenize(doc.abstract).filter((w) => !tset.has(w) && w.length >= 7 && !COMMON.has(w))
    ).slice(0, n);
}

function pick(docs, predicate, limit) {
    return docs.filter(predicate).slice(0, limit);
}

function deterministicShuffle(docs, seed = 7) {
    const arr = [...docs];
    let s = seed;
    for (let i = arr.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const j = s % (i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function inventName(doc) {
    const inv = doc.inventors?.[0]?.name || doc.inventors?.[0]?.raw_name;
    if (!inv) return null;
    const parts = String(inv).trim().split(/\s+/);
    return parts[parts.length - 1]; // surname-ish
}

function authorSurname(doc) {
    const name = doc.authors?.[0]?.author_name;
    if (!name) return null;
    // "Behera, B.K." or "Sinha, I."
    if (name.includes(',')) return name.split(',')[0].trim();
    const parts = name.trim().split(/\s+/);
    return parts[parts.length - 1];
}

/**
 * Build medium / hard / very_hard queries with source doc as grade-3 relevant.
 * Judgments are sparse (source + same-title-overlap neighbors when available).
 */
function buildQueries(docs, { kind }) {
    const shuffled = deterministicShuffle(docs, kind === 'ip' ? 11 : 3);
    const queries = [];
    const used = new Set();

    const add = (entry) => {
        if (!entry.query || entry.query.length < 4) return;
        const key = `${entry.difficulty}|${entry.type}|${entry.query.toLowerCase()}`;
        if (used.has(key)) return;
        used.add(key);
        queries.push(entry);
    };

    // ---- MEDIUM ----
    // 1) Distinctive multi-word title snippet (not all common words)
    for (const doc of pick(shuffled, (d) => titleWords(d).length >= 6, 80)) {
        const words = titleWords(doc);
        const rareRatio = words.filter((w) => !COMMON.has(w)).length / words.length;
        if (rareRatio < 0.35) continue;
        const snippet = words.slice(0, 5).join(' ');
        add({
            id: `med-title-${queries.length + 1}`,
            difficulty: 'medium',
            type: 'title_phrase',
            query: snippet,
            source_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 3 },
            notes: 'Distinctive 5-token title phrase; source should rank high',
        });
        if (queries.filter((q) => q.difficulty === 'medium' && q.type === 'title_phrase').length >= 8) break;
    }

    // 2) Field/topic + distinctive keyword
    for (const doc of shuffled) {
        const field = kind === 'ip' ? doc.field_of_invention : doc.field_associated;
        const kw = titleWords(doc).find((w) => w.length >= 6 && !COMMON.has(w));
        if (!field || !kw) continue;
        add({
            id: `med-field-${queries.length + 1}`,
            difficulty: 'medium',
            type: 'field_keyword',
            query: `${String(field).toLowerCase()} ${kw}`,
            source_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 3 },
            notes: 'Field + rare title keyword',
        });
        if (queries.filter((q) => q.difficulty === 'medium' && q.type === 'field_keyword').length >= 6) break;
    }

    // 3) Person + topic (author/inventor)
    for (const doc of shuffled) {
        const person = kind === 'ip' ? inventName(doc) : authorSurname(doc);
        const kw = titleWords(doc).find((w) => w.length >= 6 && !COMMON.has(w));
        if (!person || person.length < 3 || !kw) continue;
        add({
            id: `med-person-${queries.length + 1}`,
            difficulty: 'medium',
            type: 'person_topic',
            query: `${person} ${kw}`,
            source_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 3 },
            notes: 'Person surname + topical keyword',
        });
        if (queries.filter((q) => q.difficulty === 'medium' && q.type === 'person_topic').length >= 4) break;
    }

    // ---- HARD ----
    // 1) Long truncated title (rank-1 stress)
    for (const doc of pick(shuffled, (d) => (d.title || '').length >= 70, 100)) {
        const trunc = (doc.title || '').replace(/\s+/g, ' ').trim().slice(0, 55).trim();
        if (trunc.split(/\s+/).length < 6) continue;
        add({
            id: `hard-trunc-${queries.length + 1}`,
            difficulty: 'hard',
            type: 'truncated_title',
            query: trunc,
            source_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 3 },
            notes: 'Truncated long title; expects near rank-1',
        });
        if (queries.filter((q) => q.difficulty === 'hard' && q.type === 'truncated_title').length >= 8) break;
    }

    // 2) Abstract-only rare terms (lexical gap vs title)
    for (const doc of shuffled) {
        const terms = abstractOnlyRare(doc, 4);
        if (terms.length < 3) continue;
        add({
            id: `hard-abs-${queries.length + 1}`,
            difficulty: 'hard',
            type: 'abstract_gap',
            query: terms.slice(0, 3).join(' '),
            source_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 3 },
            notes: 'Abstract-only rare terms absent from title',
        });
        if (queries.filter((q) => q.difficulty === 'hard' && q.type === 'abstract_gap').length >= 8) break;
    }

    // 3) Partial title dominated by common words
    for (const doc of shuffled) {
        const words = titleWords(doc);
        const commons = words.filter((w) => COMMON.has(w));
        if (commons.length < 2) continue;
        const rare = words.find((w) => !COMMON.has(w) && w.length >= 5);
        if (!rare) continue;
        add({
            id: `hard-common-${queries.length + 1}`,
            difficulty: 'hard',
            type: 'common_partial',
            query: `${commons.slice(0, 2).join(' ')} ${rare}`,
            source_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 3 },
            notes: 'Common-word-heavy partial query — precision trap',
        });
        if (queries.filter((q) => q.difficulty === 'hard' && q.type === 'common_partial').length >= 4) break;
    }

    // ---- VERY HARD ----
    // 1) Semantic paraphrase from abstract (drop title tokens)
    const paraphraseTemplates = [
        (terms) => `techniques for ${terms[0]} involving ${terms.slice(1, 3).join(' and ')}`,
        (terms) => `approaches to improve ${terms[0]} using ${terms[1] || terms[0]}`,
        (terms) => `how to achieve ${terms.slice(0, 3).join(' ')}`,
    ];
    let vhPara = 0;
    for (const doc of shuffled) {
        const terms = abstractOnlyRare(doc, 5);
        if (terms.length < 3) continue;
        const q = paraphraseTemplates[vhPara % paraphraseTemplates.length](terms);
        add({
            id: `vh-para-${queries.length + 1}`,
            difficulty: 'very_hard',
            type: 'paraphrase',
            query: q,
            source_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 3 },
            notes: 'NL paraphrase with minimal title lexical overlap',
        });
        vhPara++;
        if (vhPara >= 8) break;
    }

    // 2) Synonym-ish / concept query: field + abstract rare, no title words
    let vhSyn = 0;
    for (const doc of shuffled) {
        const field = kind === 'ip' ? doc.field_of_invention : doc.field_associated;
        const terms = abstractOnlyRare(doc, 4);
        const tset = new Set(titleWords(doc));
        const term = terms.find((t) => !tset.has(t));
        if (!field || !term) continue;
        add({
            id: `vh-concept-${queries.length + 1}`,
            difficulty: 'very_hard',
            type: 'concept_gap',
            query: `${String(field).toLowerCase()} ${term} applications`,
            source_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 2 },
            notes: 'Broad concept query; source is weakly lexical match',
        });
        vhSyn++;
        if (vhSyn >= 6) break;
    }

    // 3) Single rare technical token only
    let vhSingle = 0;
    for (const doc of shuffled) {
        const rare = uniq([...titleWords(doc), ...abstractOnlyRare(doc, 6)])
            .filter((w) => w.length >= 9 && !COMMON.has(w));
        if (!rare.length) continue;
        add({
            id: `vh-single-${queries.length + 1}`,
            difficulty: 'very_hard',
            type: 'single_rare',
            query: rare[0],
            source_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 2 },
            notes: 'Single rare technical token — high ambiguity',
        });
        vhSingle++;
        if (vhSingle >= 4) break;
    }

    return queries;
}

async function search(query) {
    const path = ENDPOINT === 'ip' ? '/ip/search' : '/search';
    const body = {
        query,
        mode: MODE,
        sort: 'relevance',
        per_page: PER_PAGE,
        page: 1,
        rerank: RERANK,
    };
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json();
}

function rankOf(retrieved, id) {
    const i = retrieved.findIndex((x) => x === id);
    return i < 0 ? null : i + 1;
}

function avgBy(rows, key) {
    const vals = rows.map((r) => r[key]).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

async function main() {
    const corpus = JSON.parse(await readFile(CORPUS_PATH, 'utf8'));
    const docs = (corpus.documents || []).map((d) => ({
        ...d,
        mongo_id: d.mongo_id || String(d._id),
    }));
    const kind = ENDPOINT === 'ip' ? 'ip' : 'paper';
    const queries = buildQueries(docs, { kind });

    console.log(`\nEndpoint: ${ENDPOINT}  API: ${API_BASE}  mode=${MODE} rerank=${RERANK}`);
    console.log(`Corpus: ${docs.length} docs from ${CORPUS_PATH}`);
    console.log(`Queries built: ${queries.length}`);
    for (const diff of ['medium', 'hard', 'very_hard']) {
        console.log(`  ${diff}: ${queries.filter((q) => q.difficulty === diff).length}`);
    }

    const perQuery = [];
    const errors = [];

    for (const q of queries) {
        try {
            const resp = await search(q.query);
            const retrieved = (resp.results || []).map((r) => String(r.mongo_id || r._id));
            const metrics = computeAll(retrieved, q.relevant);
            const sourceRank = rankOf(retrieved, q.source_id);
            const top = (resp.results || []).slice(0, 3).map((r) => ({
                id: String(r.mongo_id || r._id),
                title: (r.title || '').slice(0, 100),
            }));
            perQuery.push({
                ...metrics,
                id: q.id,
                difficulty: q.difficulty,
                type: q.type,
                query: q.query,
                source_id: q.source_id,
                source_title: (q.source_title || '').slice(0, 120),
                source_rank: sourceRank,
                hit_at_10: sourceRank != null && sourceRank <= 10,
                hit_at_50: sourceRank != null && sourceRank <= 50,
                total_hits: resp.pagination?.total ?? null,
                top3: top,
                notes: q.notes,
            });
            const mark = sourceRank == null ? 'MISS' : `#${sourceRank}`;
            console.log(`[${q.difficulty}/${q.type}] ${mark.padEnd(5)} R@50=${(metrics.recall_50 ?? 0).toFixed(2)} MRR=${metrics.mrr.toFixed(2)} | ${q.query.slice(0, 70)}`);
        } catch (err) {
            errors.push({ id: q.id, query: q.query, error: err.message });
            console.log(`[ERR] ${q.id}: ${err.message}`);
        }
    }

    const byDiff = {};
    for (const diff of ['medium', 'hard', 'very_hard']) {
        const rows = perQuery.filter((r) => r.difficulty === diff);
        byDiff[diff] = {
            count: rows.length,
            ...averageMetrics(rows),
            hit_at_10: avgBy(rows, 'hit_at_10'),
            hit_at_50: avgBy(rows, 'hit_at_50'),
            source_rank_median: (() => {
                const ranks = rows.map((r) => r.source_rank).filter((x) => x != null).sort((a, b) => a - b);
                if (!ranks.length) return null;
                return ranks[Math.floor(ranks.length / 2)];
            })(),
            miss_rate: rows.length ? rows.filter((r) => r.source_rank == null).length / rows.length : null,
            failures: rows
                .filter((r) => r.source_rank == null || r.source_rank > 10)
                .slice(0, 8)
                .map((r) => ({
                    id: r.id,
                    type: r.type,
                    query: r.query,
                    source_rank: r.source_rank,
                    source_title: r.source_title,
                    top3: r.top3,
                    notes: r.notes,
                })),
        };
    }

    const byType = {};
    for (const r of perQuery) {
        (byType[r.type] ||= []).push(r);
    }
    const typeSummary = Object.fromEntries(
        Object.entries(byType).map(([type, rows]) => [
            type,
            {
                count: rows.length,
                miss_rate: rows.filter((r) => r.source_rank == null).length / rows.length,
                hit_at_10: avgBy(rows, 'hit_at_10'),
                mrr: avgBy(rows, 'mrr'),
                recall_50: avgBy(rows, 'recall_50'),
                ndcg_10: avgBy(rows, 'ndcg_10'),
            },
        ])
    );

    const report = {
        endpoint: ENDPOINT,
        api: API_BASE,
        mode: MODE,
        rerank: RERANK,
        per_page: PER_PAGE,
        corpus_path: CORPUS_PATH,
        corpus_size: docs.length,
        evaluated_at: new Date().toISOString(),
        query_count: perQuery.length,
        errors,
        by_difficulty: byDiff,
        by_type: typeSummary,
        per_query: perQuery,
        queries_built: queries,
    };

    await writeFile(OUT, JSON.stringify(report, null, 2));

    console.log('\n' + '='.repeat(72));
    console.log(`SUMMARY — ${ENDPOINT} (rerank=${RERANK})`);
    console.log('='.repeat(72));
    for (const [diff, s] of Object.entries(byDiff)) {
        console.log(
            `${diff.padEnd(10)} n=${String(s.count).padStart(2)}  ` +
            `hit@10=${(s.hit_at_10 ?? 0).toFixed(2)}  hit@50=${(s.hit_at_50 ?? 0).toFixed(2)}  ` +
            `miss=${(s.miss_rate ?? 0).toFixed(2)}  MRR=${(s.mrr ?? 0).toFixed(3)}  ` +
            `nDCG@10=${(s.ndcg_10 ?? 0).toFixed(3)}  R@50=${(s.recall_50 ?? 0).toFixed(3)}`
        );
    }
    console.log('\nBy type:');
    for (const [type, s] of Object.entries(typeSummary)) {
        console.log(
            `  ${type.padEnd(16)} n=${s.count} miss=${s.miss_rate.toFixed(2)} hit@10=${s.hit_at_10.toFixed(2)} MRR=${s.mrr.toFixed(3)}`
        );
    }
    console.log(`\nWrote ${OUT}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
