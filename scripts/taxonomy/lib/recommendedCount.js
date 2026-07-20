/**
 * How many faculty to surface by default for one taxonomy browse
 * combination, out of an already relevance-sorted list (paper_count desc,
 * see rollupAggregations.js#membersPipeline).
 *
 * Method: Pareto/coverage cutoff — the smallest prefix whose combined
 * papers cover `coverage` of the area's total. This adapts per area instead
 * of a fixed N: a few dominant contributors reach coverage fast, a flat
 * distribution needs many more (cutoff saturates at `max`). Ties with the
 * boundary member are included so nobody equally relevant is arbitrarily
 * dropped; tie extension is itself capped so a fully flat distribution
 * can't blow the cutoff back up to hundreds.
 */
export function computeRecommendedCount(sortedCounts, { coverage = 0.8, min = 6, max } = {}) {
    const total = sortedCounts.length;
    if (total <= min) return total;

    const totalPapers = sortedCounts.reduce((sum, m) => sum + m.paper_count, 0);
    let cumulative = 0;
    let k = 0;
    for (; k < total; k++) {
        cumulative += sortedCounts[k].paper_count;
        if (cumulative >= totalPapers * coverage) {
            k++;
            break;
        }
    }

    k = Math.min(Math.max(k, min), max, total);

    const boundaryCount = sortedCounts[k - 1]?.paper_count;
    const tieCeiling = Math.min(total, Math.round(max * 1.5));
    while (k < tieCeiling && sortedCounts[k]?.paper_count === boundaryCount) k++;

    return k;
}
