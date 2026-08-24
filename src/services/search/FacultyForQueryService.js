import crypto from 'crypto';
import { normalizeChain } from './QueryBuilder.js';
import { resolveFacultyByAuthorId } from '../../utils/facultyIdentity.js';
import { withPaginationDepth, DEFAULT_STABLE_DEPTH } from './paginationDepth.js';
import { PRECHECK_MIN_TOKENS, TYPO_FUZZ } from './constants.js';

/**
 * People sidebar (GET /search/faculty-for-query): all IITD faculty matching a query across
 * the entire result set, grouped by department (the professor's own Faculty.department, not
 * the paper's field_associated tag) and sorted by total citation count, highest first.
 *
 * Uses the SAME query builders and relevance bar as POST /search. `total_matching_papers` is
 * counted with the papers list's own query shape so the two totals on screen agree; the
 * per-faculty `paper_count`s come from a deliberately narrower lexical-only aggregation so
 * each one agrees with that person's drill-down view instead (see _buildFacultyAggQuery).
 */
export default class FacultyForQueryService {
    constructor({ opensearch, indexName, mongoose, redis, logger, searchConfig, queryBuilder, filterBuilder, rosterService, embeddingService, rrfPipeline, maxResultWindow, rrfStableDepth }) {
        this.opensearch = opensearch;
        this.indexName = indexName;
        this.mongoose = mongoose;
        this.redis = redis;
        this.logger = logger;
        this.searchConfig = searchConfig;
        this.queryBuilder = queryBuilder;
        this.filterBuilder = filterBuilder;
        this.rosterService = rosterService;
        this.embeddingService = embeddingService;
        this.rrfPipeline = rrfPipeline || 'rrf-hybrid';
        this.maxResultWindow = maxResultWindow || 10000;
        this.rrfStableDepth = rrfStableDepth || DEFAULT_STABLE_DEPTH;
    }

    /**
     * Merge flat `author_ids` and nested `authors.author_id` buckets for the same Scopus id.
     * Both count the same documents, so take the MAX of doc_count (not sum) to avoid
     * double-counting papers present in both flat and nested fields.
     */
    _mergeAuthorAggBuckets(flatBuckets, nestedBuckets) {
        const byKey = new Map();
        const accumulate = (buckets, getDocCount) => {
            for (const bucket of buckets) {
                const key = bucket.key == null ? '' : String(bucket.key).trim();
                if (!key) continue;
                const dc = getDocCount(bucket) || 0;
                const maxRel = bucket.max_relevance?.value || 0;
                const avgRel = bucket.avg_relevance?.value || 0;
                const totalCitations = bucket.total_citations?.value || 0;
                const prev = byKey.get(key);
                if (!prev) {
                    byKey.set(key, {
                        key,
                        doc_count: dc,
                        max_relevance: { value: maxRel },
                        avg_relevance: { value: avgRel },
                        total_citations: { value: totalCitations }
                    });
                } else {
                    prev.doc_count = Math.max(prev.doc_count, dc);
                    prev.max_relevance = { value: Math.max(prev.max_relevance.value, maxRel) };
                    prev.avg_relevance = { value: Math.max(prev.avg_relevance.value, avgRel) };
                    // Same docs counted in both buckets, like doc_count above — max, not sum.
                    prev.total_citations = { value: Math.max(prev.total_citations.value, totalCitations) };
                }
            }
        };
        accumulate(flatBuckets, (b) => b.doc_count);
        // Nested bucket doc_count counts nested sub-documents, not parent papers — use the
        // reverse_nested paper_count sub-agg (see FilterBuilder.facultyForQueryAggregations).
        accumulate(nestedBuckets, (b) => b.paper_count?.doc_count ?? b.doc_count);
        return [...byKey.values()].map((b) => ({
            key: b.key,
            doc_count: b.doc_count,
            max_relevance: b.max_relevance,
            avg_relevance: b.avg_relevance,
            total_citations: b.total_citations
        }));
    }

    /** Apply the SAME facet filters as POST /search, pre-resolving kerberos for author_id. */
    async _resolveEffectiveFilters(filters) {
        const effFilters = filters ? { ...filters } : {};
        if (effFilters.author_id && !effFilters._authorKerberos) {
            try {
                const Faculty = this.mongoose.model('Faculty');
                const { kerberos } = await resolveFacultyByAuthorId(Faculty, effFilters.author_id);
                if (kerberos) effFilters._authorKerberos = kerberos;
            } catch (err) {
                this.logger.warn({ err: err?.message }, 'Faculty-for-query: failed to resolve kerberos for author_id filter');
            }
        }
        return effFilters;
    }

    _buildCacheKey(query, mode, searchInNorm, refineChain, effFilters) {
        const queryHash = crypto.createHash('sha256')
            .update(JSON.stringify({
                query,
                type: 'faculty_for_query_nested',
                mode,
                search_in: searchInNorm,
                refine_chain: refineChain,
                filters: effFilters
            }))
            .digest('hex').slice(0, 16);
        return `faculty_query:${queryHash}`;
    }

    async _readCache(cacheKey, query, mode) {
        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                this.logger.info({ cacheKey, query, mode }, 'Faculty-for-query cache HIT');
                return { ...JSON.parse(cached), cacheHit: true };
            }
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed for faculty-for-query');
        }
        return null;
    }

    /** Author-only search_in: resolve the roster's scopus/kerberos ids to narrow the query. */
    async _resolveAuthorNarrowing(searchInNorm, refineChain, query) {
        let facultyAuthorIds = null;
        let facultyKerberosIds = null;
        let authorRefineNarrow = false;
        if (searchInNorm?.length === 1 && searchInNorm[0] === 'author') {
            const anchor = refineChain.length >= 1 ? refineChain[0] : query;
            const resolved = await this.rosterService.resolveScopusIdsForAuthorQuery(anchor);
            facultyAuthorIds = resolved.scopusIds;
            facultyKerberosIds = resolved.kerberosIds;
            authorRefineNarrow = refineChain.length >= 1;
        }
        const refineAnchor = authorRefineNarrow ? refineChain[0] : null;
        return { facultyAuthorIds, facultyKerberosIds, authorRefineNarrow, refineAnchor };
    }

    /** Mirrors SearchService._buildAdvancedRefineAnchors: resolves each prior refine-chain term
     *  to its own real result-id membership rather than a literal AND-of-terms, so a paper that
     *  only matched a prior term semantically isn't wrongly evicted. */
    async _buildAdvancedRefineAnchors(refineChain, searchInNorm, authorRefineNarrow, filters) {
        if (authorRefineNarrow || !refineChain.length) return null;
        return Promise.all(refineChain.map((term) => this._buildRefineAnchorIdFilter(term, searchInNorm, filters)));
    }

    /** Mirrors SearchService._buildRefineAnchorIdFilter, but uses the full maxResultWindow — this
     *  anchor is shared across every faculty member's aggregation at once, so a low cap can miss
     *  an individual's real matches. */
    async _buildRefineAnchorIdFilter(term, searchInNorm, filters = {}) {
        const cap = this.maxResultWindow;
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
            // Don't kNN-widen an ungrounded refine term — it invents membership and broadens.
            const anchorHitCount = await this._bm25PreCheck(term, searchInNorm, null, false, [], null);
            if (anchorHitCount === 0) return { filter: { match_none: {} } };

            let resp = await runAnchorQuery(true);
            if (resp.body.hits.hits.length === 0) resp = await runAnchorQuery(false);
            const ids = resp.body.hits.hits.map((hit) => hit._source.mongo_id).filter(Boolean);
            return { filter: this.queryBuilder.buildRefineAnchorFilter(term, ids, searchInNorm) };
        } catch (err) {
            this.logger.warn({ err: err?.message, term }, 'Faculty-for-query: refine anchor lookup failed; falling back to literal narrowing');
            return { filter: this.queryBuilder.buildLiteralPrimaryClause(term, searchInNorm) };
        }
    }

    /**
     * BM25 pre-check: does at least one query token appear in at least one document?
     * Mirrors SearchService._bm25PreCheck so the People sidebar and POST /search agree on
     * whether the query has ANY lexical footprint. Without this gate, the advanced hybrid
     * aggregation's kNN arm surfaces nearest-neighbor faculty even for gibberish queries that
     * the papers list (correctly) returns nothing for.
     */
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
            const textMatch = {
                multi_match: {
                    query,
                    fields: ['title', 'abstract', 'subject_area', 'field_associated'],
                    minimum_should_match: PRECHECK_MIN_TOKENS,
                    // cross_fields does not support fuzziness, so the typo probe uses best_fields.
                    ...(fuzzy ? { type: 'best_fields', ...TYPO_FUZZ } : { type: 'cross_fields' })
                }
            };
            const iitdAuthor = this.queryBuilder.buildIITDAuthorMatchClause(query, { fuzziness: 'AUTO' });
            preCheckClause = iitdAuthor
                ? { bool: { should: [textMatch, iitdAuthor], minimum_should_match: 1 } }
                : textMatch;
        }

        const body = (!useAuthorRefine && chain.length > 0)
            ? { size: 0, query: { bool: { must: [preCheckClause], filter: refineFilterClauses || this.queryBuilder.buildRefineFilterClauses(chain, search_in, {}) } } }
            : { size: 0, query: preCheckClause };

        const response = await this.opensearch.search({ index: this.indexName, body });
        return response.body.hits.total.value;
    }

    /**
     * Build the size:0 OpenSearch queries backing the People sidebar:
     *  - `aggQuery`   — the per-faculty aggregation (basic BM25, or restrictKnn'd hybrid).
     *  - `totalQuery` — count-only, in the exact shape POST /search uses, so the headline
     *    `total_matching_papers` equals the papers list. Null in basic mode, where the
     *    aggregation already runs the identical `buildBasicQuery` body the papers list does.
     */
    async _buildFacultyAggQuery(mode, query, queryFilters, searchInNorm, refineChain, narrowing, refineFilterClauses = null, { fuzzy = false } = {}) {
        const { facultyAuthorIds, facultyKerberosIds, authorRefineNarrow, refineAnchor } = narrowing;
        const facultyAggs = this.filterBuilder.facultyForQueryAggregations();

        const patchFacultyAggBody = (base) => {
            const body = { ...base };
            body.size = 0;
            body.from = 0;
            body.track_total_hits = true;
            body._source = false;
            body.aggs = facultyAggs;
            delete body.min_score;
            delete body.sort;
            return body;
        };

        if (mode === 'basic') {
            const base = this.queryBuilder.buildBasicQuery(
                query, queryFilters, 1, 1, 'relevance',
                searchInNorm, refineChain,
                facultyAuthorIds, authorRefineNarrow, facultyKerberosIds
            );
            return { aggQuery: patchFacultyAggBody(base), totalQuery: null };
        }

        const embedding = await this.embeddingService.embedQuery(query);

        // Typo queries: POST /search widens to _fuzzyFallbackSearch when the strict pre-check
        // finds nothing, so it can serve 1467 papers for "quamtum". The sidebar's exact-matching
        // hybrid finds nothing for the same query, which left a full papers list beside an empty
        // People panel. Mirror the fallback's own shape here so both describe the same set. Its
        // hits.total IS the papers-list total, so no separate count query is needed.
        if (fuzzy) {
            const fuzzyMust = searchInNorm?.length
                ? this.queryBuilder.buildConstrainedSearchInClause(query, searchInNorm, TYPO_FUZZ, facultyAuthorIds, facultyKerberosIds)
                : this.queryBuilder._buildDefaultBm25Clause(query, this.filterBuilder.getHybridSearchFields(searchInNorm), TYPO_FUZZ, false);
            return {
                aggQuery: patchFacultyAggBody({
                    query: {
                        bool: {
                            must: [fuzzyMust],
                            should: [{ knn: { embedding: { vector: embedding, k: 50 } } }],
                            filter: this.filterBuilder.buildFilters(queryFilters)
                        }
                    }
                }),
                totalQuery: null
            };
        }

        const buildHybrid = (restrictKnn) => this.queryBuilder.buildNormalizedHybridQuery(
            query, embedding, queryFilters, 1, 1,
            searchInNorm, facultyAuthorIds, authorRefineNarrow,
            refineAnchor, facultyKerberosIds,
            { refineChain, refineFilterClauses, restrictKnn }
        );

        // restrictKnn: the agg omits kNN so per-faculty counts match a click-through that starts
        // lexical-only. AuthorScopedSearch adds a small kNN arm only after a lexical dead-end.
        // Prior refine terms still use anchor-based (not literal) narrowing, matching
        // AuthorScopedSearch, so a refine chain doesn't collapse to fewer results here than there.
        return {
            aggQuery: patchFacultyAggBody(buildHybrid(true)),
            totalQuery: this._buildCountOnlyBody(buildHybrid(false))
        };
    }

    /** Strip a query body down to a count: no hits, no aggs, no highlighting, no score floor. */
    _buildCountOnlyBody(base) {
        const body = this._withPaginationDepth({ ...base, size: 0, from: 0, track_total_hits: true, _source: false });
        delete body.aggs;
        delete body.highlight;
        delete body.min_score;
        delete body.sort;
        return body;
    }

    /**
     * The papers-list total for this query. The aggregation body drops the hybrid kNN arm
     * (restrictKnn), so its own hits.total is lexical-only and can sit below POST /search.
     * The headline count uses the papers list's own query shape instead. Returns null if the
     * count can't be taken, so the caller falls back to the aggregation total.
     */
    async _fetchPapersListTotal(totalQuery) {
        if (!totalQuery) return null;
        try {
            const resp = await this.opensearch.search({
                index: this.indexName,
                body: totalQuery,
                ...(totalQuery.query?.hybrid ? { search_pipeline: this.rrfPipeline } : {})
            });
            return resp.body.hits.total.value;
        } catch (err) {
            this.logger.warn({ err: err?.message }, 'Faculty-for-query: papers-list total lookup failed; using aggregation total');
            return null;
        }
    }

    /** Merge the aggregation buckets into per-author info, applying the dynamic relevance threshold. */
    _extractAuthorInfos(osResponse, query) {
        const totalDocs = osResponse.body.hits.total.value;
        const flatBuckets = osResponse.body.aggregations?.from_author_ids?.by_scopus_author?.buckets || [];
        const nestedBuckets = osResponse.body.aggregations?.from_nested_authors?.by_scopus_author?.buckets || [];
        const expertBuckets = this._mergeAuthorAggBuckets(flatBuckets, nestedBuckets);
        const kerberosBuckets = osResponse.body.aggregations?.from_kerberos?.buckets || [];

        this.logger.info({
            query,
            totalDocs,
            uniqueScopusAuthors: expertBuckets.length,
            uniqueKerberos: kerberosBuckets.length
        }, 'Faculty-for-query: aggregation results');

        if (expertBuckets.length === 0 && kerberosBuckets.length === 0) {
            return { totalDocs, kerberosBuckets, authorInfos: [], isEmpty: true };
        }

        let authorInfos = expertBuckets.map(bucket => {
            const maxRel = bucket.max_relevance?.value || 0;
            const avgRel = bucket.avg_relevance?.value || 0;
            const paperCount = bucket.doc_count;
            const citationCount = bucket.total_citations?.value || 0;
            const authorScore = 0.6 * maxRel + 0.3 * avgRel + 0.1 * Math.log2(1 + paperCount);
            return {
                scopus_author_id: bucket.key,
                paper_count: paperCount,
                citation_count: citationCount,
                max_relevance: maxRel,
                avg_relevance: avgRel,
                author_score: authorScore
            };
        });

        if (authorInfos.length > 0) {
            const maxAuthorScore = Math.max(...authorInfos.map(a => a.author_score));
            const scoreThreshold = maxAuthorScore * 0.25;
            const initialCount = authorInfos.length;
            authorInfos = authorInfos.filter(a => a.author_score >= scoreThreshold);
            this.logger.info({
                maxAuthorScore,
                scoreThreshold,
                keptAuthors: authorInfos.length,
                droppedAuthors: initialCount - authorInfos.length
            }, 'Faculty-for-query: applied dynamic relevance threshold');
        }

        return { totalDocs, kerberosBuckets, authorInfos, isEmpty: false };
    }

    /** Resolve the Faculty docs backing the scopus/kerberos buckets. */
    async _lookupFacultyDocs(authorInfos, kerberosBuckets) {
        const scopusIds = authorInfos.map(a => a.scopus_author_id);
        const Faculty = this.mongoose.model('Faculty');

        let facultyDocs = [];
        if (scopusIds.length > 0) {
            facultyDocs = await Faculty.find({ scopus_id: { $in: scopusIds } })
                .populate('department', 'name')
                .select('firstName lastName expert_id department scopus_id email').lean();
        }

        const kerberosValues = kerberosBuckets.map(b => String(b.key).trim()).filter(Boolean);
        let kerberosFacultyDocs = [];
        if (kerberosValues.length > 0) {
            const kerberosRegexes = kerberosValues.map(k => new RegExp(`^${k}@`, 'i'));
            kerberosFacultyDocs = await Faculty.find({ email: { $in: kerberosRegexes } })
                .populate('department', 'name')
                .select('firstName lastName expert_id department scopus_id email').lean();
        }

        const facultyByScopusId = new Map();
        for (const f of facultyDocs) {
            for (const sid of f.scopus_id || []) facultyByScopusId.set(String(sid), f);
        }

        const facultyByKerberos = new Map();
        for (const f of kerberosFacultyDocs) {
            const k = (f.email || '').split('@')[0].toLowerCase();
            if (k) facultyByKerberos.set(k, f);
        }

        this.logger.info({
            totalBuckets: scopusIds.length,
            matchedFaculty: facultyDocs.length,
            kerberosFaculty: kerberosFacultyDocs.length
        }, 'Faculty-for-query: scopus_id + kerberos lookup');

        return { facultyDocs, kerberosFacultyDocs, facultyByScopusId, facultyByKerberos };
    }

    /** Dedup scopus + kerberos hits into one per-faculty record, keyed by expert_id. */
    _dedupFacultyByExpertId(authorInfos, facultyByScopusId, kerberosBuckets, facultyByKerberos) {
        const facultyDedup = new Map();

        for (const author of authorInfos) {
            const faculty = facultyByScopusId.get(String(author.scopus_author_id));
            if (!faculty) continue;
            const facultyName = `${faculty.firstName} ${faculty.lastName}`.trim();
            const key = faculty.expert_id;
            if (facultyDedup.has(key)) {
                const existing = facultyDedup.get(key);
                existing.paper_count += author.paper_count;
                existing.citation_count += author.citation_count;
                existing.author_score = Math.max(existing.author_score, author.author_score);
            } else {
                facultyDedup.set(key, {
                    name: facultyName,
                    expert_id: faculty.expert_id,
                    paper_count: author.paper_count,
                    citation_count: author.citation_count,
                    author_score: author.author_score,
                    deptName: faculty?.department?.name || 'Other'
                });
            }
        }

        for (const bucket of kerberosBuckets) {
            const k = String(bucket.key).trim().toLowerCase();
            const faculty = facultyByKerberos.get(k);
            if (!faculty) continue;

            const maxRel = bucket.max_relevance?.value || 0;
            const avgRel = bucket.avg_relevance?.value || 0;
            const paperCount = bucket.doc_count;
            const citationCount = bucket.total_citations?.value || 0;
            const authorScore = 0.6 * maxRel + 0.3 * avgRel + 0.1 * Math.log2(1 + paperCount);

            const key = faculty.expert_id;
            if (facultyDedup.has(key)) {
                const existing = facultyDedup.get(key);
                existing.paper_count = Math.max(existing.paper_count, paperCount);
                existing.citation_count = Math.max(existing.citation_count, citationCount);
                existing.author_score = Math.max(existing.author_score, authorScore);
            } else {
                facultyDedup.set(key, {
                    name: `${faculty.firstName} ${faculty.lastName}`.trim(),
                    expert_id: faculty.expert_id,
                    paper_count: paperCount,
                    citation_count: citationCount,
                    author_score: authorScore,
                    deptName: faculty?.department?.name || 'Other'
                });
            }
        }

        return facultyDedup;
    }

    /** A `hybrid` query silently caps results below from+size without this hint. This class
     *  calls OpenSearch directly, and shares the depth policy with SearchService so the sidebar
     *  fuses the same candidate pool the papers list does. */
    _withPaginationDepth(body) {
        return withPaginationDepth(body, {
            maxResultWindow: this.maxResultWindow,
            stableDepth: this.rrfStableDepth
        });
    }

    /**
     * OpenSearch counts scopus_id and kerberos independently; neither alone captures the
     * union. Recount per-faculty over the matching mongo_ids using $or to correct undercounts.
     * Mutates facultyDedup's entries in place.
     */
    async _correctPaperCountsViaMongo(osQuery, totalDocs, facultyDedup, facultyDocs, kerberosFacultyDocs) {
        if (facultyDedup.size === 0) return;
        try {
            const clampedSize = Math.min(totalDocs, this.maxResultWindow);
            const idsQuery = this._withPaginationDepth({ ...osQuery, size: clampedSize, from: 0, _source: ['mongo_id'], aggs: undefined });
            delete idsQuery.aggs;
            const idsResponse = await this.opensearch.search({
                index: this.indexName,
                body: idsQuery,
                ...(idsQuery.query?.hybrid ? { search_pipeline: this.rrfPipeline } : {})
            });
            const mongoIds = idsResponse.body.hits.hits.map(h => h._source?.mongo_id).filter(Boolean);

            if (mongoIds.length === 0) return;

            const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');
            const facultyLookup = new Map();
            for (const f of [...facultyDocs, ...kerberosFacultyDocs]) facultyLookup.set(f.expert_id, f);

            const { ObjectId } = this.mongoose.Types;
            const objectIds = mongoIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));

            await Promise.all([...facultyDedup.values()].map(async (merged) => {
                const f = facultyLookup.get(merged.expert_id);
                if (!f) return;
                const kerbId = (f.email || '').split('@')[0].toLowerCase();
                const sids = (f.scopus_id || []).map(String);
                const orClauses = [];
                if (kerbId) orClauses.push({ kerberos: kerbId });
                if (sids.length > 0) orClauses.push({ 'authors.author_id': { $in: sids } });
                if (orClauses.length === 0) return;
                const count = await ResearchDocument.countDocuments({ _id: { $in: objectIds }, $or: orClauses });
                if (count > merged.paper_count) {
                    this.logger.info(
                        { faculty: merged.name, oldCount: merged.paper_count, newCount: count },
                        'Faculty-for-query: MongoDB union correction applied'
                    );
                    merged.paper_count = count;
                }
            }));
        } catch (correctionErr) {
            this.logger.warn({
                err: correctionErr?.message || String(correctionErr),
                stack: correctionErr?.stack
            }, 'Faculty-for-query: MongoDB correction failed, using aggregation counts');
        }
    }

    /**
     * Group deduped faculty by department. Departments are sorted by total citations across
     * their matching papers (highest-cited department first); the prior avg top-3 relevance
     * score (with a size bonus) is kept only as a tiebreaker for departments with equal
     * citations (e.g. all-zero, common for very recent papers).
     */
    _groupByDepartment(facultyDedup) {
        const deptMap = new Map();
        let includedCount = 0;

        for (const [, merged] of facultyDedup) {
            const deptName = merged.deptName;
            if (!deptMap.has(deptName)) {
                deptMap.set(deptName, { name: deptName, faculty: [], facultyScores: [], totalPaperCount: 0, totalCitationCount: 0 });
            }
            const dept = deptMap.get(deptName);
            dept.faculty.push({
                name: merged.name,
                author_id: merged.expert_id,
                paper_count: merged.paper_count,
                citation_count: merged.citation_count,
                relevance_score: Math.round(merged.author_score * 100) / 100
            });
            dept.facultyScores.push(merged.author_score);
            dept.totalPaperCount += merged.paper_count;
            dept.totalCitationCount += merged.citation_count;
            includedCount++;
        }

        const departments = Array.from(deptMap.values())
            .map(dept => {
                const topScores = dept.facultyScores.sort((a, b) => b - a).slice(0, 3);
                const avgTopScore = topScores.reduce((s, v) => s + v, 0) / topScores.length;
                const deptScore = avgTopScore * (1 + 0.1 * Math.log2(dept.facultyScores.length));
                return {
                    name: dept.name,
                    faculty: dept.faculty.sort((a, b) => b.relevance_score - a.relevance_score),
                    total_paper_count: dept.totalPaperCount,
                    total_citation_count: dept.totalCitationCount,
                    _deptScore: deptScore
                };
            })
            .sort((a, b) => {
                if (a.name === 'Other') return 1;
                if (b.name === 'Other') return -1;
                if (b.total_citation_count !== a.total_citation_count) return b.total_citation_count - a.total_citation_count;
                return b._deptScore - a._deptScore;
            })
            .map(({ _deptScore, ...dept }) => dept);

        return { departments, includedCount };
    }

    async getAllFacultyForQuery(query, mode = 'advanced', search_in = null, refine_within = null, filters = null, refine_chain = null) {
        const searchInNorm = this.filterBuilder.normalizeSearchIn(search_in);
        const refineChain = normalizeChain((Array.isArray(refine_chain) && refine_chain.length > 0) ? refine_chain : refine_within);
        await this.rosterService.getAll();

        const effFilters = await this._resolveEffectiveFilters(filters);
        const cacheKey = this._buildCacheKey(query, mode, searchInNorm, refineChain, effFilters);
        const cached = await this._readCache(cacheKey, query, mode);
        if (cached) return cached;

        const narrowing = await this._resolveAuthorNarrowing(searchInNorm, refineChain, query);

        // Advanced mode uses a hybrid (kNN) aggregation, whose vector arm always returns
        // nearest neighbors — even for gibberish. Gate it behind the SAME BM25 pre-check as
        // POST /search so the People sidebar stays empty whenever the papers list is empty.
        let bm25HitCount = null;
        let refineFilterClauses = null;
        let useFuzzyFallback = false;
        if (mode === 'advanced') {
            const refineAnchors = await this._buildAdvancedRefineAnchors(refineChain, searchInNorm, narrowing.authorRefineNarrow, effFilters);
            refineFilterClauses = refineAnchors ? refineAnchors.map((a) => a.filter) : null;

            bm25HitCount = await this._bm25PreCheck(
                query, searchInNorm,
                narrowing.facultyAuthorIds, narrowing.authorRefineNarrow,
                refineChain, narrowing.facultyKerberosIds, refineFilterClauses
            );
            if (bm25HitCount === 0) {
                // Same order POST /search uses: probe for a typo before declaring no results, so
                // the two panels agree. Never while refining — narrowing must not broaden, and a
                // refinement that matches nothing has to stay empty (see _buildRefineAnchorIdFilter).
                useFuzzyFallback = normalizeChain(refineChain).length === 0
                    && await this._bm25PreCheck(
                        query, searchInNorm,
                        narrowing.facultyAuthorIds, narrowing.authorRefineNarrow,
                        refineChain, narrowing.facultyKerberosIds, refineFilterClauses,
                        { fuzzy: true }
                    ) > 0;
            }
            if (bm25HitCount === 0 && !useFuzzyFallback) {
                this.logger.info({ query, mode }, 'Faculty-for-query: BM25 pre-check returned 0 hits — no faculty');
                const emptyResponse = { departments: [], total_faculty: 0, total_matching_papers: 0 };
                try {
                    await this.redis.setex(cacheKey, 600, JSON.stringify(emptyResponse));
                } catch (err) {
                    this.logger.warn({ err }, 'Redis cache write failed for faculty-for-query (empty)');
                }
                return { ...emptyResponse, cacheHit: false };
            }
        }

        const { aggQuery: osQuery, totalQuery } = await this._buildFacultyAggQuery(mode, query, effFilters, searchInNorm, refineChain, narrowing, refineFilterClauses, { fuzzy: useFuzzyFallback });

        this.logger.info({ query, mode, search_in: searchInNorm }, 'Faculty-for-query: querying OpenSearch aggregation');
        const [osResponse, papersListTotal] = await Promise.all([
            this.opensearch.search({
                index: this.indexName,
                body: osQuery,
                ...(mode === 'advanced' ? { search_pipeline: this.rrfPipeline } : {})
            }),
            this._fetchPapersListTotal(totalQuery)
        ]);

        const { totalDocs, kerberosBuckets, authorInfos, isEmpty } = this._extractAuthorInfos(osResponse, query);
        // `totalDocs` stays the aggregation's own hit count — it bounds the mongo_id fetch in
        // _correctPaperCountsViaMongo, which walks the aggregation body, not the papers-list one.
        const totalMatchingPapers = papersListTotal ?? totalDocs;
        if (isEmpty) {
            return { departments: [], total_faculty: 0, total_matching_papers: totalMatchingPapers, cacheHit: false };
        }

        const { facultyDocs, kerberosFacultyDocs, facultyByScopusId, facultyByKerberos } =
            await this._lookupFacultyDocs(authorInfos, kerberosBuckets);

        const facultyDedup = this._dedupFacultyByExpertId(authorInfos, facultyByScopusId, kerberosBuckets, facultyByKerberos);

        await this._correctPaperCountsViaMongo(osQuery, totalDocs, facultyDedup, facultyDocs, kerberosFacultyDocs);

        const { departments, includedCount } = this._groupByDepartment(facultyDedup);

        const response = { departments, total_faculty: includedCount, total_matching_papers: totalMatchingPapers };

        try {
            await this.redis.setex(cacheKey, 600, JSON.stringify(response));
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache write failed for faculty-for-query');
        }

        this.logger.info(
            { query, totalFaculty: authorInfos.length, totalDepts: departments.length },
            'Faculty-for-query complete'
        );

        return { ...response, cacheHit: false };
    }
}
