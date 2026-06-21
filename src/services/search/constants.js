/**
 * Search tuning parameters, derived once from app config and shared by every collaborator.
 *
 * minScore notes:
 * - `normalized` (0.12) is a RECALL FLOOR only. The kNN arm gives nearly every document a
 *   non-trivial cosine score, so ~everything clears 0.12 — it is NOT a "is this relevant?"
 *   bar and must never drive user-facing counts.
 * - `relevant` (~1.20) is the calibrated bar separating genuine BM25/semantic matches from
 *   the near-baseline kNN tail. It is the single definition of a "matching paper" used by the
 *   papers list, People sidebar, and faculty drill-down so every displayed count agrees.
 */
export function buildSearchConfig(config) {
    const relevant = config.search?.relevantMinScore ?? 1.20;
    return {
        hybridWeights: { bm25: 0.4, vector: 0.6 },
        fieldBoosts: {
            title: 4,
            titleExact: 5,
            abstract: 1.5,
            subjectArea: 3,
            subjectAreaNgram: 2,
            authorName: 2,
            authorNameNgram: 1.5,
            authorVariants: 2.5,
            authorVariantsNgram: 1.5,
            fieldAssociated: 2.5,
            fieldAssociatedNgram: 1.5
        },
        phraseBoost: 2.5,
        citationFactor: 0.3,
        recencyScale: 5,
        minScore: {
            hybrid: 0.3,
            impact: 0.3,
            normalized: 0.12,
            relevant,
            normalizedAuthorScoped: relevant
        }
    };
}
