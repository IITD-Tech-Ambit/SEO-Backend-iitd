import { normalizeChain } from './QueryBuilder.js';

// Shared by IpSearchService and IpFacultyForQueryService so a refine chain narrows identically for both.
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

    /** Without pagination_depth, a `hybrid` query silently returns far fewer than `size` hits
     *  once the true match count is large, regardless of the requested size. */
    _withPaginationDepth(body) {
        if (!body?.query?.hybrid) return body;
        const depth = Math.min(Math.max((body.from || 0) + (body.size || 0), 1), this.maxResultWindow);
        return { ...body, query: { ...body.query, hybrid: { ...body.query.hybrid, pagination_depth: depth } } };
    }

    /** Lenient BM25 pre-check (OR across terms) so partial-vocabulary queries pass but gibberish does not. */
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

        const body = (chain.length > 0)
            ? { size: 0, query: { bool: { must: [preCheckClause], filter: refineFilterClauses || this.queryBuilder.buildRefineFilterClauses(chain, search_in) } } }
            : { size: 0, query: preCheckClause };

        const response = await this.opensearch.search({ index: this.indexName, body });
        return response.body.hits.total.value;
    }

    /** Search-within-previous-results narrowing: each refine term is re-resolved to its own real result-id membership (not a literal AND-of-terms match), so a doc that only matched semantically isn't wrongly evicted. */
    async buildAdvancedRefineAnchors(refineChain, searchInNorm, filters) {
        if (!refineChain.length) return null;
        return Promise.all(refineChain.map((term) => this.buildRefineAnchorIdFilter(term, searchInNorm, filters)));
    }

    /** Re-runs `term` as its own advanced search to capture the real doc ids (and scores) it
     *  matched, capped at `maxResultWindow` rather than a smaller fixed ceiling — this anchor is
     *  shared across every faculty member's aggregation at once, so a low cap can miss an
     *  individual's real matches. */
    async buildRefineAnchorIdFilter(term, searchInNorm, filters = {}) {
        const cap = this.maxResultWindow;
        const runAnchorQuery = async (forceIncludeKnn, bm25HitCount) => {
            const embedding = await this.embeddingService.embedQuery(term);
            const osQuery = this.queryBuilder.buildNormalizedHybridQuery(
                term, embedding, filters, 1, cap, searchInNorm,
                { bm25HitCount, candidateK: this.candidateK, refineChain: [], forceIncludeKnn }
            );
            osQuery.size = cap;
            osQuery.from = 0;
            osQuery._source = ['mongo_id'];
            delete osQuery.aggs;
            return this.opensearch.search({ index: this.indexName, body: this._withPaginationDepth(osQuery), search_pipeline: this.rrfPipeline });
        };
        try {
            // BM25-only first; only widen via kNN if that finds nothing — kNN's k is sized for
            // corpus-wide recall, and admitting via it whenever BM25 already found real matches
            // risks pulling in embedding-adjacent-but-off-topic documents for no reason (see
            // InventorScopedSearch._buildRefineAnchorIdFilter for a scoped case where this went
            // from "no filtering effect" to "the anchor's own candidate pool WAS the filter").
            const bm25HitCount = await this.bm25PreCheck(term, searchInNorm, []);
            let resp = await runAnchorQuery(false, bm25HitCount);
            if (resp.body.hits.hits.length === 0) resp = await runAnchorQuery(true, bm25HitCount);
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
