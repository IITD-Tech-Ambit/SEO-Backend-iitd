import crypto from 'crypto';
import '../../models/ip_metadata.js';
import '../../models/faculty.js';

import { buildSearchConfig } from './constants.js';
import FilterBuilder from './FilterBuilder.js';
import QueryBuilder, { normalizeChain } from './QueryBuilder.js';
import ResultHydrator from './ResultHydrator.js';
import RerankService from '../search/RerankService.js';

/**
 * Orchestrates hybrid search across the OpenSearch `ip_documents` index and MongoDB (IPMetaData).
 *
 * Owns request flow (caching, mode selection, pagination, reranking, fallbacks) and delegates
 * to QueryBuilder, FilterBuilder, ResultHydrator, and the shared RerankService.
 *
 * Modes: basic = strict BM25 only; advanced = BM25 + hybrid kNN with BM25 pre-check and fuzzy fallback.
 */
export default class IpSearchService {
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
        this.rerankConfig = config.reranker || {};

        this.filters = new FilterBuilder(this.searchConfig);
        this.queryBuilder = new QueryBuilder({
            searchConfig: this.searchConfig,
            filterBuilder: this.filters
        });
        this.hydrator = new ResultHydrator({ mongoose: this.mongoose, logger: this.logger });
        this.reranker = new RerankService({
            embeddingService: this.embeddingService,
            redis: this.redis,
            rerankConfig: { ...this.rerankConfig, modelVersion: `ip-${this.rerankConfig.modelVersion || 'bge-reranker-base-v1'}` },
            logger: this.logger
        });
    }

    async search({ query, filters, sort = 'relevance', page = 1, per_page = 20, search_in = null, mode = 'advanced', refine_within = null, refine_chain = null, rerank = null }) {
        const searchInNorm = this.filters.normalizeSearchIn(search_in);
        const refineChain = this._normalizeRefineChain(refine_chain, refine_within);

        const cachePayload = JSON.stringify({
            query, filters, sort, page, per_page,
            search_in: searchInNorm, mode, refine_chain: refineChain,
            rerank: rerank === false ? false : null
        });
        const cacheKey = `ip-search:${crypto.createHash('sha256').update(cachePayload).digest('hex').slice(0, 16)}`;

        this.logger.info({ cacheKey, query, filters, sort, search_in: searchInNorm, mode, refine_chain: refineChain }, 'IP search request');

        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                this.logger.info({ cacheKey, query }, 'IP search cache HIT');
                return { ...JSON.parse(cached), cacheHit: true };
            }
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed');
        }

        if (mode === 'basic') {
            return this._runBasicSearch({ query, filters, sort, page, per_page, searchInNorm, refineChain, cacheKey });
        }

        return this._runAdvancedSearch({ query, filters, sort, page, per_page, searchInNorm, refineChain, cacheKey, rerank });
    }

    _normalizeRefineChain(refine_chain, refine_within) {
        const source = (Array.isArray(refine_chain) && refine_chain.length > 0) ? refine_chain : refine_within;
        return normalizeChain(source);
    }

    async _runBasicSearch({ query, filters, sort, page, per_page, searchInNorm, refineChain = [], cacheKey }) {
        this.logger.info({ query, mode: 'basic' }, 'Running BASIC (BM25-only) IP search');

        // Phrase-first recall, then strict per-term AND if the phrase tier recalls nothing.
        let osQuery = this.queryBuilder.buildBasicPhraseQuery(query, filters, page, per_page, sort, searchInNorm, refineChain);
        let matchTier = 'phrase';
        let osResponse = await this.opensearch.search({ index: this.indexName, body: osQuery });
        let total = osResponse.body.hits.total.value;

        if (total === 0) {
            matchTier = 'terms';
            osQuery = this.queryBuilder.buildBasicQuery(query, filters, page, per_page, sort, searchInNorm, refineChain);
            osResponse = await this.opensearch.search({ index: this.indexName, body: osQuery });
            total = osResponse.body.hits.total.value;
        }

        const hits = osResponse.body.hits.hits;

        if (total === 0) {
            this.logger.info({ query, refine_chain: refineChain.length }, 'Basic IP search: no hits (strict match)');
            return {
                results: [],
                related_faculty: [],
                suggestions: [],
                facets: {},
                pagination: { page, per_page, total: 0, total_pages: 0 },
                mode: 'basic',
                match_tier: matchTier,
                cacheHit: false
            };
        }

        const results = await this.hydrator.hydrateFromMongoDB(hits);
        await this.hydrator.applyFacultyDisplayNames(results);
        const related_faculty = await this.hydrator.extractRelatedFaculty(results);

        const response = {
            results,
            related_faculty,
            suggestions: [],
            facets: this.hydrator.parseFacets(osResponse.body.aggregations),
            pagination: { page, per_page, total, total_pages: Math.ceil(total / per_page) },
            mode: 'basic',
            match_tier: matchTier
        };

        await this._cacheResponse(cacheKey, response);
        return { ...response, cacheHit: false };
    }

    async _runAdvancedSearch({ query, filters, sort, page, per_page, searchInNorm, refineChain = [], cacheKey, rerank = null }) {
        this.logger.info({ query, mode: 'advanced' }, 'Running ADVANCED (hybrid) IP search');

        const embedding = await this.embeddingService.embedQuery(query);

        // Skip hybrid kNN when nothing matches lexically — otherwise kNN returns neighbors for gibberish.
        const bm25HitCount = await this._bm25PreCheck(query, searchInNorm, refineChain);
        if (bm25HitCount === 0) {
            this.logger.info({ query }, 'BM25 pre-check returned 0 hits — skipping hybrid IP search');
            return {
                results: [],
                related_faculty: [],
                suggestions: [],
                facets: {},
                pagination: { page, per_page, total: 0, total_pages: 0 },
                mode: 'advanced',
                message: 'No results found. Try different keywords.',
                cacheHit: false
            };
        }

        // relevance/normalized -> score-normalized hybrid; date/other -> field-ordered hybrid.
        const normalizedHybridArgs = { bm25HitCount, candidateK: this.candidateK, refineChain };
        const hybridQueryBuildersBySort = {
            relevance: () => this.queryBuilder.buildNormalizedHybridQuery(query, embedding, filters, page, per_page, searchInNorm, normalizedHybridArgs),
            normalized: () => this.queryBuilder.buildNormalizedHybridQuery(query, embedding, filters, page, per_page, searchInNorm, normalizedHybridArgs)
        };
        const buildFieldOrderedHybridQuery = () => this.queryBuilder.buildHybridQuery(query, embedding, filters, page, per_page, sort, searchInNorm, { refineChain });
        const osQuery = (hybridQueryBuildersBySort[sort] || buildFieldOrderedHybridQuery)();

        // Top candidateK hits form the reranked window; deeper pages use raw hybrid-score order.
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

        if (!rerankEligible && rawExceedsWindow) {
            let trueTotal = 0;
            try {
                const countBody = { ...osQuery, size: 0, from: 0, _source: false };
                delete countBody.aggs;
                const countResp = await this.opensearch.search({ index: this.indexName, body: countBody });
                trueTotal = countResp.body.hits.total.value;
            } catch (err) {
                this.logger.warn({ err }, 'Deep-page count query failed; reporting 0 total');
            }
            return {
                results: [],
                related_faculty: [],
                suggestions: [],
                facets: {},
                pagination: this._buildPagination(page, per_page, trueTotal, rerankApplicable),
                mode: 'advanced',
                cacheHit: false
            };
        }

        const osResponse = await this.opensearch.search({ index: this.indexName, body: osQuery });
        const hits = osResponse.body.hits.hits;
        const total = osResponse.body.hits.total.value;

        if (total === 0) {
            this.logger.info({ query }, 'Primary IP search returned 0 results, attempting fuzzy fallback');
            return this._fuzzyFallbackSearch(query, embedding, filters, sort, page, per_page, searchInNorm, refineChain);
        }

        let results = await this.hydrator.hydrateFromMongoDB(hits);

        if (rerankEligible && results.length > 0) {
            const reranked = await this.reranker.rerank(query, results);
            results = reranked.results;

            const sliceEnd = Math.min(pageEnd, K);
            results = results.slice(pageStart, sliceEnd);

            if (pageEnd > K && !rawExceedsWindow) {
                try {
                    const rawBody = { ...osQuery, from: K, size: pageEnd - K };
                    delete rawBody.aggs;
                    const rawResp = await this.opensearch.search({ index: this.indexName, body: rawBody });
                    const rawResults = await this.hydrator.hydrateFromMongoDB(rawResp.body.hits.hits);
                    results = results.concat(rawResults);
                } catch (err) {
                    this.logger.warn({ err }, 'Straddle-page raw fetch failed; serving reranked portion only');
                }
            }
        }

        await this.hydrator.applyFacultyDisplayNames(results);
        const related_faculty = await this.hydrator.extractRelatedFaculty(results);

        const response = {
            results,
            related_faculty,
            suggestions: [],
            facets: this.hydrator.parseFacets(osResponse.body.aggregations),
            pagination: this._buildPagination(page, per_page, total, rerankApplicable),
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

    /** `total` is the true match count; total_pages is clamped to max_result_window. */
    _buildPagination(page, per_page, total, rerankApplicable) {
        const rankedWindow = rerankApplicable ? Math.min(total, this.candidateK) : total;
        const maxNavPage = Math.max(1, Math.floor(this.maxResultWindow / per_page));
        const totalPages = Math.min(Math.ceil(total / per_page), maxNavPage);
        return { page, per_page, total, ranked_window: rankedWindow, total_pages: totalPages };
    }

    /**
     * Lenient BM25 pre-check (OR across terms) so partial-vocabulary queries pass but gibberish does not.
     */
    async _bm25PreCheck(query, search_in = null, refineChain = []) {
        const chain = normalizeChain(refineChain);

        let preCheckClause;
        if (search_in && search_in.length > 0) {
            preCheckClause = this.queryBuilder.buildConstrainedSearchInClause(query, search_in, { fuzziness: 'AUTO' });
        } else {
            const tokens = (query || '').trim().split(/\s+/).filter(Boolean);
            const minMatch = tokens.length <= 2 ? 1 : Math.ceil(tokens.length * 0.5);
            const textMatch = {
                multi_match: {
                    query,
                    fields: ['title', 'abstract', 'field_of_invention'],
                    type: 'cross_fields',
                    minimum_should_match: String(minMatch)
                }
            };
            const inventorClause = this.queryBuilder.buildInventorMatchClause(query, { fuzziness: 'AUTO' });
            preCheckClause = inventorClause
                ? { bool: { should: [textMatch, inventorClause], minimum_should_match: 1 } }
                : textMatch;
        }

        // Refinement terms are strict filters so the pre-check reflects the narrowed pool.
        const body = (chain.length > 0)
            ? { size: 0, query: { bool: { must: [preCheckClause], filter: this.queryBuilder.buildRefineFilterClauses(chain, search_in) } } }
            : { size: 0, query: preCheckClause };

        const response = await this.opensearch.search({ index: this.indexName, body });
        return response.body.hits.total.value;
    }

    /**
     * Fuzzy fallback when primary advanced query returns nothing. Skipped when refining
     * (narrowing must not expand results). kNN only boosts ranking.
     */
    async _fuzzyFallbackSearch(query, embedding, filters, sort, page, per_page, search_in, refineChain = []) {
        const chain = normalizeChain(refineChain);
        if (chain.length > 0) {
            this.logger.info({ query, refine_chain: chain }, 'Skipping fuzzy fallback: refinement is active');
            return {
                results: [],
                related_faculty: [],
                suggestions: [],
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

        let fuzzyMust;
        if (search_in && search_in.length > 0) {
            fuzzyMust = this.queryBuilder.buildConstrainedSearchInClause(query, search_in, { fuzziness: 2 });
        } else {
            const textBm25 = this.queryBuilder.buildStrictBm25Must(query, searchFields, { fuzziness: 2 });
            const inventorClause = this.queryBuilder.buildInventorMatchClause(query, { fuzziness: 2 });
            fuzzyMust = inventorClause
                ? { bool: { should: [textBm25, inventorClause], minimum_should_match: 1 } }
                : textBm25;
        }

        const knnBoost = { knn: { embedding: { vector: embedding, k: 50 } } };

        const fallbackQuery = {
            size: per_page,
            from,
            track_total_hits: true,
            _source: ['mongo_id'],
            query: {
                bool: { must: [fuzzyMust], should: [knnBoost], filter: filterClauses }
            },
            sort: this.queryBuilder._sortClause(sort),
            aggs: this.filters.getAggregations()
        };

        try {
            const osResponse = await this.opensearch.search({ index: this.indexName, body: fallbackQuery });
            const hits = osResponse.body.hits.hits;
            const total = osResponse.body.hits.total.value;
            const results = await this.hydrator.hydrateFromMongoDB(hits);
            await this.hydrator.applyFacultyDisplayNames(results);
            const related_faculty = await this.hydrator.extractRelatedFaculty(results);

            return {
                results,
                related_faculty,
                suggestions: [],
                fuzzy_fallback: true,
                facets: this.hydrator.parseFacets(osResponse.body.aggregations),
                pagination: { page, per_page, total, total_pages: Math.ceil(total / per_page) },
                mode: 'advanced',
                message: total > 0 ? 'Showing approximate matches for your query' : 'No results found. Try different keywords.',
                cacheHit: false
            };
        } catch (err) {
            this.logger.error({ err, query }, 'Fuzzy fallback IP search failed');
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
}
