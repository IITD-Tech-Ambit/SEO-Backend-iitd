/**
 * IP-search tuning parameters, derived once from app config and shared by collaborators.
 *
 * minScore notes:
 * - `normalized` (0.12) is a RECALL FLOOR only — nearly every doc clears it via kNN; not a relevance bar.
 * - `relevant` (~1.20) is the calibrated bar for lexically-rich queries (genuine BM25/semantic vs kNN tail).
 * - `semanticRelevant` (~1.10) is applied by QueryBuilder._resolveMinScore for sparse-lexical queries
 *   (same regime as adaptiveHybridWeights.semantic). Pure-kNN scores top out near `weights.vector * knn_score`
 *   (~1.18 on this corpus/model), so `relevant` (1.20) structurally excludes semantic-only hits; 1.10 sits
 *   near the ~85th percentile of observed knn scores. Re-measure if embedding model or corpus size changes.
 */
export function buildSearchConfig(config) {
    const relevant = config.search?.relevantMinScore ?? 1.20;
    const semanticRelevant = config.search?.semanticRelevantMinScore ?? 1.10;
    return {
        hybridWeights: { bm25: 0.4, vector: 0.6 },
        // Lexical-rich queries lean BM25; sparse-lexical lean vector. Selected by bm25PreCheckHits / candidateK.
        adaptiveHybridWeights: {
            lexicalRich: { bm25: 0.55, vector: 0.45 },
            semantic: { bm25: 0.3, vector: 0.7 },
            lexicalRichRatio: 1.0,
            semanticRatio: 0.2
        },
        // Non-fuzzy phrase-recall / title-boost slop (word-order slack only).
        phraseSlop: 2,
        fieldBoosts: {
            title: 4,
            titleExact: 5,
            abstract: 1.5,
            fieldOfInvention: 2.5,
            fieldOfInventionNgram: 1.5,
            inventorName: 2,
            inventorNameNgram: 1.5,
            classification: 3,
            applicants: 1.5
        },
        phraseBoost: 2.5,
        recencyScale: 5,
        minScore: {
            hybrid: 0.3,
            normalized: 0.12,
            relevant,
            semanticRelevant
        }
    };
}
