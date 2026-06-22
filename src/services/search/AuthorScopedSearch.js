import crypto from 'crypto';
import { normalizeChain } from './QueryBuilder.js';

/**
 * Author-scoped search: rank one author's papers for a query (Explore sidebar drill-down).
 *
 * Phase 1: resolve author identity (Faculty expert_id/scopus_id, else raw id) and build an
 *   OpenSearch-native author filter using the SAME methodology as the People sidebar.
 * Phase 2: query with the shared builders + author filter (basic: strict BM25; advanced:
 *   normalized hybrid so BM25 and kNN are comparable).
 * Phase 3: hydrate from MongoDB in hit order and attach similarity scores.
 */
export default class AuthorScopedSearch {
    constructor({ opensearch, indexName, mongoose, redis, redisTTL, logger, queryBuilder, filterBuilder, rosterService, embeddingService, hydrator }) {
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
                let f = await Faculty.findOne({ scopus_id: effFilters.author_id }).select('email').lean();
                if (!f) f = await Faculty.findOne({ expert_id: effFilters.author_id }).select('email').lean();
                if (f?.email) {
                    const k = f.email.split('@')[0].trim().toLowerCase();
                    if (k) effFilters._authorKerberos = k;
                }
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

        // Phase 1: resolve author identity and build the OpenSearch-native author filter.
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
            }, 'Author-scoped search: Phase 1 - resolved author identity');

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
            this.logger.error({ err, author_id }, 'Author-scoped search: Phase 1 FAILED');
            throw err;
        }

        let facultyAuthorIds = null;
        let facultyKerberosIds = null;
        const refineFacultyIds = null;
        const refineKerberosIds = null;
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

        // Phase 2: build query with the shared builders + author filter.
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
                    facultyAuthorIds, refineFacultyIds, authorRefineNarrow,
                    facultyKerberosIds, refineKerberosIds,
                    { authorScoped: true }
                );
                const filterClauses = base.query.bool.filter || [];
                filterClauses.push(authorFilter);
                base.query.bool.filter = filterClauses;
                delete base.aggs;
                osQuery = base;
            } else {
                const embedding = await this.embeddingService.embedQuery(query);
                const base = this.queryBuilder.buildNormalizedHybridQuery(
                    query, embedding, effFilters, page, per_page,
                    searchInNorm, facultyAuthorIds, authorRefineNarrow,
                    refineAnchor, facultyKerberosIds,
                    { authorScoped: true, refineChain }
                );

                // Prior refinement terms become strict lexical FILTERS so the result set narrows
                // monotonically within this author's papers.
                if (refineChain.length > 0 && !authorRefineNarrow) {
                    const refineFilters = this.queryBuilder.buildRefineFilterClauses(refineChain, searchInNorm, { authorScoped: true });
                    const filterArrays = [
                        base.query?.bool?.filter,
                        base.query?.function_score?.query?.bool?.filter
                    ].filter(Boolean);
                    if (filterArrays.length) filterArrays[0].push(...refineFilters);
                }

                const filterTargets = [
                    base.query?.bool?.filter,
                    base.query?.script_score?.query?.bool?.filter,
                    base.query?.function_score?.query?.bool?.filter
                ].filter(Boolean);
                for (const filterArr of filterTargets) {
                    if (Array.isArray(filterArr)) filterArr.push(authorFilter);
                }

                delete base.aggs;
                osQuery = base;
            }

            this.logger.info({
                author_id,
                query,
                totalAuthorPapers,
                mode: isBasic ? 'basic' : 'advanced',
                refine_chain: refineChain.length,
                search_in: searchInNorm
            }, 'Author-scoped search: Phase 2 - querying OpenSearch');

            const osResponse = await this.opensearch.search({ index: this.indexName, body: osQuery });
            hits = osResponse.body.hits.hits;
            total = osResponse.body.hits.total.value;

            this.logger.info({ hitsCount: hits.length, total }, 'Author-scoped search: Phase 2 - OpenSearch results');
        } catch (err) {
            this.logger.error({ err, author_id, query }, 'Author-scoped search: Phase 2 FAILED (OpenSearch)');
            throw err;
        }

        // Phase 3: hydrate from MongoDB and attach similarity scores.
        let scoredResults;
        try {
            const results = await this.hydrator.hydrateFromMongoDB(hits);
            const scoreMap = new Map(hits.map(h => [h._source.mongo_id, h._score]));
            scoredResults = results.map(r => ({ ...r, similarity_score: scoreMap.get(r._id.toString()) }));
            await this.hydrator.applyFacultyDisplayNames(scoredResults);
        } catch (err) {
            this.logger.error({ err, author_id }, 'Author-scoped search: Phase 3 FAILED (Hydration)');
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
