/**
 * Hybrid pagination_depth: a page-independent floor so every page of a query fuses the same
 * candidate pool. Deriving depth from from+size reordered results between pages.
 */

/** Covers maxPageSize (100) × 5 pages. */
export const DEFAULT_STABLE_DEPTH = 500;

export function resolvePaginationDepth({
    from = 0,
    size = 0,
    candidateK = 50,
    maxResultWindow = 10000,
    stableDepth = DEFAULT_STABLE_DEPTH
} = {}) {
    const floor = Math.max(stableDepth || DEFAULT_STABLE_DEPTH, candidateK || 0);
    return Math.min(Math.max(from + size, floor), maxResultWindow);
}

/** Copy the hybrid object so sibling bodies from a shallow spread don't share pagination_depth. */
export function withPaginationDepth(body, opts = {}) {
    if (!body?.query?.hybrid) return body;
    const depth = resolvePaginationDepth({ from: body.from, size: body.size, ...opts });
    return { ...body, query: { ...body.query, hybrid: { ...body.query.hybrid, pagination_depth: depth } } };
}
