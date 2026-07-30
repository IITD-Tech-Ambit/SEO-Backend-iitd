import crypto from 'crypto';
import { normalizeChain } from './QueryBuilder.js';

function escapeRegexForMongo(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Inventor-scoped search: rank one IITD faculty inventor's patents for a query (Explore
 * sidebar drill-down). Mirrors src/services/search/AuthorScopedSearch.js, but identity is
 * simpler here — IP inventors carry kerberos directly (no scopus_id merge needed), and
 * QueryBuilder/FilterBuilder already scope + exclude the kNN arm via `filters.kerberos`
 * (see QueryBuilder.buildNormalizedHybridQuery), so this class only needs to resolve
 * identity and thread `filters.kerberos` through the shared query builders.
 */
export default class InventorScopedSearch {
    constructor({ opensearch, indexName, mongoose, redis, redisTTL, logger, queryBuilder, filterBuilder, embeddingService, hydrator, rrfPipeline, maxResultWindow, candidateK }) {
        this.opensearch = opensearch;
        this.indexName = indexName;
        this.mongoose = mongoose;
        this.redis = redis;
        this.redisTTL = redisTTL;
        this.logger = logger;
        this.queryBuilder = queryBuilder;
        this.filterBuilder = filterBuilder;
        this.embeddingService = embeddingService;
        this.hydrator = hydrator;
        this.rrfPipeline = rrfPipeline || 'rrf-hybrid';
        this.maxResultWindow = maxResultWindow || 10000;
        this.candidateK = candidateK || 50;
    }

    /**
     * OpenSearch's native `hybrid` query rejects any request whose from+size exceeds a default
     * internal depth ("pagination_depth param is missing" / "Reached end of search result,
     * increase pagination_depth"). Mirrors SearchService._withPaginationDepth / IpSearchService's
     * copy — this class builds hybrid queries and calls OpenSearch directly, bypassing
     * IpSearchService entirely, so it needs its own copy of the same fix. No-op on non-hybrid bodies.
     */
    _withPaginationDepth(body) {
        if (!body?.query?.hybrid) return body;
        const depth = Math.min(Math.max((body.from || 0) + (body.size || 0), this.candidateK), this.maxResultWindow);
        return { ...body, query: { ...body.query, hybrid: { ...body.query.hybrid, pagination_depth: depth } } };
    }

    /**
     * Re-runs a prior refine-chain term as its own real hybrid search (not a literal-AND
     * filter) and narrows to the doc ids it actually matched, scoped to this inventor —
     * otherwise a broad/common anchor phrase competes against the ENTIRE corpus for a spot
     * in the top-`cap` results, and this inventor's real (but comparatively niche) matches
     * can rank outside that cutoff. Mirrors AuthorScopedSearch._buildRefineAnchorIdFilter.
     */
    async _buildRefineAnchorIdFilter(term, searchInNorm, scopeFilters) {
        const cap = Math.min(this.maxResultWindow, 2000);
        try {
            const embedding = await this.embeddingService.embedQuery(term);
            const osQuery = this.queryBuilder.buildNormalizedHybridQuery(
                term, embedding, scopeFilters, 1, cap, searchInNorm, { refineChain: [] }
            );
            osQuery.size = cap;
            osQuery.from = 0;
            osQuery._source = ['mongo_id'];
            delete osQuery.aggs;

            const resp = await this.opensearch.search({ index: this.indexName, body: this._withPaginationDepth(osQuery), search_pipeline: this.rrfPipeline });
            const ids = resp.body.hits.hits.map((hit) => hit._source.mongo_id).filter(Boolean);
            return ids.length > 0 ? { terms: { mongo_id: ids } } : { match_none: {} };
        } catch (err) {
            this.logger.warn({ err: err?.message, term }, 'Inventor-scoped refine anchor lookup failed; falling back to literal narrowing');
            return this.queryBuilder.buildLiteralPrimaryClause(term, searchInNorm);
        }
    }

    async search({ query, inventor_id, page = 1, per_page = 20, mode = 'advanced', refine_within = null, refine_chain = null, search_in = null, filters = null }) {
        const searchInNorm = this.filterBuilder.normalizeSearchIn(search_in);
        const refineChain = normalizeChain((Array.isArray(refine_chain) && refine_chain.length > 0) ? refine_chain : refine_within);

        // Same facet filters as the patents list / People sidebar so this inventor's opened
        // patent count matches the per-inventor count shown in the sidebar.
        const effFilters = filters ? { ...filters } : {};
        delete effFilters.kerberos;

        const queryHash = crypto.createHash('sha256')
            .update(JSON.stringify({ query, inventor_id, page, per_page, mode, refine_chain: refineChain, search_in: searchInNorm, filters: effFilters }))
            .digest('hex').slice(0, 16);
        const cacheKey = `inventor_scope:${queryHash}`;

        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                this.logger.info({ cacheKey, inventor_id, query, mode }, 'Inventor-scoped search cache HIT');
                return { ...JSON.parse(cached), cacheHit: true };
            }
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed for inventor-scoped search');
        }

        // Resolve inventor identity: `inventor_id` may be a Faculty expert_id (People sidebar
        // click, matching the papers-side author_id convention) OR a kerberos (Explore inventor
        // suggestions carry kerberos, not expert_id — see SuggestIPInventor). Raw id is the last
        // resort fallback when neither resolves, same dual-identity pattern as AuthorScopedSearch.
        let inventorName, totalInventorPatents, kerberosId;
        try {
            const Faculty = this.mongoose.model('Faculty');
            const idStr = String(inventor_id).trim();
            const facultyMatch = await Faculty.findOne({
                $or: [
                    { expert_id: idStr },
                    { email: new RegExp(`^${escapeRegexForMongo(idStr)}@`, 'i') }
                ]
            }).lean();

            kerberosId = facultyMatch?.email
                ? facultyMatch.email.split('@')[0].toLowerCase()
                : idStr.toLowerCase();

            const inventorFilter = { nested: { path: 'inventors', query: { term: { 'inventors.kerberos': kerberosId } } } };

            const countResult = await this.opensearch.search({
                index: this.indexName,
                body: { size: 0, query: inventorFilter, track_total_hits: true }
            });
            totalInventorPatents = countResult.body.hits.total.value;

            this.logger.info({
                inventor_id,
                kerberosId,
                totalPatents: totalInventorPatents,
                resolvedViaFaculty: !!facultyMatch
            }, 'Inventor-scoped search: resolved inventor identity');

            if (totalInventorPatents === 0) {
                return {
                    results: [],
                    inventor: { inventor_id, name: 'Unknown', total_patents: 0 },
                    pagination: { page, per_page, total: 0, total_pages: 0 },
                    cacheHit: false
                };
            }

            if (facultyMatch) {
                inventorName = `${facultyMatch.firstName} ${facultyMatch.lastName}`.trim();
            } else {
                const IPMetaData = this.mongoose.model('IPMetaData');
                const inventorDoc = await IPMetaData.findOne(
                    { 'inventors.kerberos': kerberosId },
                    { 'inventors.$': 1 }
                ).lean();
                inventorName = inventorDoc?.inventors?.[0]?.name || 'Unknown';
            }
        } catch (err) {
            this.logger.error({ err, inventor_id }, 'Inventor-scoped search: inventor identity resolution FAILED');
            throw err;
        }

        // `filters.kerberos` is what FilterBuilder.buildFilters turns into the nested inventor
        // filter, AND what QueryBuilder.buildNormalizedHybridQuery uses to exclude the kNN arm
        // (small single-inventor candidate pools make embedding similarity too flat to trust) —
        // no separate authorFilter plumbing needed, unlike papers (no scopus_id concept here).
        const scopeFilters = { ...effFilters, kerberos: kerberosId };

        let hits, total;
        try {
            const isBasic = mode === 'basic';
            let osQuery;

            if (isBasic) {
                const base = this.queryBuilder.buildBasicQuery(query, scopeFilters, page, per_page, 'relevance', searchInNorm, refineChain);
                delete base.aggs;
                osQuery = base;
            } else {
                const embedding = await this.embeddingService.embedQuery(query);

                // Prior refinement terms narrow to what each anchor step actually matched
                // (id-membership, not literal-AND), scoped to this inventor.
                const refineFilters = refineChain.length > 0
                    ? await Promise.all(refineChain.map((term) => this._buildRefineAnchorIdFilter(term, searchInNorm, scopeFilters)))
                    : [];

                // BM25 is the only recall arm within an inventor's own scope, unconditionally (kNN
                // excluded — see buildNormalizedHybridQuery: a small single-inventor candidate pool
                // makes embedding similarity too flat to trust as an admission signal on its own).
                //
                // Pass our own already-computed (id-membership) refine filters through so
                // buildNormalizedHybridQuery doesn't fall back to its internal literal-AND
                // computation into the SAME filter array (see AuthorScopedSearch for why that
                // would silently veto everything).
                const base = this.queryBuilder.buildNormalizedHybridQuery(
                    query, embedding, scopeFilters, page, per_page, searchInNorm,
                    { refineChain, refineFilterClauses: refineFilters }
                );

                delete base.aggs;
                osQuery = base;
            }

            osQuery = this._withPaginationDepth(osQuery);

            this.logger.info({
                inventor_id,
                query,
                totalInventorPatents,
                mode: isBasic ? 'basic' : 'advanced',
                refine_chain: refineChain.length,
                search_in: searchInNorm
            }, 'Inventor-scoped search: querying OpenSearch');

            const osResponse = await this.opensearch.search({
                index: this.indexName,
                body: osQuery,
                ...(osQuery.query?.hybrid ? { search_pipeline: this.rrfPipeline } : {})
            });
            hits = osResponse.body.hits.hits;
            total = osResponse.body.hits.total.value;

            this.logger.info({ hitsCount: hits.length, total }, 'Inventor-scoped search: OpenSearch results');
        } catch (err) {
            this.logger.error({ err, inventor_id, query }, 'Inventor-scoped search: OpenSearch query FAILED');
            throw err;
        }

        let scoredResults;
        try {
            const results = await this.hydrator.hydrateFromMongoDB(hits);
            const scoreMap = new Map(hits.map(h => [h._source.mongo_id, h._score]));
            scoredResults = results.map(r => ({ ...r, similarity_score: scoreMap.get(r._id.toString()) }));
            await this.hydrator.applyFacultyDisplayNames(scoredResults);
        } catch (err) {
            this.logger.error({ err, inventor_id }, 'Inventor-scoped search: hydration FAILED');
            throw err;
        }

        const response = {
            results: scoredResults,
            inventor: { name: inventorName, inventor_id, total_patents: totalInventorPatents },
            pagination: { page, per_page, total, total_pages: Math.ceil(total / per_page) }
        };

        try {
            await this.redis.setex(cacheKey, this.redisTTL.authorScopedSearchResults ?? this.redisTTL.searchResults, JSON.stringify(response));
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache write failed for inventor-scoped search');
        }

        this.logger.info({
            inventor_id,
            inventorName,
            query,
            totalPatents: totalInventorPatents,
            matchedResults: total
        }, 'Inventor-scoped search complete');

        return { ...response, cacheHit: false };
    }
}
