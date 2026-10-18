import crypto from 'crypto';
import '../../models/departments.js'; // Ensure Department model is registered for populate

import { resolveFacultyByAuthorId } from '../../utils/facultyIdentity.js';
import { buildSearchConfig, TYPO_FUZZ, contentTerms } from './constants.js';
import FilterBuilder from './FilterBuilder.js';
import FacultyRosterService from './FacultyRosterService.js';
import QueryBuilder, { normalizeChain } from './QueryBuilder.js';
import ResultHydrator from './ResultHydrator.js';
import RerankService, { resolveRankedWindow } from './RerankService.js';
import SuggestionService from './SuggestionService.js';
import FacultyForQueryService from './FacultyForQueryService.js';
import AuthorScopedSearch from './AuthorScopedSearch.js';
import { withPaginationDepth, DEFAULT_STABLE_DEPTH } from './paginationDepth.js';
import { isPastEndOfResults } from './hybridErrors.js';


export default class SearchService {
    constructor({ opensearch, opensearchIndex, redis, redisTTL, mongoose, embeddingService, logger, config }) {
        this.opensearch = opensearch;
        this.indexName = opensearchIndex;
        this.redis = redis;
        this.redisTTL = redisTTL;
        this.mongoose = mongoose;
        this.embeddingService = embeddingService;
        this.config = config;
        this.logger = logger;

        this.searchConfig = buildSearchConfig(config);
        this.candidateK = config.search?.candidateK || 50;
        this.rerankEnabled = config.search?.rerankEnabled ?? true;
        this.maxResultWindow = config.search?.maxResultWindow || 10000;
        this.rrfStableDepth = config.search?.rrfStableDepth || DEFAULT_STABLE_DEPTH;
        this.rerankConfig = config.reranker || {};
        this.rrfPipeline = config.search?.rrfPipeline || 'rrf-hybrid';

        const deps = {
            opensearch: this.opensearch,
            indexName: this.indexName,
            mongoose: this.mongoose,
            redis: this.redis,
            redisTTL: this.redisTTL,
            logger: this.logger,
            searchConfig: this.searchConfig,
            embeddingService: this.embeddingService,
            rrfPipeline: this.rrfPipeline,
            maxResultWindow: this.maxResultWindow,
            rrfStableDepth: this.rrfStableDepth
        };

        this.filters = new FilterBuilder(this.searchConfig);
        this.roster = new FacultyRosterService({ ...deps, filterBuilder: this.filters });
        this.queryBuilder = new QueryBuilder({
            searchConfig: this.searchConfig,
            filterBuilder: this.filters,
            rosterService: this.roster
        });
        this.hydrator = new ResultHydrator({ mongoose: this.mongoose, logger: this.logger });
        this.reranker = new RerankService({ ...deps, rerankConfig: this.rerankConfig });
        this.suggestions = new SuggestionService(deps);
        this.facultyForQuery = new FacultyForQueryService({
            ...deps,
            queryBuilder: this.queryBuilder,
            filterBuilder: this.filters,
            rosterService: this.roster
        });
        this.authorScoped = new AuthorScopedSearch({
            ...deps,
            queryBuilder: this.queryBuilder,
            filterBuilder: this.filters,
            rosterService: this.roster,
            hydrator: this.hydrator,
            candidateK: this.candidateK
        });
    }

    _withPaginationDepth(body) {
        return withPaginationDepth(body, {
            candidateK: this.candidateK,
            maxResultWindow: this.maxResultWindow,
            stableDepth: this.rrfStableDepth
        });
    }

    /** Resolve Faculty.email kerberos for an author_id facet so the filter unions both identities. */
    async _resolveAuthorKerberos(filters) {
        if (!filters?.author_id || filters._authorKerberos) return;
        try {
            const Faculty = this.mongoose.model('Faculty');
            const { kerberos } = await resolveFacultyByAuthorId(Faculty, filters.author_id);
            if (kerberos) filters._authorKerberos = kerberos;
        } catch (err) {
            this.logger.warn({ err: err?.message }, 'Failed to resolve kerberos for author_id filter');
        }
    }

    /**
     * Execute search with caching.
     *
     * Basic: strict BM25 only (no fuzziness, no embeddings, no fuzzy fallback).
     * Advanced: BM25 (fuzziness AUTO) + hybrid kNN, gated by a BM25 pre-check, with a fuzzy
     *   fallback if the primary query returns nothing.
     */
    async search({ query, filters, sort = 'relevance', page = 1, per_page = 20, search_in = null, mode = 'advanced', refine_within = null, refine_chain = null, rerank = null }) {
        const searchInNorm = this.filters.normalizeSearchIn(search_in);
        // Multi-step refinement: each prior term narrows the corpus. chain[0] is the oldest.
        const refineChain = this._normalizeRefineChain(refine_chain, refine_within);
        // Warm the IITD roster before building queries; all author-name matching is gated to it.
        await this.roster.getAll();
        await this._resolveAuthorKerberos(filters);

        const cachePayload = JSON.stringify({
            query, filters, sort, page, per_page,
            search_in: searchInNorm, mode, refine_chain: refineChain,
            rerank: rerank === false ? false : null
        });
        const cacheKey = `search:${crypto.createHash('sha256').update(cachePayload).digest('hex').slice(0, 16)}`;

        this.logger.info({ cacheKey, query, filters, sort, search_in: searchInNorm, mode, refine_chain: refineChain }, 'Search request');

        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                this.logger.info({ cacheKey, query }, 'Search cache HIT');
                return { ...JSON.parse(cached), cacheHit: true };
            }
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed');
        }

        let facultyAuthorIds = null;
        let facultyKerberosIds = null;
        let authorRefineNarrow = false;
        if (searchInNorm?.length === 1 && searchInNorm[0] === 'author') {
            // Author-only: chain[0] is the person anchor; the rest (+ query) narrow by topic.
            if (refineChain.length >= 1) {
                const resolved = await this.roster.resolveScopusIdsForAuthorQuery(refineChain[0]);
                facultyAuthorIds = resolved.scopusIds;
                facultyKerberosIds = resolved.kerberosIds;
                authorRefineNarrow = true;
            } else {
                const resolved = await this.roster.resolveScopusIdsForAuthorQuery(query);
                facultyAuthorIds = resolved.scopusIds;
                facultyKerberosIds = resolved.kerberosIds;
            }
            this.logger.info(
                { anchorIds: facultyAuthorIds?.length, kerberosIds: facultyKerberosIds?.length, authorRefineNarrow },
                'Author-only: Faculty -> Scopus author ids + kerberos'
            );
        }

        if (mode === 'basic') {
            return this._runBasicSearch({
                query, filters, sort, page, per_page, searchInNorm, refineChain,
                facultyAuthorIds, authorRefineNarrow, facultyKerberosIds,
                cacheKey
            });
        }

        return this._runAdvancedSearch({
            query, filters, sort, page, per_page, searchInNorm, refineChain,
            facultyAuthorIds, authorRefineNarrow, facultyKerberosIds,
            cacheKey, rerank
        });
    }

    /**
     * Normalize the refinement chain, preferring the explicit `refine_chain` array and falling
     * back to the legacy single `refine_within` string. Returns ordered, trimmed, deduped terms.
     */
    _normalizeRefineChain(refine_chain, refine_within) {
        const source = (Array.isArray(refine_chain) && refine_chain.length > 0) ? refine_chain : refine_within;
        return normalizeChain(source);
    }

    async _runBasicSearch({ query, filters, sort, page, per_page, searchInNorm, refineChain = [], facultyAuthorIds, authorRefineNarrow, facultyKerberosIds, cacheKey }) {
        this.logger.info({ query, mode: 'basic' }, 'Running BASIC (BM25-only) search');

        const osQuery = this.queryBuilder.buildBasicQuery(
            query, filters, page, per_page, sort, searchInNorm, refineChain,
            facultyAuthorIds, authorRefineNarrow, facultyKerberosIds
        );

        const osResponse = await this.opensearch.search({ index: this.indexName, body: osQuery });
        const hits = osResponse.body.hits.hits;
        const total = osResponse.body.hits.total.value;

        // Basic mode: strict BM25 only — no fuzzy fallback.
        if (total === 0) {
            this.logger.info({ query, refine_chain: refineChain.length }, 'Basic search: no hits (strict match)');
            const suggestions = query.trim() ? await this.suggestions.getSuggestions(query) : [];
            return {
                results: [],
                related_faculty: [],
                suggestions,
                facets: {},
                pagination: { page, per_page, total: 0, total_pages: 0 },
                mode: 'basic',
                cacheHit: false
            };
        }

        const results = await this.hydrator.hydrateFromMongoDB(hits);
        await this.hydrator.applyFacultyDisplayNames(results);
        const related_faculty = await this.hydrator.extractRelatedFaculty(results);

        const suggestions = total < 3 ? await this.suggestions.getSuggestions(query) : [];

        const response = {
            results,
            related_faculty,
            suggestions,
            facets: this.hydrator.parseFacets(osResponse.body.aggregations),
            pagination: { page, per_page, total, total_pages: Math.ceil(total / per_page) },
            mode: 'basic'
        };

        await this._cacheResponse(cacheKey, response);
        return { ...response, cacheHit: false };
    }

    /**
     * True "search within previous results" narrowing: each refine-chain term is re-resolved to
     * its own actual min-score-gated advanced-search result ids (capped generously), and the
     * filter restricts subsequent narrowing to that real membership set. Each doc's own anchor
     * score is also captured (see _buildRefineAnchorIdFilter) so ranking can compound relevance
     * across the chain instead of discarding it once a doc passes the membership gate.
     * Author-narrow refinement (anchoring on a person, not free text) uses its own mechanism and
     * is untouched.
     *
     * A looser re-derived SEMANTIC clause is the wrong tool for the filter itself: a kNN clause in
     * filter context ignores min_score and always contributes up to k neighbors regardless of true
     * relevance, so it can make the "narrowed" count larger than the anchor's own result count —
     * the opposite of narrowing. Filtering on the anchor's real ids is what keeps every doc the
     * anchor step actually surfaced, including ones that only matched it semantically.
     *
     * The ids are capped, though, so they are a partial view of a broad anchor. The strict LEXICAL
     * clause is therefore OR'd back in (see QueryBuilder.buildRefineAnchorFilter) — it is bounded
     * by the term's real occurrences rather than by k, so unlike a kNN arm it cannot admit anything
     * the anchor step itself would not have matched.
     */
    async _buildAdvancedRefineAnchors(refineChain, searchInNorm, authorRefineNarrow, filters) {
        if (authorRefineNarrow || !refineChain.length) return null;
        return Promise.all(refineChain.map((term) => this._buildRefineAnchorIdFilter(term, searchInNorm, filters)));
    }

    /** Ids of documents `term` matches as its own advanced search, capped at maxResultWindow/2000. */
    async _buildRefineAnchorIdFilter(term, searchInNorm, filters = {}) {
        const cap = Math.min(this.maxResultWindow, 2000);
        const runAnchorQuery = async (restrictKnn) => {
            const embedding = await this.embeddingService.embedQuery(term);
            const osQuery = this.queryBuilder.buildNormalizedHybridQuery(
                term, embedding, filters, 1, cap, searchInNorm, null, false, null, null,
                { refineChain: [], restrictKnn }
            );
            osQuery.size = cap;
            osQuery.from = 0;
            osQuery._source = ['mongo_id'];
            delete osQuery.aggs;
            return this.opensearch.search({ index: this.indexName, body: this._withPaginationDepth(osQuery), search_pipeline: this.rrfPipeline });
        };
        try {
            const bm25HitCount = await this._bm25PreCheck(term, searchInNorm, null, false, [], null);
            // kNN returns neighbours for any vector; a term with no lexical hits must not become an anchor.
            if (bm25HitCount === 0) return { filter: { match_none: {} }, scoreById: {} };

            let resp = await runAnchorQuery(true);
            if (resp.body.hits.hits.length === 0) resp = await runAnchorQuery(false);
            const ids = [];
            const scoreById = {};
            for (const hit of resp.body.hits.hits) {
                const id = hit._source.mongo_id;
                if (!id) continue;
                ids.push(id);
                scoreById[id] = hit._score;
            }
            // Truncated id list OR the term's lexical clause — see QueryBuilder.buildRefineAnchorFilter.
            return { filter: this.queryBuilder.buildRefineAnchorFilter(term, ids, searchInNorm), scoreById };
        } catch (err) {
            this.logger.warn({ err: err?.message, term }, 'Refine anchor id-membership lookup failed; falling back to literal narrowing');
            return { filter: this.queryBuilder.buildLiteralPrimaryClause(term, searchInNorm), scoreById: {} };
        }
    }

    async _runAdvancedSearch({ query, filters, sort, page, per_page, searchInNorm, refineChain = [], facultyAuthorIds, authorRefineNarrow, facultyKerberosIds, cacheKey, rerank = null }) {
        this.logger.info({ query, mode: 'advanced' }, 'Running ADVANCED (hybrid) search');

        const refineAnchor = authorRefineNarrow ? refineChain[0] : null;
        const refineAnchors = await this._buildAdvancedRefineAnchors(refineChain, searchInNorm, authorRefineNarrow, filters);
        const refineFilterClauses = refineAnchors ? refineAnchors.map((a) => a.filter) : null;

        // Skip hybrid kNN when nothing matches lexically — otherwise kNN returns neighbours for gibberish.
        const bm25HitCount = await this._bm25PreCheck(query, searchInNorm, facultyAuthorIds, authorRefineNarrow, refineChain, facultyKerberosIds, refineFilterClauses);
        if (bm25HitCount === 0) {
            const fuzzyHitCount = contentTerms(query).length <= 2
                ? await this._bm25PreCheck(query, searchInNorm, facultyAuthorIds, authorRefineNarrow, refineChain, facultyKerberosIds, refineFilterClauses, { fuzzy: true })
                : 0;
            if (fuzzyHitCount > 0) {
                this.logger.info({ query }, 'BM25 pre-check matched only fuzzily — routing to fuzzy fallback');
                const embedding = await this.embeddingService.embedQuery(query);
                return this._fuzzyFallbackSearch(query, embedding, filters, sort, page, per_page, searchInNorm, facultyAuthorIds, authorRefineNarrow, refineChain, facultyKerberosIds);
            }
            this.logger.info({ query }, 'BM25 pre-check returned 0 hits — skipping hybrid search');
            const suggestions = await this.suggestions.getSuggestions(query);
            return {
                results: [],
                related_faculty: [],
                suggestions,
                facets: {},
                pagination: { page, per_page, total: 0, total_pages: 0 },
                mode: 'advanced',
                message: suggestions.length > 0
                    ? 'No results found. Did you mean one of the suggestions?'
                    : 'No results found. Try different keywords.',
                cacheHit: false
            };
        }

        const embedding = await this.embeddingService.embedQuery(query);
        const usesRrf = sort === 'relevance' || sort === 'normalized';
        const normalizedHybridArgs = { refineChain, refineFilterClauses };
        const hybridQueryBuildersBySort = {
            impact: () => this.queryBuilder.buildImpactQuery(query, embedding, filters, page, per_page, searchInNorm, facultyAuthorIds, authorRefineNarrow, refineAnchor, facultyKerberosIds, { refineChain }),
            relevance: () => this.queryBuilder.buildNormalizedHybridQuery(query, embedding, filters, page, per_page, searchInNorm, facultyAuthorIds, authorRefineNarrow, refineAnchor, facultyKerberosIds, normalizedHybridArgs),
            normalized: () => this.queryBuilder.buildNormalizedHybridQuery(query, embedding, filters, page, per_page, searchInNorm, facultyAuthorIds, authorRefineNarrow, refineAnchor, facultyKerberosIds, normalizedHybridArgs)
        };
        const buildFieldOrderedHybridQuery = () => this.queryBuilder.buildHybridQuery(query, embedding, filters, page, per_page, sort, searchInNorm, facultyAuthorIds, authorRefineNarrow, refineAnchor, facultyKerberosIds, { refineChain });
        let osQuery = (hybridQueryBuildersBySort[sort] || buildFieldOrderedHybridQuery)();

        if (!usesRrf && refineFilterClauses?.length > 0) {
            const filterArrays = [
                osQuery.query?.bool?.filter,
                osQuery.query?.function_score?.query?.bool?.filter
            ].filter(Boolean);
            if (filterArrays.length) filterArrays[0].push(...refineFilterClauses);
            this.logger.info({ refine_chain: refineChain }, 'Added refine_chain filters to advanced query');
        }

        const rerankRequested = rerank !== false;
        const rerankApplicable = this.rerankEnabled && rerankRequested && (sort === 'relevance' || sort === 'normalized');
        const K = this.candidateK;
        const pageStart = (page - 1) * per_page;
        const pageEnd = pageStart + per_page;
        const rerankEligible = rerankApplicable && pageStart < K;
        const rawFrom = Math.max(pageStart, rerankApplicable ? K : 0);
        const needsRaw = pageEnd > rawFrom;
        const rawExceedsWindow = needsRaw && (pageEnd > this.maxResultWindow);

        if (rerankEligible) {
            osQuery.size = K;
            osQuery.from = 0;
        } else {
            osQuery.size = per_page;
            osQuery.from = pageStart;
        }
        osQuery = this._withPaginationDepth(osQuery);

        // Deep page beyond max_result_window: count only and return an honest empty page.
        if (!rerankEligible && rawExceedsWindow) {
            return this._emptyPageWithTrueTotal(osQuery, usesRrf, page, per_page, rerankApplicable);
        }

        let osResponse;
        try {
            osResponse = await this.opensearch.search({ index: this.indexName, body: osQuery, ...(usesRrf ? { search_pipeline: this.rrfPipeline } : {}) });
        } catch (err) {
            if (!isPastEndOfResults(err)) throw err;
            this.logger.info({ query, page }, 'Requested page is past the end of the result set; serving an empty page');
            return this._emptyPageWithTrueTotal(osQuery, usesRrf, page, per_page, rerankApplicable);
        }
        const hits = osResponse.body.hits.hits;
        const total = osResponse.body.hits.total.value;

        if (total === 0) {
            this.logger.info({ query }, 'Primary search returned 0 results, attempting fuzzy fallback');
            return this._fuzzyFallbackSearch(query, embedding, filters, sort, page, per_page, searchInNorm, facultyAuthorIds, authorRefineNarrow, refineChain, facultyKerberosIds);
        }

        let results = await this.hydrator.hydrateFromMongoDB(hits);
        await this.hydrator.applyFacultyDisplayNames(results);

        let didRerank = false;
        if (rerankEligible && results.length > 0) {
            const reranked = await this.reranker.rerank(query, results);
            results = reranked.results;
            didRerank = reranked.reranked === true;

            const sliceEnd = Math.min(pageEnd, K);
            results = results.slice(pageStart, sliceEnd);

            if (pageEnd > K && !rawExceedsWindow) {
                try {
                    const rawBody = this._withPaginationDepth({ ...osQuery, from: K, size: pageEnd - K });
                    delete rawBody.aggs;
                    const rawResp = await this.opensearch.search({ index: this.indexName, body: rawBody, ...(usesRrf ? { search_pipeline: this.rrfPipeline } : {}) });
                    let rawResults = await this.hydrator.hydrateFromMongoDB(rawResp.body.hits.hits);
                    await this.hydrator.applyFacultyDisplayNames(rawResults);
                    results = results.concat(rawResults);
                } catch (err) {
                    this.logger.warn({ err }, 'Straddle-page raw fetch failed; serving reranked portion only');
                }
            }
        }

        const related_faculty = await this.hydrator.extractRelatedFaculty(results);
        const suggestions = total < 3 ? await this.suggestions.getSuggestions(query) : [];

        const response = {
            results,
            related_faculty,
            suggestions,
            facets: this.hydrator.parseFacets(osResponse.body.aggregations),
            pagination: this._buildPagination(page, per_page, total, resolveRankedWindow({
                didRerank, rerankApplicable, rerankEligible, total, candidateK: K
            })),
            reranked: didRerank,
            mode: 'advanced'
        };

        await this._cacheResponse(cacheKey, response);
        return { ...response, cacheHit: false };
    }

    async _cacheResponse(cacheKey, response) {
        try {
            await this.redis.setex(cacheKey, this.redisTTL.searchResults, JSON.stringify(response));
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache write failed');
        }
    }

    async _emptyPageWithTrueTotal(osQuery, usesRrf, page, per_page, rerankApplicable) {
        let trueTotal = 0;
        try {
            const countBody = this._withPaginationDepth({ ...osQuery, size: 0, from: 0, _source: false });
            delete countBody.aggs;
            const countResp = await this.opensearch.search({ index: this.indexName, body: countBody, ...(usesRrf ? { search_pipeline: this.rrfPipeline } : {}) });
            trueTotal = countResp.body.hits.total.value;
        } catch (err) {
            this.logger.warn({ err }, 'Deep-page count query failed; reporting 0 total');
        }
        return {
            results: [],
            related_faculty: [],
            suggestions: [],
            facets: {},
            pagination: this._buildPagination(page, per_page, trueTotal, resolveRankedWindow({
                didRerank: false,
                rerankApplicable,
                rerankEligible: false,
                total: trueTotal,
                candidateK: this.candidateK
            })),
            reranked: false,
            mode: 'advanced',
            cacheHit: false
        };
    }

    _buildPagination(page, per_page, total, rankedWindow) {
        const maxNavPage = Math.max(1, Math.floor(this.maxResultWindow / per_page));
        const totalPages = Math.min(Math.ceil(total / per_page), maxNavPage);
        return { page, per_page, total, ranked_window: rankedWindow, total_pages: totalPages };
    }

    async _bm25PreCheck(query, search_in = null, facultyAuthorIds = null, authorRefineNarrow = false, refineChain = [], facultyKerberosIds = null, refineFilterClauses = null, { fuzzy = false } = {}) {
        const chain = normalizeChain(refineChain);
        const authorOnly = search_in?.length === 1 && search_in[0] === 'author';
        const useAuthorRefine = authorRefineNarrow && authorOnly && chain.length >= 1;

        let preCheckClause;
        if (useAuthorRefine) {
            preCheckClause = this.queryBuilder.buildAuthorRefineNarrowMust(query, chain[0], facultyAuthorIds, { fuzziness: 'AUTO' }, facultyKerberosIds, chain.slice(1));
        } else if (search_in && search_in.length > 0) {
            preCheckClause = this.queryBuilder.buildConstrainedSearchInClause(query, search_in, { fuzziness: 'AUTO' }, facultyAuthorIds, facultyKerberosIds);
        } else {
            preCheckClause = this.queryBuilder.buildAdmissionPreCheckClause(query, { fuzzy });
        }

        // Prior refinement terms (standard path) become filters: the pre-check must reflect the
        // narrowed pool. In advanced mode this uses the anchor's actual result-id membership (see
        // _buildRefineAnchorIdFilter) rather than a literal AND-of-terms match.
        const body = (!useAuthorRefine && chain.length > 0)
            ? { size: 0, query: { bool: { must: [preCheckClause], filter: refineFilterClauses || this.queryBuilder.buildRefineFilterClauses(chain, search_in, {}) } } }
            : { size: 0, query: preCheckClause };

        const response = await this.opensearch.search({ index: this.indexName, body });
        return response.body.hits.total.value;
    }

    /**
     * Fuzzy fallback when the primary advanced query returns nothing. Requires a (fuzzy) BM25
     * match; kNN only boosts ranking. Skipped when refining (narrowing must not expand results).
     */
    async _fuzzyFallbackSearch(query, embedding, filters, sort, page, per_page, search_in, facultyAuthorIds = null, authorRefineNarrow = false, refineChain = [], facultyKerberosIds = null) {
        const chain = normalizeChain(refineChain);
        if (chain.length > 0 && !authorRefineNarrow) {
            this.logger.info({ query, refine_chain: chain }, 'Skipping fuzzy fallback: refinement is active');
            const suggestions = await this.suggestions.getSuggestions(query);
            return {
                results: [],
                related_faculty: [],
                suggestions,
                fuzzy_fallback: false,
                facets: {},
                pagination: { page, per_page, total: 0, total_pages: 0 },
                mode: 'advanced',
                message: 'No results found matching your refinement. Try different keywords.',
                cacheHit: false
            };
        }

        const from = (page - 1) * per_page;
        const searchFields = this.filters.getHybridSearchFields(search_in);
        const filterClauses = this.filters.buildFilters(filters);

        const authorOnly = search_in?.length === 1 && search_in[0] === 'author';
        const useAuthorRefine = authorRefineNarrow && authorOnly && chain.length >= 1;

        const fallbackFuzz = TYPO_FUZZ;
        let fuzzyMust;
        if (useAuthorRefine) {
            fuzzyMust = this.queryBuilder.buildAuthorRefineNarrowMust(query, chain[0], facultyAuthorIds, fallbackFuzz, facultyKerberosIds, chain.slice(1));
        } else if (search_in && search_in.length > 0) {
            fuzzyMust = this.queryBuilder.buildConstrainedSearchInClause(query, search_in, fallbackFuzz, facultyAuthorIds, facultyKerberosIds);
        } else {
            fuzzyMust = this.queryBuilder._buildDefaultBm25Clause(query, searchFields, fallbackFuzz, false);
        }

        const knnBoost = { knn: { embedding: { vector: embedding, k: 50 } } };

        const fallbackQuery = {
            size: per_page,
            from,
            track_total_hits: true,
            _source: ['mongo_id', 'title', 'abstract'],
            query: {
                bool: { must: [fuzzyMust], should: [knnBoost], filter: filterClauses }
            },
            aggs: this.filters.getAggregations(),
            highlight: this.queryBuilder._buildHighlightBlock(query, chain)
        };

        try {
            const osResponse = await this.opensearch.search({ index: this.indexName, body: fallbackQuery });
            const hits = osResponse.body.hits.hits;
            const total = osResponse.body.hits.total.value;
            const results = await this.hydrator.hydrateFromMongoDB(hits);
            await this.hydrator.applyFacultyDisplayNames(results);
            const related_faculty = await this.hydrator.extractRelatedFaculty(results);
            const suggestions = await this.suggestions.getSuggestions(query);

            return {
                results,
                related_faculty,
                suggestions,
                fuzzy_fallback: true,
                facets: this.hydrator.parseFacets(osResponse.body.aggregations),
                pagination: { page, per_page, total, total_pages: Math.ceil(total / per_page) },
                mode: 'advanced',
                message: total > 0 ? 'Showing approximate matches for your query' : 'No results found. Try different keywords.',
                cacheHit: false
            };
        } catch (err) {
            this.logger.error({ err, query }, 'Fuzzy fallback search failed');
            return {
                results: [],
                related_faculty: [],
                facets: {},
                suggestions: [],
                fuzzy_fallback: true,
                pagination: { page, per_page, total: 0, total_pages: 0 },
                mode: 'advanced',
                message: 'No relevant results found for your query',
                cacheHit: false
            };
        }
    }

    authorScopedSearch(params) {
        return this.authorScoped.search(params);
    }

    getAllFacultyForQuery(query, mode = 'advanced', search_in = null, refine_within = null, filters = null, refine_chain = null) {
        return this.facultyForQuery.getAllFacultyForQuery(query, mode, search_in, refine_within, filters, refine_chain);
    }
}
