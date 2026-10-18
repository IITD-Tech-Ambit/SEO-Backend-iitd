import { normalizeChain } from './QueryBuilder.js';
import { withPaginationDepth, DEFAULT_STABLE_DEPTH } from '../search/paginationDepth.js';

// Shared by IpSearchService and IpFacultyForQueryService so a refine chain narrows identically for both.
export default class RefineChainResolver {
    constructor({ opensearch, indexName, embeddingService, queryBuilder, rrfPipeline, maxResultWindow, rrfStableDepth, logger }) {
        this.opensearch = opensearch;
        this.indexName = indexName;
        this.embeddingService = embeddingService;
        this.queryBuilder = queryBuilder;
        this.rrfPipeline = rrfPipeline;
        this.maxResultWindow = maxResultWindow;
        this.rrfStableDepth = rrfStableDepth || DEFAULT_STABLE_DEPTH;
        this.logger = logger;
    }

    /** Without pagination_depth, a `hybrid` query silently returns far fewer than `size` hits
     *  once the true match count is large, regardless of the requested size. */
    _withPaginationDepth(body) {
        return withPaginationDepth(body, {
            maxResultWindow: this.maxResultWindow,
            stableDepth: this.rrfStableDepth
        });
    }

    async bm25PreCheck(query, search_in = null, refineChain = [], refineFilterClauses = null) {
        const chain = normalizeChain(refineChain);

        let preCheckClause;
        if (search_in && search_in.length > 0) {
            preCheckClause = this.queryBuilder.buildConstrainedSearchInClause(query, search_in, { fuzziness: 'AUTO' });
        } else {
            preCheckClause = this.queryBuilder.buildAdmissionPreCheckClause(query);
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
        const runAnchorQuery = async (allowKnnRecall) => {
            const embedding = await this.embeddingService.embedQuery(term);
            const osQuery = this.queryBuilder.buildNormalizedHybridQuery(
                term, embedding, filters, 1, cap, searchInNorm,
                { refineChain: [], allowKnnRecall }
            );
            osQuery.size = cap;
            osQuery.from = 0;
            osQuery._source = ['mongo_id'];
            delete osQuery.aggs;
            return this.opensearch.search({ index: this.indexName, body: this._withPaginationDepth(osQuery), search_pipeline: this.rrfPipeline });
        };
        try {
            const bm25HitCount = await this.bm25PreCheck(term, searchInNorm, []);
            let resp = await runAnchorQuery(false);
            if (resp.body.hits.hits.length === 0) resp = await runAnchorQuery(true);
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
