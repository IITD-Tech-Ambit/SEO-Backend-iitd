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
        // Adaptive weighting: lexical-rich queries (many BM25 matches) lean on BM25 for
        // precision; sparse-lexical (paraphrase/semantic) queries lean on the vector arm.
        // Selected by ratio = bm25PreCheckHits / candidateK.
        adaptiveHybridWeights: {
            lexicalRich: { bm25: 0.55, vector: 0.45 },
            semantic: { bm25: 0.3, vector: 0.7 },
            lexicalRichRatio: 1.0,
            semanticRatio: 0.2
        },
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

/**
 * How many query tokens the advanced-mode admission gate (_bm25PreCheck) requires before the
 * hybrid query — whose kNN arm returns nearest neighbours for ANY vector — is allowed to run.
 *
 * "Does any ONE token occur anywhere in the corpus" is far too weak for a multi-token query:
 * tokens like "aaa" and "mmm" genuinely occur here (AAAI, abbreviations, OCR noise), so
 * multi-token gibberish cleared the gate on an incidental match and kNN then answered it with a
 * full page of unrelated papers — measured: "aaa bbb ccc" returned 300 results, none containing
 * any query term, while basic mode correctly returned 0.
 *
 * Two is safe for short queries rather than a special case: Lucene requires ALL optional clauses
 * when a query has fewer of them than the threshold, so single-word queries are unaffected
 * (measured identical counts at '1' and '2' for oncology/polymer/quantum). Genuine paraphrase
 * queries keep their semantic recall because they contain several real words — only queries whose
 * grounding is a lone incidental token are turned away.
 *
 * Shared by the papers list and the People sidebar so both admit exactly the same queries; if
 * they diverge, the sidebar credits faculty for a query the papers list answers with nothing.
 */
export const PRECHECK_MIN_TOKENS = '2';

/**
 * Fuzziness for the typo probe and the fuzzy fallback it routes to.
 *
 * AUTO rather than a flat edit distance of 2: at 2 edits a 5-character token like "dhruv" is
 * within reach of a large slice of the vocabulary, which turned the fallback into a broadening
 * step. AUTO scales the budget with term length (1 edit up to 5 chars, 2 beyond).
 *
 * prefix_length pins the first character. AUTO still grants a 3-character token a full edit —
 * a third of the token — which is enough for nonsense like "jjj kkk lll mmm" to reach real
 * vocabulary and come back with a paper. Real typos overwhelmingly preserve the first letter
 * (quamtum/oncolgy/machien/polimer all do), so requiring it costs recall nothing here and also
 * bounds the term expansion OpenSearch has to enumerate.
 */
export const TYPO_FUZZ = Object.freeze({ fuzziness: 'AUTO', prefix_length: 1 });
