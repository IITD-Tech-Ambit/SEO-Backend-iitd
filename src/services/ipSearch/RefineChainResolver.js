import { normalizeChain } from './QueryBuilder.js';

/**
 * Shared refine-chain resolution for advanced-mode IP search. Both the main results endpoint
 * (IpSearchService) and the full-corpus People sidebar (IpFacultyForQueryService) must narrow a
 * refine chain identically, or the sidebar's total_faculty/total_matching_ip disagrees with what
 * the results list actually found — see buildRefineAnchorIdFilter for why literal keyword
 * co-occurrence is the wrong test for "does this refine term admit this document."
 */
export default class RefineChainResolver {
    constructor({ opensearch, indexName, embeddingService, queryBuilder, rrfPipeline, candidateK, maxResultWindow, logger }) {
        this.opensearch = opensearch;
        this.indexName = indexName;
        this.embeddingService = embeddingService;
        this.queryBuilder = queryBuilder;
        this.rrfPipeline = rrfPipeline;
        this.candidateK = candidateK;
        this.maxResultWindow = maxResultWindow;
        this.logger = logger;
    }

    /**
     * Lenient BM25 pre-check (OR across terms) so partial-vocabulary queries pass but gibberish does not.
     */
    async bm25PreCheck(query, search_in = null, refineChain = [], refineFilterClauses = null) {
        const chain = normalizeChain(refineChain);

        let preCheckClause;
        if (search_in && search_in.length > 0) {
            preCheckClause = this.queryBuilder.buildConstrainedSearchInClause(query, search_in, { fuzziness: 'AUTO' });
        } else {
            const textMatch = {
                multi_match: {
                    query,
                    fields: ['title', 'abstract', 'field_of_invention'],
                    type: 'cross_fields',
                    minimum_should_match: '1'
                }
            };
            const inventorClause = this.queryBuilder.buildInventorMatchClause(query, { fuzziness: 'AUTO' });
            preCheckClause = inventorClause
                ? { bool: { should: [textMatch, inventorClause], minimum_should_match: 1 } }
                : textMatch;
        }

        // Refinement terms are filters so the pre-check reflects the narrowed pool. In advanced
        // mode this uses the anchor's actual result-id membership (see buildRefineAnchorIdFilter)
        // rather than a literal AND-of-terms match.
        const body = (chain.length > 0)
            ? { size: 0, query: { bool: { must: [preCheckClause], filter: refineFilterClauses || this.queryBuilder.buildRefineFilterClauses(chain, search_in) } } }
            : { size: 0, query: preCheckClause };

        const response = await this.opensearch.search({ index: this.indexName, body });
        return response.body.hits.total.value;
    }

    /**
     * True "search within previous results" narrowing: each refine-chain term is re-resolved to
     * its own actual min-score-gated advanced-search result ids (capped generously), and the
     * filter restricts subsequent narrowing to that real membership set. Each doc's own anchor
     * score is also captured (see buildRefineAnchorIdFilter) so ranking can compound relevance
     * across the chain instead of discarding it once a doc passes the membership gate.
     *
     * A looser re-derived match clause (e.g. fuzzy-BM25 OR raw kNN) is the wrong tool for the
     * filter itself: a kNN clause in filter context ignores min_score and always contributes up to
     * k neighbors regardless of true relevance, so it can make the "narrowed" count larger than the
     * anchor's own result count — the opposite of narrowing. Filtering on the anchor's real ids is
     * the only way to guarantee the pool never grows while still keeping every doc the anchor step
     * actually surfaced (including ones that only matched it semantically).
     */
    async buildAdvancedRefineAnchors(refineChain, searchInNorm, filters) {
        if (!refineChain.length) return null;
        return Promise.all(refineChain.map((term) => this.buildRefineAnchorIdFilter(term, searchInNorm, filters)));
    }

    /** Re-runs `term` as its own advanced search (same filters as the real search, e.g. an
     *  inventor kerberos scope, no further refinement) to capture the real doc ids AND per-doc
     *  scores it matched, capped at `maxResultWindow` (or 2000). Anchoring without the current
     *  filters would let a broad/common anchor phrase compete against the WHOLE corpus for a
     *  spot in that cap — a filter-scoped candidate's real matches can rank outside the
     *  unscoped top-`cap` even though they'd be the obvious top matches within the filtered set. */
    async buildRefineAnchorIdFilter(term, searchInNorm, filters = {}) {
        const cap = Math.min(this.maxResultWindow, 2000);
        try {
            const embedding = await this.embeddingService.embedQuery(term);
            // Must resolve the same bm25HitCount-driven min_score/weights regime the anchor's own
            // original search used — passing bm25HitCount: null falls back to the loosest bar,
            // capturing far more "members" than the anchor actually returned as results.
            const bm25HitCount = await this.bm25PreCheck(term, searchInNorm, []);
            const osQuery = this.queryBuilder.buildNormalizedHybridQuery(
                term, embedding, filters, 1, cap, searchInNorm,
                { bm25HitCount, candidateK: this.candidateK, refineChain: [] }
            );
            osQuery.size = cap;
            osQuery.from = 0;
            osQuery._source = ['mongo_id'];
            delete osQuery.aggs;

            const resp = await this.opensearch.search({ index: this.indexName, body: osQuery, search_pipeline: this.rrfPipeline });
            const ids = [];
            const scoreById = {};
            for (const hit of resp.body.hits.hits) {
                const id = hit._source.mongo_id;
                if (!id) continue;
                ids.push(id);
                scoreById[id] = hit._score;
            }
            const filter = ids.length > 0 ? { terms: { mongo_id: ids } } : { match_none: {} };
            return { filter, scoreById };
        } catch (err) {
            this.logger.warn({ err: err?.message, term }, 'Refine anchor id-membership lookup failed; falling back to literal narrowing');
            return { filter: this.queryBuilder.buildLiteralPrimaryClause(term, searchInNorm), scoreById: {} };
        }
    }
}
