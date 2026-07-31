import crypto from 'crypto';
import { normalizeChain } from './QueryBuilder.js';
import { resolveFacultyByAuthorId } from '../../utils/facultyIdentity.js';

/**
 * Author-scoped search: rank one author's papers for a query (Explore sidebar drill-down).
 *
 * Resolves author identity (Faculty expert_id/scopus_id, else raw id) with the SAME
 * dual-identity methodology as the People sidebar, queries via shared builders plus an
 * author filter (basic: strict BM25; advanced: normalized hybrid), then hydrates from
 * MongoDB in hit order and attaches similarity scores.
 */
export default class AuthorScopedSearch {
    constructor({ opensearch, indexName, mongoose, redis, redisTTL, logger, queryBuilder, filterBuilder, rosterService, embeddingService, hydrator, rrfPipeline, maxResultWindow, candidateK }) {
        this.opensearch = opensearch;
        this.indexName = indexName;
        this.mongoose = mongoose;
        this.redis = redis;
        this.redisTTL = redisTTL;
        this.logger = logger;
        this.queryBuilder = queryBuilder;
        this.filterBuilder = filterBuilder;
        this.rosterService = rosterService;
        this.embeddingService = embeddingService;
        this.hydrator = hydrator;
        this.rrfPipeline = rrfPipeline || 'rrf-hybrid';
        this.maxResultWindow = maxResultWindow || 10000;
        this.candidateK = candidateK || 50;
    }

    /**
     * OpenSearch's native `hybrid` query rejects any request whose from+size exceeds a default
     * internal depth ("pagination_depth param is missing" / "Reached end of search result,
     * increase pagination_depth"). Mirrors SearchService._withPaginationDepth — this class
     * builds hybrid queries and calls OpenSearch directly, bypassing SearchService entirely, so
     * it needs its own copy of the same fix. No-op on non-hybrid bodies.
     */
    _withPaginationDepth(body) {
        if (!body?.query?.hybrid) return body;
        const depth = Math.min(Math.max((body.from || 0) + (body.size || 0), this.candidateK), this.maxResultWindow);
        return { ...body, query: { ...body.query, hybrid: { ...body.query.hybrid, pagination_depth: depth } } };
    }

    /**
     * Re-runs a prior refine-chain term as its own real hybrid search (not a literal-AND
     * filter) and narrows to the doc ids it actually matched. A literal-AND filter requires
     * every refine term to appear verbatim in the doc — but the anchor step itself may have
     * recalled a doc only semantically (kNN), so literal-AND can wrongly evict real matches
     * and, for a rare/garbled phrase, can zero out the whole narrowed set even when the
     * newest query has plenty of real matches on its own. Mirrors SearchService's
     * _buildRefineAnchorIdFilter so both search paths narrow the same way.
     */
    async _buildRefineAnchorIdFilter(term, searchInNorm, authorFilter) {
        const cap = Math.min(this.maxResultWindow, 2000);
        const runAnchorQuery = async (restrictKnn) => {
            const embedding = await this.embeddingService.embedQuery(term);
            const osQuery = this.queryBuilder.buildNormalizedHybridQuery(
                term, embedding, {}, 1, cap, searchInNorm, null, false, null, null, { refineChain: [], restrictKnn }
            );
            osQuery.size = cap;
            osQuery.from = 0;
            osQuery._source = ['mongo_id'];
            delete osQuery.aggs;

            // Scope the anchor's own recall to this author too — otherwise a broad/common anchor
            // phrase competes against the ENTIRE corpus for a spot in the top `cap` results, and
            // this author's real (but comparatively niche) matches can rank outside that cutoff
            // even though they'd be the obvious top matches within just their own papers.
            //
            // The kNN arm's filter lives nested inside must[0].knn.embedding.filter.bool.filter
            // (efficient k-NN filtering — see buildNormalizedHybridQuery), not as a sibling
            // bool.filter array like the BM25 arm — a plain `arm.bool.filter.push` silently
            // skips it, leaving kNN recall (when included) unscoped across the WHOLE corpus
            // instead of just this author's papers.
            if (authorFilter) {
                for (const arm of osQuery.query?.hybrid?.queries || []) {
                    if (Array.isArray(arm.bool?.filter)) {
                        arm.bool.filter.push(authorFilter);
                        continue;
                    }
                    const knnClause = arm.bool?.must?.[0]?.knn?.embedding;
                    if (knnClause) {
                        if (!knnClause.filter) knnClause.filter = { bool: { filter: [] } };
                        knnClause.filter.bool.filter.push(authorFilter);
                    }
                }
            }

            return this.opensearch.search({ index: this.indexName, body: this._withPaginationDepth(osQuery), search_pipeline: this.rrfPipeline });
        };
        try {
            // BM25-only first; only widen via kNN if that finds nothing. kNN's k is sized for
            // corpus-wide recall, but here it's scoped to just this one author's own papers — an
            // author with fewer total (filter-matching) papers than k makes kNN structurally
            // unable to discriminate: "top k nearest neighbors within a pool smaller than k" is
            // just the whole pool, so admitting via kNN whenever BM25 already found real matches
            // would silently widen a supposedly-narrowing anchor to nearly this author's entire
            // history (measured on the IP search's InventorScopedSearch twin: an inventor's
            // 88-patent portfolio, entirely unfiltered, for a refine term real BM25 matched only
            // 15 of).
            let resp = await runAnchorQuery(true);
            if (resp.body.hits.hits.length === 0) resp = await runAnchorQuery(false);
            const ids = resp.body.hits.hits.map((hit) => hit._source.mongo_id).filter(Boolean);
            return ids.length > 0 ? { terms: { mongo_id: ids } } : { match_none: {} };
        } catch (err) {
            this.logger.warn({ err: err?.message, term }, 'Author-scoped refine anchor lookup failed; falling back to literal narrowing');
            return this.queryBuilder.buildLiteralPrimaryClause(term, searchInNorm);
        }
    }

    async search({ query, author_id, page = 1, per_page = 20, mode = 'advanced', refine_within = null, refine_chain = null, search_in = null, filters = null }) {
        const searchInNorm = this.filterBuilder.normalizeSearchIn(search_in);
        const refineChain = normalizeChain((Array.isArray(refine_chain) && refine_chain.length > 0) ? refine_chain : refine_within);
        await this.rosterService.getAll();

        // Apply the SAME facet filters as the papers list / People sidebar so this faculty's
        // opened paper count matches the per-faculty count shown in the sidebar, and pre-resolve
        // kerberos for an author_id filter so the author union clause matches across endpoints.
        const effFilters = filters ? { ...filters } : {};
        if (effFilters.author_id && !effFilters._authorKerberos) {
            try {
                const Faculty = this.mongoose.model('Faculty');
                const { kerberos } = await resolveFacultyByAuthorId(Faculty, effFilters.author_id);
                if (kerberos) effFilters._authorKerberos = kerberos;
            } catch (err) {
                this.logger.warn({ err: err?.message }, 'Author-scoped: failed to resolve kerberos for author_id filter');
            }
        }

        const queryHash = crypto.createHash('sha256')
            .update(JSON.stringify({ query, author_id, page, per_page, mode, refine_chain: refineChain, search_in: searchInNorm, filters: effFilters }))
            .digest('hex').slice(0, 16);
        const cacheKey = `author_scope:${queryHash}`;

        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                this.logger.info({ cacheKey, author_id, query, mode }, 'Author-scoped search cache HIT');
                return { ...JSON.parse(cached), cacheHit: true };
            }
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed for author-scoped search');
        }

        // Resolve author identity and build the OpenSearch-native author filter.
        let authorName, totalAuthorPapers, authorFilter;
        try {
            const Faculty = this.mongoose.model('Faculty');
            const facultyMatch = await Faculty.findOne({
                $or: [{ expert_id: author_id }, { scopus_id: author_id }]
            }).lean();

            const scopusAuthorIds = facultyMatch?.scopus_id?.length
                ? facultyMatch.scopus_id.map(String)
                : [author_id];

            const kerberosId = facultyMatch?.email ? facultyMatch.email.split('@')[0].toLowerCase() : null;

            const authorShouldClauses = [
                { nested: { path: 'authors', query: { terms: { 'authors.author_id': scopusAuthorIds } } } }
            ];
            if (kerberosId) authorShouldClauses.push({ term: { kerberos: kerberosId } });
            authorFilter = { bool: { should: authorShouldClauses, minimum_should_match: 1 } };

            const countResult = await this.opensearch.search({
                index: this.indexName,
                body: { size: 0, query: authorFilter, track_total_hits: true }
            });
            totalAuthorPapers = countResult.body.hits.total.value;

            this.logger.info({
                author_id,
                totalPapers: totalAuthorPapers,
                scopusIds: scopusAuthorIds.length,
                hasKerberos: !!kerberosId
            }, 'Author-scoped search: resolved author identity');

            if (totalAuthorPapers === 0) {
                return {
                    results: [],
                    author: { author_id, name: 'Unknown', total_papers: 0 },
                    pagination: { page, per_page, total: 0, total_pages: 0 },
                    cacheHit: false
                };
            }

            if (facultyMatch) {
                authorName = `${facultyMatch.firstName} ${facultyMatch.lastName}`.trim();
            } else {
                const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');
                const authorNameDoc = await ResearchDocument.findOne(
                    { 'authors.author_id': author_id },
                    { 'authors.$': 1 }
                ).lean();
                authorName = authorNameDoc?.authors?.[0]?.author_name || 'Unknown';
            }
        } catch (err) {
            this.logger.error({ err, author_id }, 'Author-scoped search: author identity resolution FAILED');
            throw err;
        }

        let facultyAuthorIds = null;
        let facultyKerberosIds = null;
        let authorRefineNarrow = false;
        if (searchInNorm?.length === 1 && searchInNorm[0] === 'author') {
            if (refineChain.length >= 1) {
                const resolved = await this.rosterService.resolveScopusIdsForAuthorQuery(refineChain[0]);
                facultyAuthorIds = resolved.scopusIds;
                facultyKerberosIds = resolved.kerberosIds;
                authorRefineNarrow = true;
            } else {
                const resolved = await this.rosterService.resolveScopusIdsForAuthorQuery(query);
                facultyAuthorIds = resolved.scopusIds;
                facultyKerberosIds = resolved.kerberosIds;
            }
        }
        const refineAnchor = authorRefineNarrow ? refineChain[0] : null;

        let hits, total;
        try {
            const isBasic = mode === 'basic';
            let osQuery;

            if (isBasic) {
                // `authorScoped: true` skips the IITD roster gate on author-name matching:
                // the anchor authorFilter already restricts results to one faculty's papers,
                // so a free-text query may match non-IITD co-authors within that corpus.
                const base = this.queryBuilder.buildBasicQuery(
                    query, effFilters, page, per_page, 'relevance',
                    searchInNorm, refineChain,
                    facultyAuthorIds, authorRefineNarrow, facultyKerberosIds,
                    { authorScoped: true }
                );
                const filterClauses = base.query.bool.filter || [];
                filterClauses.push(authorFilter);
                base.query.bool.filter = filterClauses;
                delete base.aggs;
                osQuery = base;
            } else {
                const embedding = await this.embeddingService.embedQuery(query);

                // Prior refinement terms narrow the result set to what each anchor step actually
                // matched (id-membership, not literal-AND — see _buildRefineAnchorIdFilter),
                // scoped to this author so a broad anchor phrase doesn't have to compete against
                // the whole corpus for a spot in the anchor's own candidate cap.
                const refineFilters = (refineChain.length > 0 && !authorRefineNarrow)
                    ? await Promise.all(refineChain.map((term) => this._buildRefineAnchorIdFilter(term, searchInNorm, authorFilter)))
                    : [];

                // BM25 is the only recall arm within an author's own scope, unconditionally (kNN
                // excluded — see buildNormalizedHybridQuery: a small single-author candidate pool
                // makes embedding similarity too flat to trust as an admission signal on its own).
                //
                // Pass our own already-computed (id-membership) refine filters through so
                // buildNormalizedHybridQuery doesn't fall back to its internal literal-AND
                // computation — that fallback would get pushed into the SAME filter array
                // alongside ours, and since every entry in a filter array is required, its
                // near-impossible-to-satisfy literal-AND would silently veto everything even
                // when our id-membership filter alone correctly matches.
                const base = this.queryBuilder.buildNormalizedHybridQuery(
                    query, embedding, effFilters, page, per_page,
                    searchInNorm, facultyAuthorIds, authorRefineNarrow,
                    refineAnchor, facultyKerberosIds,
                    { authorScoped: true, refineChain, refineFilterClauses: refineFilters }
                );

                // Every hybrid arm carries its own filter array (see QueryBuilder.buildNormalizedHybridQuery) —
                // in practice they share the same array reference, but push into each distinct
                // array once (by identity) rather than assume that internal detail.
                const uniqueFilterArrays = [...new Set(
                    (base.query?.hybrid?.queries || [])
                        .map((arm) => arm.bool?.filter)
                        .filter(Array.isArray)
                )];
                for (const filterArr of uniqueFilterArrays) filterArr.push(authorFilter);

                delete base.aggs;
                osQuery = base;
            }

            osQuery = this._withPaginationDepth(osQuery);

            this.logger.info({
                author_id,
                query,
                totalAuthorPapers,
                mode: isBasic ? 'basic' : 'advanced',
                refine_chain: refineChain.length,
                search_in: searchInNorm
            }, 'Author-scoped search: querying OpenSearch');

            const osResponse = await this.opensearch.search({
                index: this.indexName,
                body: osQuery,
                ...(osQuery.query?.hybrid ? { search_pipeline: this.rrfPipeline } : {})
            });
            hits = osResponse.body.hits.hits;
            total = osResponse.body.hits.total.value;

            this.logger.info({ hitsCount: hits.length, total }, 'Author-scoped search: OpenSearch results');
        } catch (err) {
            this.logger.error({ err, author_id, query }, 'Author-scoped search: OpenSearch query FAILED');
            throw err;
        }

        // Hydrate from MongoDB and attach similarity scores.
        let scoredResults;
        try {
            const results = await this.hydrator.hydrateFromMongoDB(hits);
            const scoreMap = new Map(hits.map(h => [h._source.mongo_id, h._score]));
            scoredResults = results.map(r => ({ ...r, similarity_score: scoreMap.get(r._id.toString()) }));
            await this.hydrator.applyFacultyDisplayNames(scoredResults);
        } catch (err) {
            this.logger.error({ err, author_id }, 'Author-scoped search: hydration FAILED');
            throw err;
        }

        const response = {
            results: scoredResults,
            author: { name: authorName, author_id, total_papers: totalAuthorPapers },
            pagination: { page, per_page, total, total_pages: Math.ceil(total / per_page) }
        };

        try {
            await this.redis.setex(cacheKey, this.redisTTL.searchResults, JSON.stringify(response));
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache write failed for author-scoped search');
        }

        this.logger.info({
            author_id,
            authorName,
            query,
            totalPapers: totalAuthorPapers,
            matchedResults: total
        }, 'Author-scoped search complete');

        return { ...response, cacheHit: false };
    }
}
