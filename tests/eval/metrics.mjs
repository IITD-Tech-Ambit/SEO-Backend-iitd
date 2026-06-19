/**
 * Information retrieval evaluation metrics.
 *
 * All functions accept:
 *   - retrieved: string[] — ordered list of doc IDs returned by the system
 *   - relevant:  Record<string, number> — map of doc ID → graded relevance (1-3)
 *   - k:         number — cutoff depth
 */

/**
 * Recall@k — fraction of known-relevant docs found in the top k.
 */
export function recallAtK(retrieved, relevant, k) {
    const relSet = new Set(Object.keys(relevant));
    if (relSet.size === 0) return null;
    const topK = retrieved.slice(0, k);
    let found = 0;
    for (const id of topK) {
        if (relSet.has(id)) found++;
    }
    return found / relSet.size;
}

/**
 * Precision@k — fraction of top-k that are relevant.
 */
export function precisionAtK(retrieved, relevant, k) {
    const relSet = new Set(Object.keys(relevant));
    const topK = retrieved.slice(0, k);
    if (topK.length === 0) return 0;
    let found = 0;
    for (const id of topK) {
        if (relSet.has(id)) found++;
    }
    return found / topK.length;
}

/**
 * Mean Reciprocal Rank — 1/rank of the first relevant result.
 */
export function mrr(retrieved, relevant) {
    const relSet = new Set(Object.keys(relevant));
    for (let i = 0; i < retrieved.length; i++) {
        if (relSet.has(retrieved[i])) return 1 / (i + 1);
    }
    return 0;
}

/**
 * nDCG@k — normalized discounted cumulative gain with graded relevance.
 */
export function ndcgAtK(retrieved, relevant, k) {
    const topK = retrieved.slice(0, k);

    const dcg = topK.reduce((sum, id, i) => {
        const rel = relevant[id] || 0;
        return sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2);
    }, 0);

    const idealRels = Object.values(relevant).sort((a, b) => b - a).slice(0, k);
    const idcg = idealRels.reduce((sum, rel, i) => {
        return sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2);
    }, 0);

    return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Compute all metrics for a single query.
 */
export function computeAll(retrieved, relevant) {
    return {
        recall_50: recallAtK(retrieved, relevant, 50),
        precision_10: precisionAtK(retrieved, relevant, 10),
        ndcg_10: ndcgAtK(retrieved, relevant, 10),
        mrr: mrr(retrieved, relevant),
        total_retrieved: retrieved.length,
        total_relevant: Object.keys(relevant).length,
    };
}

/**
 * Average metrics across multiple queries (skips null recall for queries with no relevance judgments).
 */
export function averageMetrics(perQueryMetrics) {
    const keys = ['recall_50', 'precision_10', 'ndcg_10', 'mrr'];
    const avgs = {};
    for (const key of keys) {
        const vals = perQueryMetrics.map(m => m[key]).filter(v => v !== null && v !== undefined);
        avgs[key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    avgs.queries_evaluated = perQueryMetrics.length;
    avgs.queries_with_judgments = perQueryMetrics.filter(m => m.total_relevant > 0).length;
    return avgs;
}
