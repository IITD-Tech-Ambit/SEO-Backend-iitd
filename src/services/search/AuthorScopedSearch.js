import crypto from 'crypto';
import { normalizeChain } from './QueryBuilder.js';
import { resolveFacultyByAuthorId } from '../../utils/facultyIdentity.js';
import { withPaginationDepth, DEFAULT_STABLE_DEPTH } from './paginationDepth.js';
import { isPastEndOfResults } from './hybridErrors.js';

const MIN_USEFUL_LEXICAL_HITS = 2;

export default class AuthorScopedSearch {
    constructor({ opensearch, indexName, mongoose, redis, redisTTL, logger, queryBuilder, filterBuilder, rosterService, embeddingService, hydrator, rrfPipeline, maxResultWindow, candidateK, rrfStableDepth }) {
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
        this.rrfStableDepth = rrfStableDepth || DEFAULT_STABLE_DEPTH;
    }

    _withPaginationDepth(body) {
        return withPaginationDepth(body, {
            candidateK: this.candidateK,
            maxResultWindow: this.maxResultWindow,
            stableDepth: this.rrfStableDepth
        });
    }

    /** Push the author filter into every hybrid arm, including the nested kNN pre-filter. */
    _scopeHybridQueryToAuthor(hybridQuery, authorFilter) {
        if (!authorFilter) return;
        for (const arm of hybridQuery?.query?.hybrid?.queries || []) {
            const knnClause = arm.bool?.must?.[0]?.knn?.embedding;
            if (knnClause) {
                if (!knnClause.filter) knnClause.filter = { bool: { filter: [] } };
                knnClause.filter.bool.filter.push(authorFilter);
                continue;
            }
            if (Array.isArray(arm.bool?.filter)) arm.bool.filter.push(authorFilter);
        }
    }

    /**
     * Loose "does this author write about any of these words at all" probe: an OR across query
     * terms (`minimum_should_match: 1`), unlike the ranking arm's AND-of-all-terms conjunction,
     * restricted to this author's own papers.
     *
     * This is the guard that stops semantic widening from becoming a gibberish matcher. A kNN arm
     * returns this author's nearest neighbours for ANY vector, so an ungated widening step answers
     * "qwxzjkvbnm" with a page of their power-systems papers. Requiring the query to be lexically
     * grounded in this author's corpus first means widening can only recover papers they genuinely
     * have on the topic — the same reason SearchService gates its hybrid kNN arm behind
     * _bm25PreCheck instead of letting the ANN arm admit on its own.
     */
    async _countAuthorLexicalGrounding(query, searchInNorm, authorFilter, filters, extraFilters = []) {
        const fields = this.filterBuilder.getHybridSearchFields(searchInNorm);
        // getSearchFields(['author']) is deliberately empty: an author-only search_in is an
        // identity lookup, not a topic query, so there is no topical neighbourhood to widen into.
        if (!fields.length) return 0;
        const resp = await this.opensearch.search({
            index: this.indexName,
            body: {
                size: 0,
                track_total_hits: true,
                query: {
                    bool: {
                        must: [{ multi_match: { query, fields, type: 'cross_fields', minimum_should_match: '1' } }],
                        filter: [authorFilter, ...this.filterBuilder.buildFilters(filters), ...extraFilters]
                    }
                }
            }
        });
        return resp.body.hits.total.value;
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
            this._scopeHybridQueryToAuthor(osQuery, authorFilter);

            return this.opensearch.search({ index: this.indexName, body: this._withPaginationDepth(osQuery), search_pipeline: this.rrfPipeline });
        };
        try {
            // Don't kNN-widen an ungrounded refine term — it invents membership and broadens.
            if (this.filterBuilder.getHybridSearchFields(searchInNorm).length > 0) {
                const anchorGrounding = await this._countAuthorLexicalGrounding(term, searchInNorm, authorFilter, {});
                if (anchorGrounding === 0) return { match_none: {} };
            }

            let resp = await runAnchorQuery(true);
            if (resp.body.hits.hits.length === 0) resp = await runAnchorQuery(false);
            const ids = resp.body.hits.hits.map((hit) => hit._source.mongo_id).filter(Boolean);
            // Ids OR the term's own lexical clause: `cap` truncates a broad anchor, and filtering
            // on the truncated slice alone drops documents basic mode keeps. See
            // QueryBuilder.buildRefineAnchorFilter.
            return this.queryBuilder.buildRefineAnchorFilter(term, ids, searchInNorm);
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
            // Set for advanced mode: rebuilds the hybrid body, optionally with the semantic-recall
            // arm appended. Kept as a closure so the widening retry below reuses the exact same
            // construction (and the same already-computed embedding and refine filters).
            let buildAdvancedQuery = null;

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
                const refineFilters = (refineChain.length > 0 && !authorRefineNarrow)
                    ? await Promise.all(refineChain.map((term) => this._buildRefineAnchorIdFilter(term, searchInNorm, authorFilter)))
                    : [];

                if (refineFilters.length > 0 && this.filterBuilder.getHybridSearchFields(searchInNorm).length > 0) {
                    const newestGrounding = await this._countAuthorLexicalGrounding(
                        query, searchInNorm, authorFilter, effFilters, refineFilters
                    );
                    if (newestGrounding === 0) {
                        hits = [];
                        total = 0;
                    }
                }

                if (hits == null) {
                    const embedding = await this.embeddingService.embedQuery(query);

                    buildAdvancedQuery = ({ semanticRecall = false } = {}) => {
                        const base = this.queryBuilder.buildNormalizedHybridQuery(
                            query, embedding, effFilters, page, per_page,
                            searchInNorm, facultyAuthorIds, authorRefineNarrow,
                            refineAnchor, facultyKerberosIds,
                            { authorScoped: true, refineChain, refineFilterClauses: refineFilters, allowKnnRecall: semanticRecall }
                        );

                        // Must run after the body is built so the kNN arm gets scoped too — and it
                        // deliberately scopes that arm from the inside (see _scopeHybridQueryToAuthor).
                        this._scopeHybridQueryToAuthor(base, authorFilter);

                        delete base.aggs;
                        return base;
                    };

                    osQuery = buildAdvancedQuery();
                }
            }

            if (hits == null) {
                osQuery = this._withPaginationDepth(osQuery);

                this.logger.info({
                    author_id,
                    query,
                    totalAuthorPapers,
                    mode: isBasic ? 'basic' : 'advanced',
                    refine_chain: refineChain.length,
                    search_in: searchInNorm
                }, 'Author-scoped search: querying OpenSearch');

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
                        this.logger.info({ author_id, query, page }, 'Author-scoped search: page is past the end of the result set; serving an empty page');
                        return this.opensearch.search({ ...searchArgs, body: { ...body, from: 0, size: 0, _source: false } });
                    }
                };

                let osResponse = await runQuery(osQuery);
                hits = osResponse.body.hits.hits;
                total = osResponse.body.hits.total.value;

                if (buildAdvancedQuery && !authorRefineNarrow && total < MIN_USEFUL_LEXICAL_HITS && osQuery.query?.hybrid?.queries?.length === 1) {
                    const groundedCount = await this._countAuthorLexicalGrounding(query, searchInNorm, authorFilter, effFilters);
                    this.logger.info({ author_id, query, total, groundedCount }, 'Author-scoped search: lexical recall is degenerate; probing semantic widening');
                    if (groundedCount > 0) {
                        osQuery = this._withPaginationDepth(buildAdvancedQuery({ semanticRecall: true }));
                        osResponse = await runQuery(osQuery);
                        hits = osResponse.body.hits.hits;
                        total = osResponse.body.hits.total.value;
                        this.logger.info({ author_id, query, total }, 'Author-scoped search: widened with the semantic-recall arm');
                    }
                }
            }

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
