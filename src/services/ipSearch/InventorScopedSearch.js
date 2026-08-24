import crypto from 'crypto';
import { normalizeChain } from './QueryBuilder.js';
import { withPaginationDepth, DEFAULT_STABLE_DEPTH } from '../search/paginationDepth.js';
import { isPastEndOfResults } from '../search/hybridErrors.js';

function escapeRegexForMongo(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const INVENTOR_SCOPED_KNN_K = 5;
const MIN_USEFUL_LEXICAL_HITS = 2;

export default class InventorScopedSearch {
    constructor({ opensearch, indexName, mongoose, redis, redisTTL, logger, queryBuilder, filterBuilder, embeddingService, hydrator, rrfPipeline, maxResultWindow, candidateK, rrfStableDepth }) {
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
        this.rrfStableDepth = rrfStableDepth || DEFAULT_STABLE_DEPTH;
    }

    /**
     * OpenSearch's native `hybrid` query rejects any request whose from+size exceeds a default
     * internal depth ("pagination_depth param is missing" / "Reached end of search result,
     * increase pagination_depth"). This class builds hybrid queries and calls OpenSearch
     * directly, bypassing IpSearchService, so it applies the shared depth policy itself.
     */
    _withPaginationDepth(body) {
        return withPaginationDepth(body, {
            candidateK: this.candidateK,
            maxResultWindow: this.maxResultWindow,
            stableDepth: this.rrfStableDepth
        });
    }

    /**
     * Loose "does this term occur at all within this inventor's patents" probe: an OR over the
     * topical fields, deliberately weaker than the search's own AND-of-all-terms conjunction so
     * it measures vocabulary presence rather than whether the full query matches. Used to tell a
     * term that is merely a conjunction/vocabulary miss apart from one that is simply absent.
     *
     * Both callers here are precision guards on a kNN step, because kNN returns this inventor's
     * nearest neighbours for ANY vector: ungated, the refine anchor below invents a membership
     * set for a term the inventor never used, and the semantic widening in search() answers
     * "qwxzjkvbnm" with a page of their power-electronics patents. Requiring the text to be
     * lexically grounded in this inventor's own corpus first is what keeps both at zero — the
     * same reason IpSearchService gates its hybrid kNN arm behind a BM25 pre-check rather than
     * letting the ANN arm admit on its own.
     */
    async _countInventorLexicalGrounding(query, searchInNorm, scopeFilters) {
        const fields = this.filterBuilder.getHybridSearchFields(searchInNorm);
        if (!fields.length) return 0;
        const resp = await this.opensearch.search({
            index: this.indexName,
            body: {
                size: 0,
                track_total_hits: true,
                query: {
                    bool: {
                        must: [{ multi_match: { query, fields, type: 'cross_fields', minimum_should_match: '1' } }],
                        filter: this.filterBuilder.buildFilters(scopeFilters)
                    }
                }
            }
        });
        return resp.body.hits.total.value;
    }

    /**
     * Bounded kNN recall arm, shaped exactly like buildNormalizedHybridQuery's own kNN arm so RRF
     * fuses the two identically: scope filters (here the `kerberos` nested clause, which is how
     * this class scopes everything) INSIDE the knn filter, so this inventor's patents compete
     * only against each other rather than for a slot in a corpus-wide top-k they would never
     * reach; facet filters as a SIBLING bool.filter, so a selected facet cannot re-target the ANN
     * search at a different, larger set than the facet counted (see FilterBuilder.buildScopeFilters).
     */
    _buildSemanticRecallArm(embedding, bm25Arm, searchInNorm, scopeFilters) {
        const knnScopeClauses = this.filterBuilder.buildScopeFilters(scopeFilters);
        // search_in asserts the term actually OCCURS in the selected field, so gate the ANN arm on
        // the lexical arm's own admission clause: kNN may then reorder in-scope patents but can
        // never admit an off-scope one on overall topical similarity alone.
        if (searchInNorm?.length > 0 && bm25Arm?.bool?.must?.[0]) knnScopeClauses.push(bm25Arm.bool.must[0]);
        return {
            bool: {
                must: [{
                    knn: {
                        embedding: {
                            vector: embedding,
                            k: INVENTOR_SCOPED_KNN_K,
                            ...(knnScopeClauses.length > 0 ? { filter: { bool: { filter: knnScopeClauses } } } : {})
                        }
                    }
                }],
                filter: [...(bm25Arm?.bool?.filter || [])]
            }
        };
    }

    /**
     * Re-runs a prior refine-chain term as its own real hybrid search (not a literal-AND
     * filter) and narrows to the doc ids it actually matched, scoped to this inventor —
     * otherwise a broad/common anchor phrase competes against the ENTIRE corpus for a spot
     * in the top-`cap` results, and this inventor's real (but comparatively niche) matches
     * can rank outside that cutoff. Mirrors AuthorScopedSearch._buildRefineAnchorIdFilter.
     *
     * Tries BM25-only first; only falls back to a kNN-inclusive rerun if that finds nothing.
     * kNN's `k` is sized for corpus-wide recall, but here it's scoped to just one inventor's
     * own patents — an inventor with fewer total patents than k makes kNN structurally unable
     * to discriminate (querying for the "top k nearest neighbors" within a pool smaller than k
     * just returns the whole pool), so admitting via kNN whenever BM25 already found real
     * matches would silently widen a supposedly-narrowing anchor to this inventor's entire
     * portfolio. kNN is only trustworthy here as a fallback for the case it was added for: a
     * term that's genuinely absent from this inventor's other patents, where BM25 alone would
     * wrongly collapse the anchor to match_none.
     */
    async _buildRefineAnchorIdFilter(term, searchInNorm, scopeFilters) {
        const cap = Math.min(this.maxResultWindow, 2000);
        const runAnchorQuery = async (allowKnnRecall) => {
            const embedding = await this.embeddingService.embedQuery(term);
            const osQuery = this.queryBuilder.buildNormalizedHybridQuery(
                term, embedding, scopeFilters, 1, cap, searchInNorm, { refineChain: [], allowKnnRecall }
            );
            osQuery.size = cap;
            osQuery.from = 0;
            osQuery._source = ['mongo_id'];
            delete osQuery.aggs;
            const resp = await this.opensearch.search({ index: this.indexName, body: this._withPaginationDepth(osQuery), search_pipeline: this.rrfPipeline });
            return resp.body.hits.hits.map((hit) => hit._source.mongo_id).filter(Boolean);
        };
        try {
            // An anchor term with no lexical presence in THIS inventor's patents has no members
            // to narrow within, and must not be able to acquire any: the kNN fallback above
            // returns nearest neighbours for ANY vector, so widening on a term that matches
            // nothing invents a membership set from scratch and the "refinement" broadens
            // instead of narrowing (the paper stack's twin returned 152 of an author's papers
            // when refining "energy" by a gibberish term).
            //
            // Skipped for an inventor-only search_in, where there are no topical fields to probe
            // and the grounding count would be a meaningless zero.
            if (this.filterBuilder.getHybridSearchFields(searchInNorm).length > 0) {
                const grounding = await this._countInventorLexicalGrounding(term, searchInNorm, scopeFilters);
                if (grounding === 0) return { match_none: {} };
            }

            let ids = await runAnchorQuery(false);
            if (ids.length === 0) ids = await runAnchorQuery(true);
            // Ids OR the term's own lexical clause: `cap` truncates a broad anchor, and filtering
            // on the truncated slice alone drops patents basic mode keeps.
            return this.queryBuilder.buildRefineAnchorFilter(term, ids, searchInNorm);
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
            // Set only for advanced mode: rebuilds the hybrid body, optionally with the
            // semantic-recall arm appended. Kept as a closure so the widening retry below reuses
            // the exact same construction (and the same already-computed embedding and refine
            // filters); left null everywhere widening must not apply.
            let buildAdvancedQuery = null;

            if (!query || !query.trim()) {
                // Filter-only browse (e.g. a department chip click) — mirrors
                // IpSearchService._runBrowseSearch. buildBasicQuery has no empty-query handling
                // of its own (its primary clause always requires the query text to match
                // something), so an empty string silently matched nothing instead of running an
                // unfiltered browse of this inventor's patents.
                osQuery = this.queryBuilder.buildBrowseQuery(scopeFilters, page, per_page, 'relevance');
                delete osQuery.aggs;
            } else if (isBasic) {
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

                // On a fresh (chain-less) query BM25 is the only recall arm buildNormalizedHybridQuery
                // builds within an inventor's own scope — a small single-inventor candidate pool
                // makes embedding similarity too flat to trust as an admission signal on its own.
                // That is the right default, but it leaves the lexical conjunction as the sole
                // gate, which `semanticRecall` widens below when it produces a dead end.
                //
                // Pass our own already-computed (id-membership) refine filters through so
                // buildNormalizedHybridQuery doesn't fall back to its internal literal-AND
                // computation into the SAME filter array (see AuthorScopedSearch for why that
                // would silently veto everything).
                // Once a refine chain is active, kNN gets admitted (see excludeKnn in
                // buildNormalizedHybridQuery) — but this pool is already scoped to just this
                // inventor's own patents, so a small knnK keeps it rank- rather than
                // admit-everyone (see that function for the measured score-distribution rationale).
                buildAdvancedQuery = ({ semanticRecall = false } = {}) => {
                    const base = this.queryBuilder.buildNormalizedHybridQuery(
                        query, embedding, scopeFilters, page, per_page, searchInNorm,
                        { refineChain, refineFilterClauses: refineFilters, knnK: INVENTOR_SCOPED_KNN_K }
                    );

                    // Only ever ADDS an arm, never replaces one: the lexical arm keeps ranking
                    // exactly as before and RRF fuses the semantic arm alongside it, so widening
                    // can add matches but cannot demote or evict a real lexical match. A body that
                    // already has two arms is a refine-chain query, where buildNormalizedHybridQuery
                    // admitted kNN itself — nothing to widen.
                    const arms = base.query?.hybrid?.queries;
                    if (semanticRecall && arms?.length === 1) {
                        arms.push(this._buildSemanticRecallArm(embedding, arms[0], searchInNorm, scopeFilters));
                    }

                    delete base.aggs;
                    return base;
                };

                osQuery = buildAdvancedQuery();
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

            const runQuery = async (body) => {
                const searchArgs = {
                    index: this.indexName,
                    body,
                    ...(body.query?.hybrid ? { search_pipeline: this.rrfPipeline } : {})
                };
                try {
                    return await this.opensearch.search(searchArgs);
                } catch (err) {
                    if (!isPastEndOfResults(err)) throw err;
                    // A page past the last result is a normal request, not a failure: report the true
                    // total (so total_pages stays honest) with no rows rather than surfacing a 502.
                    this.logger.info({ inventor_id, query, page }, 'Inventor-scoped search: page is past the end of the result set; serving an empty page');
                    return this.opensearch.search({ ...searchArgs, body: { ...body, from: 0, size: 0, _source: false } });
                }
            };

            let osResponse = await runQuery(osQuery);
            hits = osResponse.body.hits.hits;
            total = osResponse.body.hits.total.value;

            // Widen only when lexical recall collapsed and the query has vocabulary in this inventor's patents.
            if (buildAdvancedQuery && total < MIN_USEFUL_LEXICAL_HITS && osQuery.query?.hybrid?.queries?.length === 1) {
                const groundedCount = await this._countInventorLexicalGrounding(query, searchInNorm, scopeFilters);
                this.logger.info({ inventor_id, query, total, groundedCount }, 'Inventor-scoped search: lexical recall is degenerate; probing semantic widening');
                if (groundedCount > 0) {
                    osQuery = this._withPaginationDepth(buildAdvancedQuery({ semanticRecall: true }));
                    osResponse = await runQuery(osQuery);
                    hits = osResponse.body.hits.hits;
                    total = osResponse.body.hits.total.value;
                    this.logger.info({ inventor_id, query, total, k: INVENTOR_SCOPED_KNN_K }, 'Inventor-scoped search: widened with the semantic-recall arm');
                }
            }

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
            await this.redis.setex(cacheKey, this.redisTTL.inventorScopedSearchResults ?? this.redisTTL.searchResults, JSON.stringify(response));
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
