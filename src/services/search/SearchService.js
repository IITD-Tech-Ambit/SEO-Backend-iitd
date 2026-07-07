import crypto from 'crypto';
import '../../models/departments.js'; // Ensure Department model is registered for populate

import { resolveFacultyByAuthorId } from '../../utils/facultyIdentity.js';
import { buildSearchConfig } from './constants.js';
import FilterBuilder from './FilterBuilder.js';
import FacultyRosterService from './FacultyRosterService.js';
import QueryBuilder, { normalizeChain } from './QueryBuilder.js';
import ResultHydrator from './ResultHydrator.js';
import RerankService from './RerankService.js';
import SuggestionService from './SuggestionService.js';
import FacultyForQueryService from './FacultyForQueryService.js';
import AuthorScopedSearch from './AuthorScopedSearch.js';

/**
 * Orchestrates hybrid search across OpenSearch and MongoDB.
 *
 * This class owns request flow (caching, mode selection, pagination, reranking, fallbacks)
 * and delegates focused concerns to collaborators: query construction (QueryBuilder),
 * filters/fields/aggregations (FilterBuilder), the IITD roster (FacultyRosterService),
 * result shaping (ResultHydrator), reranking (RerankService), suggestions (SuggestionService),
 * the People sidebar (FacultyForQueryService), and author drill-down (AuthorScopedSearch).
 */
export default class SearchService {
    constructor(fastify, config) {
        this.opensearch = fastify.opensearch;
        this.indexName = fastify.opensearchIndex;
        this.redis = fastify.redis;
        this.redisTTL = fastify.redisTTL;
        this.mongoose = fastify.mongoose;
        this.embeddingService = fastify.embeddingService;
        this.config = config;
        this.logger = fastify.log;

        this.searchConfig = buildSearchConfig(config);
        this.candidateK = config.search?.candidateK || 50;
        this.rerankEnabled = config.search?.rerankEnabled ?? true;
        this.maxResultWindow = config.search?.maxResultWindow || 10000;
        this.rerankConfig = config.reranker || {};

        const deps = {
            opensearch: this.opensearch,
            indexName: this.indexName,
            mongoose: this.mongoose,
            redis: this.redis,
            redisTTL: this.redisTTL,
            logger: this.logger,
            searchConfig: this.searchConfig,
            embeddingService: this.embeddingService
        };

        this.filters = new FilterBuilder(this.searchConfig);
        this.roster = new FacultyRosterService({ ...deps, filterBuilder: this.filters });
        this.queryBuilder = new QueryBuilder({
            searchConfig: this.searchConfig,
            filterBuilder: this.filters,
            rosterService: this.roster
        });
        this.hydrator = new ResultHydrator(deps);
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
            hydrator: this.hydrator
        });
    }

    /**
     * Pre-resolve kerberos for an author_id facet filter so the OpenSearch filter emits the
     * nested-author-id OR kerberos union clause (mirrors People sidebar / author drill-down).
     */
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
        const refineFacultyIds = null;
        const refineKerberosIds = null;
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
                facultyAuthorIds, refineFacultyIds, authorRefineNarrow, facultyKerberosIds, refineKerberosIds,
                cacheKey
            });
        }

        return this._runAdvancedSearch({
            query, filters, sort, page, per_page, searchInNorm, refineChain,
            facultyAuthorIds, refineFacultyIds, authorRefineNarrow, facultyKerberosIds, refineKerberosIds,
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

    async _runBasicSearch({ query, filters, sort, page, per_page, searchInNorm, refineChain = [], facultyAuthorIds, refineFacultyIds, authorRefineNarrow, facultyKerberosIds, refineKerberosIds, cacheKey }) {
        this.logger.info({ query, mode: 'basic' }, 'Running BASIC (BM25-only) search');

        const osQuery = this.queryBuilder.buildBasicQuery(
            query, filters, page, per_page, sort, searchInNorm, refineChain,
            facultyAuthorIds, refineFacultyIds, authorRefineNarrow, facultyKerberosIds, refineKerberosIds
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

    async _runAdvancedSearch({ query, filters, sort, page, per_page, searchInNorm, refineChain = [], facultyAuthorIds, refineFacultyIds, authorRefineNarrow, facultyKerberosIds, refineKerberosIds, cacheKey, rerank = null }) {
        this.logger.info({ query, mode: 'advanced' }, 'Running ADVANCED (hybrid) search');

        const embedding = await this.embeddingService.embedQuery(query);
        const refineAnchor = authorRefineNarrow ? refineChain[0] : null;

        // BM25 pre-check: if nothing matches lexically (even fuzzy), skip hybrid kNN entirely,
        // otherwise the kNN arm always returns nearest neighbors — even for gibberish.
        const bm25HitCount = await this._bm25PreCheck(query, searchInNorm, facultyAuthorIds, authorRefineNarrow, refineChain, facultyKerberosIds);
        if (bm25HitCount === 0) {
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

        // 'relevance'/'normalized' -> normalized hybrid (comparable BM25/kNN scales).
        // 'impact' -> citation/recency weighting. Anything else ('date'/'citations'/unknown)
        // -> field-ordered hybrid, keyed off `sort` itself rather than an explicit branch, so
        // adding a new field-ordered sort mode needs no change here.
        const normalizedHybridArgs = { bm25HitCount, candidateK: this.candidateK, refineChain };
        const hybridQueryBuildersBySort = {
            impact: () => this.queryBuilder.buildImpactQuery(query, embedding, filters, page, per_page, searchInNorm, facultyAuthorIds, authorRefineNarrow, refineAnchor, facultyKerberosIds, { refineChain }),
            relevance: () => this.queryBuilder.buildNormalizedHybridQuery(query, embedding, filters, page, per_page, searchInNorm, facultyAuthorIds, authorRefineNarrow, refineAnchor, facultyKerberosIds, normalizedHybridArgs),
            normalized: () => this.queryBuilder.buildNormalizedHybridQuery(query, embedding, filters, page, per_page, searchInNorm, facultyAuthorIds, authorRefineNarrow, refineAnchor, facultyKerberosIds, normalizedHybridArgs)
        };
        const buildFieldOrderedHybridQuery = () => this.queryBuilder.buildHybridQuery(query, embedding, filters, page, per_page, sort, searchInNorm, facultyAuthorIds, authorRefineNarrow, refineAnchor, facultyKerberosIds, { refineChain });
        const osQuery = (hybridQueryBuildersBySort[sort] || buildFieldOrderedHybridQuery)();

        // Multi-step search-on-search: every prior term becomes a strict lexical FILTER so the
        // candidate pool can only shrink (monotonic narrowing), never re-broaden via fuzzy/kNN.
        if (refineChain.length > 0 && !authorRefineNarrow) {
            const refineFilters = this.queryBuilder.buildRefineFilterClauses(refineChain, searchInNorm, {});
            const filterArrays = [
                osQuery.query?.bool?.filter,
                osQuery.query?.function_score?.query?.bool?.filter
            ].filter(Boolean);
            if (filterArrays.length) filterArrays[0].push(...refineFilters);
            this.logger.info({ refine_chain: refineChain }, 'Added refine_chain lexical filters to advanced query');
        }

        // Pagination: the top `candidateK` matches form the reranked window; pages beyond it are
        // paginated in raw hybrid-score order via from/size (bounded by max_result_window).
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

        // Deep page beyond max_result_window: count only and return an honest empty page.
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
            this.logger.info({ query }, 'Primary search returned 0 results, attempting fuzzy fallback');
            return this._fuzzyFallbackSearch(query, embedding, filters, sort, page, per_page, searchInNorm, facultyAuthorIds, authorRefineNarrow, refineChain, facultyKerberosIds);
        }

        let results = await this.hydrator.hydrateFromMongoDB(hits);
        await this.hydrator.applyFacultyDisplayNames(results);

        // Rerank the top-K window, then assemble this page from the reranked window and/or the
        // raw tail beyond it.
        if (rerankEligible && results.length > 0) {
            const reranked = await this.reranker.rerank(query, results);
            results = reranked.results;

            const sliceEnd = Math.min(pageEnd, K);
            results = results.slice(pageStart, sliceEnd);

            // Straddle page: append raw-order docs for [K, pageEnd). The reranked window covers
            // raw-ranks [0, K), so raw pagination resumes at offset K with no gap/duplicate.
            if (pageEnd > K && !rawExceedsWindow) {
                try {
                    const rawBody = { ...osQuery, from: K, size: pageEnd - K };
                    delete rawBody.aggs;
                    const rawResp = await this.opensearch.search({ index: this.indexName, body: rawBody });
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

    /**
     * Advanced-search pagination. `total` is the true relevant match count (track_total_hits at
     * the relevance bar) and drives total_pages, clamped to the deepest page servable within
     * OpenSearch's max_result_window. `ranked_window` reports how many candidates were reranked.
     */
    _buildPagination(page, per_page, total, rerankApplicable) {
        const rankedWindow = rerankApplicable ? Math.min(total, this.candidateK) : total;
        const maxNavPage = Math.max(1, Math.floor(this.maxResultWindow / per_page));
        const totalPages = Math.min(Math.ceil(total / per_page), maxNavPage);
        return { page, per_page, total, ranked_window: rankedWindow, total_pages: totalPages };
    }

    /**
     * BM25 pre-check: does at least one query token appear in at least one document?
     * Lenient (OR across terms) so partial-vocabulary queries pass, but gibberish does not.
     */
    async _bm25PreCheck(query, search_in = null, facultyAuthorIds = null, authorRefineNarrow = false, refineChain = [], facultyKerberosIds = null) {
        const chain = normalizeChain(refineChain);
        const authorOnly = search_in?.length === 1 && search_in[0] === 'author';
        const useAuthorRefine = authorRefineNarrow && authorOnly && chain.length >= 1;

        let preCheckClause;
        if (useAuthorRefine) {
            preCheckClause = this.queryBuilder.buildAuthorRefineNarrowMust(query, chain[0], facultyAuthorIds, { fuzziness: 'AUTO' }, facultyKerberosIds, chain.slice(1));
        } else if (search_in && search_in.length > 0) {
            preCheckClause = this.queryBuilder.buildConstrainedSearchInClause(query, search_in, { fuzziness: 'AUTO' }, facultyAuthorIds, facultyKerberosIds);
        } else {
            // Require a proportional share of the query tokens to appear (no fuzziness) so a
            // single incidental token from a multi-word gibberish query (e.g. "jjj kkk lll mmm",
            // where only "lll" happens to exist) does not pass the gate and let the kNN tail
            // surface unrelated nearest neighbors. Short queries stay lenient (1 token).
            const tokens = (query || '').trim().split(/\s+/).filter(Boolean);
            const minMatch = tokens.length <= 2 ? 1 : Math.ceil(tokens.length * 0.5);
            const textMatch = {
                multi_match: {
                    query,
                    fields: ['title', 'abstract', 'subject_area', 'field_associated'],
                    type: 'cross_fields',
                    minimum_should_match: String(minMatch)
                }
            };
            const iitdAuthor = this.queryBuilder.buildIITDAuthorMatchClause(query, { fuzziness: 'AUTO' });
            preCheckClause = iitdAuthor
                ? { bool: { should: [textMatch, iitdAuthor], minimum_should_match: 1 } }
                : textMatch;
        }

        // Prior refinement terms (standard path) become strict lexical filters: the pre-check must
        // reflect the narrowed pool, so a refinement that yields nothing reports 0 hits.
        const body = (!useAuthorRefine && chain.length > 0)
            ? { size: 0, query: { bool: { must: [preCheckClause], filter: this.queryBuilder.buildRefineFilterClauses(chain, search_in, {}) } } }
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

        let fuzzyMust;
        if (useAuthorRefine) {
            fuzzyMust = this.queryBuilder.buildAuthorRefineNarrowMust(query, chain[0], facultyAuthorIds, { fuzziness: 2 }, facultyKerberosIds, chain.slice(1));
        } else if (search_in && search_in.length > 0) {
            fuzzyMust = this.queryBuilder.buildConstrainedSearchInClause(query, search_in, { fuzziness: 2 }, facultyAuthorIds, facultyKerberosIds);
        } else {
            const textBm25 = this.queryBuilder.buildStrictBm25Must(query, searchFields, { fuzziness: 2 });
            const iitdAuthor = this.queryBuilder.buildIITDAuthorMatchClause(query, { fuzziness: 2 });
            fuzzyMust = iitdAuthor
                ? { bool: { should: [textBm25, iitdAuthor], minimum_should_match: 1 } }
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
            aggs: this.filters.getAggregations()
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

    /**
     * Find semantically similar papers using k-NN on an existing document's embedding.
     */
    async findSimilar(documentId, limit = 10) {
        const sourceQuery = await this.opensearch.search({
            index: this.indexName,
            body: {
                query: { term: { mongo_id: documentId } },
                _source: ['embedding', 'title', 'subject_area']
            }
        });

        if (!sourceQuery.body.hits.hits.length) {
            throw new Error('Document not found in search index');
        }

        const source = sourceQuery.body.hits.hits[0]._source;
        const embedding = source.embedding;

        const similarQuery = await this.opensearch.search({
            index: this.indexName,
            body: {
                size: limit,
                _source: ['mongo_id'],
                query: {
                    bool: {
                        must: [{ knn: { embedding: { vector: embedding, k: limit + 5 } } }],
                        must_not: [{ term: { mongo_id: documentId } }]
                    }
                }
            }
        });

        const results = await this.hydrator.hydrateFromMongoDB(similarQuery.body.hits.hits);
        const scoreMap = new Map(similarQuery.body.hits.hits.map(h => [h._source.mongo_id, h._score]));

        return {
            source: { id: documentId, title: source.title, subject_areas: source.subject_area },
            similar: results.map(r => ({ ...r, similarity_score: scoreMap.get(r._id.toString()) }))
        };
    }

    /**
     * Co-authors for a faculty member, found via both nested Scopus author_id and kerberos.
     */
    async getCoAuthors(authorId) {
        const cacheKey = `coauthors:${authorId}`;
        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) return JSON.parse(cached);
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed (getCoAuthors)');
        }

        const Faculty = this.mongoose.model('Faculty');
        const { kerberos: kerberosId, scopusIds } = await resolveFacultyByAuthorId(Faculty, authorId);
        const allScopusIds = scopusIds.length > 0 ? scopusIds : [authorId];

        const shouldClauses = [
            { nested: { path: 'authors', query: { terms: { 'authors.author_id': allScopusIds } } } }
        ];
        if (kerberosId) shouldClauses.push({ term: { kerberos: kerberosId } });

        const result = await this.opensearch.search({
            index: this.indexName,
            body: {
                size: 0,
                query: { bool: { should: shouldClauses, minimum_should_match: 1 } },
                aggs: {
                    author_papers: {
                        nested: { path: 'authors' },
                        aggs: {
                            coauthors: {
                                terms: { field: 'authors.author_id', size: 50, exclude: allScopusIds },
                                aggs: {
                                    author_info: { top_hits: { size: 1, _source: ['authors.author_name'] } }
                                }
                            }
                        }
                    },
                    total_papers: { value_count: { field: 'mongo_id' } }
                }
            }
        });

        const coauthors = result.body.aggregations?.author_papers?.coauthors?.buckets || [];

        const response = {
            author_id: authorId,
            total_papers: result.body.aggregations?.total_papers?.value || 0,
            collaborators: coauthors.map(c => ({
                author_id: c.key,
                collaboration_count: c.doc_count,
                name: c.author_info?.hits?.hits?.[0]?._source?.authors?.author_name
            }))
        };

        try {
            await this.redis.setex(cacheKey, this.redisTTL.coAuthors, JSON.stringify(response));
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache write failed (getCoAuthors)');
        }

        return response;
    }

    /**
     * Single document by Mongo `_id` or `open_search_id`.
     */
    async getDocument(id) {
        const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');
        let doc = null;
        if (id.match(/^[0-9a-fA-F]{24}$/)) doc = await ResearchDocument.findById(id).lean();
        if (!doc) doc = await ResearchDocument.findOne({ open_search_id: id }).lean();
        if (doc) await this.hydrator.filterAuthorsToFacultyRoster([doc]);
        return doc;
    }

    authorScopedSearch(params) {
        return this.authorScoped.search(params);
    }

    getAllFacultyForQuery(query, mode = 'advanced', search_in = null, refine_within = null, filters = null, refine_chain = null) {
        return this.facultyForQuery.getAllFacultyForQuery(query, mode, search_in, refine_within, filters, refine_chain);
    }
}
