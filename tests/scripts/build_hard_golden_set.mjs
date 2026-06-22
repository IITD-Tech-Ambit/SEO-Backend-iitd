/**
 * Build a difficult, corpus-analyzed golden set for rigorous retrieval evaluation.
 *
 * Designed to stress every metric:
 *   MRR / P@1   — exact distinctive phrases, long truncated titles
 *   P@5/P@10    — graded multi-relevant clusters (3/2/1)
 *   nDCG@10     — ordering among similarly titled docs in the same topic
 *   Recall@50   — broad topic clusters with many judged docs in the sample
 *   Semantic    — abstract-only terms absent from title; NL paraphrases
 *   Precision   — partial queries dominated by corpus-common words
 *   Author      — IITD faculty surname + topical qualifier
 *
 * All judgments reference mongo_ids present in test_corpus.json.
 */

import {
    extractKeywords,
    getAuthorSurname,
    pickDeterministic,
    titleSnippet,
} from './build_comprehensive_golden_set.mjs';

const COMMON_TITLE_WORDS = new Set([
    'energy', 'synthesis', 'properties', 'india', 'carbon', 'metal', 'power', 'control',
    'optimization', 'simulation', 'detection', 'analysis', 'treatment', 'water', 'thermal',
    'electrical', 'magnetic', 'optical', 'composite', 'structure', 'process', 'processing',
    'fabric', 'fabrication', 'algorithm', 'algorithms', 'wireless', 'sensor', 'sensors',
    'network', 'networks', 'image', 'images', 'signal', 'signals', 'voltage', 'current',
    'frequency', 'antenna', 'film', 'films', 'thin', 'layer', 'layers', 'phase',
    'temperature', 'stress', 'strain', 'load', 'loading', 'impact', 'damage', 'failure',
    'microstructure', 'nanoparticle', 'nanoparticles', 'graphene', 'quantum', 'laser',
    'plasma', 'catalyst', 'polymer', 'polymers', 'finite', 'element', 'machine', 'learning',
    'deep', 'neural', 'data', 'hybrid', 'nonlinear', 'solar', 'from', 'using', 'based',
]);

function tokenize(text) {
    return (text || '').toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3);
}

function titleOverlap(a, b) {
    const A = new Set(tokenize(a));
    const B = new Set(tokenize(b));
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter || 1);
}

function commonWordRatio(title) {
    const words = extractKeywords(title, 12);
    if (!words.length) return 1;
    return words.filter(w => COMMON_TITLE_WORDS.has(w)).length / words.length;
}

function abstractOnlyTerms(doc, minLen = 7, count = 4) {
    const titleSet = new Set(tokenize(doc.title));
    return [...new Set(
        tokenize(doc.abstract)
            .filter(w => !titleSet.has(w) && w.length >= minLen && !COMMON_TITLE_WORDS.has(w))
    )].slice(0, count);
}

function buildTopicCluster(docs, queryWords, { minDocs = 3, maxJudged = 8 } = {}) {
    const terms = queryWords.map(w => w.toLowerCase());
    const matching = docs.filter(d => {
        const t = (d.title || '').toLowerCase();
        return terms.every(w => t.includes(w));
    });
    if (matching.length < minDocs) return null;

    const ranked = [...matching].sort((a, b) => {
        const score = (d) => terms.reduce((s, w) => s + ((d.title || '').toLowerCase().includes(w) ? 1 : 0), 0)
            + (d.citation_count || 0) * 0.001;
        return score(b) - score(a);
    });

    const relevant = {};
    ranked.slice(0, maxJudged).forEach((d, i) => {
        relevant[d.mongo_id] = i === 0 ? 3 : i < 3 ? 2 : 1;
    });

    return {
        query: queryWords.join(' '),
        matching_docs: matching.length,
        relevant,
        anchor: ranked[0],
    };
}

function discoverBigramClusters(docs, minDocs = 3, maxClusters = 6) {
    const bg = new Map();
    for (const d of docs) {
        const words = extractKeywords(d.title, 10);
        for (let i = 0; i < words.length - 1; i++) {
            const key = `${words[i]} ${words[i + 1]}`;
            if (!bg.has(key)) bg.set(key, []);
            bg.get(key).push(d);
        }
    }
    return [...bg.entries()]
        .filter(([, arr]) => arr.length >= minDocs)
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .slice(0, maxClusters)
        .map(([query, arr]) => buildTopicCluster(docs, query.split(' '), { minDocs, maxJudged: Math.min(8, arr.length) }))
        .filter(Boolean);
}

function findSimilarTitleGroups(docs, minOverlap = 0.38, maxGroups = 5) {
    const groups = [];
    const used = new Set();

    for (const anchor of [...docs].sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0))) {
        if (used.has(anchor.mongo_id)) continue;
        const group = [anchor];
        for (const other of docs) {
            if (other.mongo_id === anchor.mongo_id || used.has(other.mongo_id)) continue;
            if (anchor.field_associated !== other.field_associated) continue;
            if (titleOverlap(anchor.title, other.title) >= minOverlap) group.push(other);
        }
        if (group.length >= 2) {
            groups.push(group);
            group.forEach(d => used.add(d.mongo_id));
        }
        if (groups.length >= maxGroups) break;
    }
    return groups;
}

const PARAPHRASES = [
    (doc) => {
        const kw = extractKeywords(doc.title, 3);
        if (kw.length < 2) return null;
        return `research investigating ${kw.join(' and ')} mechanisms`;
    },
    (doc) => {
        const kw = extractKeywords(doc.title, 2);
        if (kw.length < 2) return null;
        return `what approaches exist for ${kw[0]} related ${kw[1]} problems`;
    },
    (doc) => {
        const field = doc.field_associated || 'engineering';
        const kw = extractKeywords(doc.title, 2);
        if (!kw.length) return null;
        return `${field.toLowerCase()} work on ${kw.join(' ')}`;
    },
];

/**
 * @param {{ documents: object[], total_documents?: number, sample_size?: number }} corpus
 */
export function buildHardGoldenSet(corpus) {
    const docs = (corpus.documents || []).filter(d => d.title?.length > 10);
    const queries = [];
    let qid = 0;

    const docsWithAbstract = docs.filter(d => d.abstract && d.abstract.length > 120);

    // ── 1. MRR / P@1: distinctive exact phrases (long titles truncated at word boundary) ──
    const longDistinct = pickDeterministic(
        docs.filter(d => d.title.length >= 90 && extractKeywords(d.title, 5).length >= 4),
        12,
        5
    );
    for (const doc of longDistinct) {
        queries.push({
            id: `hard-exact-${++qid}`,
            query: titleSnippet(doc.title, 85),
            type: 'hard_exact_rank1',
            difficulty: 'high',
            metric_focus: ['mrr', 'precision_1', 'ndcg_10'],
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 3 },
            notes: 'Long title truncated; source must appear at rank 1',
        });
    }

    // ── 2. P@10 stress: partial queries with mostly common corpus words ──
    const hardPartial = [...docs]
        .filter(d => commonWordRatio(d.title) >= 0.55 && extractKeywords(d.title, 5).length >= 3)
        .sort((a, b) => commonWordRatio(b.title) - commonWordRatio(a.title));
    for (const doc of pickDeterministic(hardPartial, 10, 4)) {
        const kw = extractKeywords(doc.title, 4);
        queries.push({
            id: `hard-partial-noise-${++qid}`,
            query: kw.join(' '),
            type: 'hard_partial_common',
            difficulty: 'high',
            metric_focus: ['precision_10', 'mrr', 'recall_50'],
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 3 },
            notes: 'Query terms are corpus-common; many distractors expected',
        });
    }

    // ── 3. nDCG: graded multi-doc clusters (explicit 3/2/1 judgments) ──
    const manualClusters = [
        ['induction', 'motor'],
        ['thin', 'films'],
        ['power', 'quality'],
        ['shear', 'thickening'],
        ['finite', 'element'],
    ];
    for (const terms of manualClusters) {
        const cluster = buildTopicCluster(docs, terms, { minDocs: 2, maxJudged: 6 });
        if (!cluster) continue;
        queries.push({
            id: `hard-cluster-${++qid}`,
            query: cluster.query,
            type: 'hard_graded_cluster',
            difficulty: 'high',
            metric_focus: ['ndcg_10', 'recall_50', 'precision_10'],
            matching_docs: cluster.matching_docs,
            source_mongo_id: cluster.anchor.mongo_id,
            source_title: cluster.anchor.title,
            relevant: cluster.relevant,
            notes: 'Graded 3/2/1 cluster; tests ranking quality among similar docs',
        });
    }

    for (const cluster of discoverBigramClusters(docs, 3, 4)) {
        queries.push({
            id: `hard-cluster-${++qid}`,
            query: cluster.query,
            type: 'hard_graded_cluster',
            difficulty: 'medium',
            metric_focus: ['ndcg_10', 'recall_50'],
            matching_docs: cluster.matching_docs,
            source_mongo_id: cluster.anchor.mongo_id,
            relevant: cluster.relevant,
            notes: 'Auto-mined title bigram cluster from corpus',
        });
    }

    // ── 4. Recall@50: ambiguous broad terms with many judged docs in sample ──
    const ambiguousTerms = ['solar', 'carbon', 'impact', 'antenna', 'algorithm', 'sensor'];
    for (const term of ambiguousTerms) {
        const matching = docs.filter(d => (d.title || '').toLowerCase().includes(term));
        if (matching.length < 5) continue;
        const relevant = {};
        for (const d of pickDeterministic(matching, Math.min(10, matching.length), 3)) {
            relevant[d.mongo_id] = (d.title || '').toLowerCase().includes(`${term} `) ? 2 : 1;
        }
        queries.push({
            id: `hard-recall-${++qid}`,
            query: term,
            type: 'hard_ambiguous_recall',
            difficulty: 'high',
            metric_focus: ['recall_50', 'precision_10'],
            matching_docs: matching.length,
            relevant,
            notes: `Ambiguous corpus token "${term}" appears in ${matching.length} sample docs`,
        });
    }

    // ── 5. Semantic gap: abstract-only terms not present in title ──
    const abstractGapDocs = docsWithAbstract
        .map(d => ({ doc: d, terms: abstractOnlyTerms(d) }))
        .filter(x => x.terms.length >= 3)
        .sort((a, b) => b.terms.length - a.terms.length);
    for (const { doc, terms } of pickDeterministic(abstractGapDocs.map(x => x.doc), 12, 6).map(d =>
        abstractGapDocs.find(x => x.doc.mongo_id === d.mongo_id)
    ).filter(Boolean)) {
        queries.push({
            id: `hard-abstract-${++qid}`,
            query: terms.slice(0, 3).join(' '),
            type: 'hard_abstract_gap',
            difficulty: 'high',
            metric_focus: ['mrr', 'recall_50', 'ndcg_10'],
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            abstract_terms: terms,
            relevant: { [doc.mongo_id]: 3 },
            notes: 'Query terms appear in abstract but not title — tests semantic/hybrid recall',
        });
    }

    // ── 6. NL paraphrases (minimal lexical overlap with title) ──
    for (const doc of pickDeterministic(docsWithAbstract, 10, 8)) {
        const template = PARAPHRASES[qid % PARAPHRASES.length];
        const paraphrase = template(doc);
        if (!paraphrase) continue;
        const titleTokens = new Set(tokenize(doc.title));
        const paraTokens = tokenize(paraphrase);
        const overlap = paraTokens.filter(t => titleTokens.has(t)).length / (paraTokens.length || 1);
        if (overlap > 0.6) continue;
        queries.push({
            id: `hard-paraphrase-${++qid}`,
            query: paraphrase,
            type: 'hard_paraphrase',
            difficulty: 'high',
            metric_focus: ['mrr', 'recall_50', 'ndcg_10'],
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            lexical_overlap: Number(overlap.toFixed(2)),
            relevant: { [doc.mongo_id]: 2 },
            notes: 'Natural-language paraphrase with low title token overlap',
        });
    }

    // ── 7. Author + topic disambiguation (IITD kerberos papers) ──
    const authorDocs = pickDeterministic(
        docs.filter(d => d.kerberos && getAuthorSurname(d)),
        8,
        9
    );
    for (const doc of authorDocs) {
        const surname = getAuthorSurname(doc);
        const kw = extractKeywords(doc.title, 2);
        if (!surname || !kw.length) continue;
        queries.push({
            id: `hard-author-${++qid}`,
            query: `${surname} ${kw[0]}`,
            type: 'hard_author_disambiguation',
            difficulty: 'medium',
            metric_focus: ['mrr', 'precision_5'],
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            kerberos: doc.kerberos,
            relevant: { [doc.mongo_id]: 3 },
            notes: 'Faculty surname + distinctive title keyword',
        });
    }

    // ── 8. Near-duplicate ordering: similar titles same field, anchor must outrank peers ──
    for (const group of findSimilarTitleGroups(docs)) {
        const anchor = group[0];
        const kw = extractKeywords(anchor.title, 4);
        if (kw.length < 2) continue;
        const relevant = { [anchor.mongo_id]: 3 };
        for (const peer of group.slice(1, 4)) relevant[peer.mongo_id] = 1;
        queries.push({
            id: `hard-distractor-${++qid}`,
            query: kw.slice(0, 3).join(' '),
            type: 'hard_distractor_ranking',
            difficulty: 'high',
            metric_focus: ['ndcg_10', 'mrr', 'precision_10'],
            source_mongo_id: anchor.mongo_id,
            source_title: anchor.title,
            peer_count: group.length - 1,
            relevant,
            notes: 'Similar-title peers in same field; anchor should rank above grade-1 distractors',
        });
    }

    // ── 9. Cross-field trap: common keyword + specific field from source doc ──
    for (const doc of pickDeterministic(docs.filter(d => d.field_associated), 8, 10)) {
        const kw = extractKeywords(doc.title, 1);
        if (!kw.length || !COMMON_TITLE_WORDS.has(kw[0])) continue;
        queries.push({
            id: `hard-cross-${++qid}`,
            query: `${kw[0]} ${doc.field_associated}`,
            type: 'hard_cross_field',
            difficulty: 'medium',
            metric_focus: ['precision_10', 'mrr'],
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 3 },
            notes: 'Common keyword scoped by field — tests precision under cross-field noise',
        });
    }

    return {
        version: 1,
        description: 'Hard golden set: corpus-analyzed difficult queries stressing all IR metrics',
        corpus_documents: corpus.total_documents ?? docs.length,
        corpus_sample_size: corpus.sample_size ?? docs.length,
        exported_at: new Date().toISOString(),
        categories: {
            hard_exact_rank1: 'Truncated long title — MRR/P@1 must find exact source at rank 1',
            hard_partial_common: 'Partial query with corpus-common words — precision under noise',
            hard_graded_cluster: 'Multi-doc cluster with 3/2/1 grades — nDCG and recall',
            hard_ambiguous_recall: 'Ambiguous single token with many sample matches — recall@50',
            hard_abstract_gap: 'Abstract-only terms absent from title — semantic recall',
            hard_paraphrase: 'NL paraphrase with low lexical overlap — vector recall',
            hard_author_disambiguation: 'Faculty surname + topic keyword',
            hard_distractor_ranking: 'Similar-title peers; anchor must outrank distractors',
            hard_cross_field: 'Common keyword + field constraint',
        },
        metric_definitions: {
            recall_50: 'Fraction of judged relevant docs found in top 50',
            precision_1: 'Relevant doc at rank 1 (strict top-1 accuracy)',
            precision_5: 'Relevant docs in top 5 / 5',
            precision_10: 'Relevant docs in top 10 / 10',
            ndcg_10: 'Graded ranking quality in top 10',
            mrr: 'Reciprocal rank of first relevant doc',
        },
        queries,
    };
}

export { commonWordRatio, abstractOnlyTerms, buildTopicCluster, titleOverlap };
