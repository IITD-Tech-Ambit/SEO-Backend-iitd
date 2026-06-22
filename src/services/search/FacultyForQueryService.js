import crypto from 'crypto';
import { normalizeChain } from './QueryBuilder.js';

/**
 * People sidebar (GET /search/faculty-for-query): all IITD faculty matching a query across
 * the entire result set, grouped by department and sorted by relevance.
 *
 * Uses the SAME query builders and relevance bar as POST /search so the sidebar's
 * total_matching_papers and every per-faculty paper_count agree with the papers list.
 */
export default class FacultyForQueryService {
    constructor({ opensearch, indexName, mongoose, redis, logger, searchConfig, queryBuilder, filterBuilder, rosterService, embeddingService }) {
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
    }

    /**
     * Merge flat `author_ids` and nested `authors.author_id` buckets for the same Scopus id.
     * Both count the same documents, so take the MAX of doc_count (not sum) to avoid
     * double-counting papers present in both flat and nested fields.
     */
    _mergeAuthorAggBuckets(flatBuckets, nestedBuckets) {
        const byKey = new Map();
        const accumulate = (buckets) => {
            for (const bucket of buckets) {
                const key = bucket.key == null ? '' : String(bucket.key).trim();
                if (!key) continue;
                const dc = bucket.doc_count || 0;
                const maxRel = bucket.max_relevance?.value || 0;
                const avgRel = bucket.avg_relevance?.value || 0;
                const prev = byKey.get(key);
                if (!prev) {
                    byKey.set(key, {
                        key,
                        doc_count: dc,
                        max_relevance: { value: maxRel },
                        avg_relevance: { value: avgRel }
                    });
                } else {
                    prev.doc_count = Math.max(prev.doc_count, dc);
                    prev.max_relevance = { value: Math.max(prev.max_relevance.value, maxRel) };
                    prev.avg_relevance = { value: Math.max(prev.avg_relevance.value, avgRel) };
                }
            }
        };
        accumulate(flatBuckets);
        accumulate(nestedBuckets);
        return [...byKey.values()].map((b) => ({
            key: b.key,
            doc_count: b.doc_count,
            max_relevance: b.max_relevance,
            avg_relevance: b.avg_relevance
        }));
    }

    async getAllFacultyForQuery(query, mode = 'advanced', search_in = null, refine_within = null, filters = null, refine_chain = null) {
        const searchInNorm = this.filterBuilder.normalizeSearchIn(search_in);
        const refineChain = normalizeChain((Array.isArray(refine_chain) && refine_chain.length > 0) ? refine_chain : refine_within);
        await this.rosterService.getAll();

        // Apply the SAME facet filters as POST /search so counts describe the identical
        // filtered corpus, and pre-resolve kerberos for an author_id filter so the author
        // union clause matches across endpoints.
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
                this.logger.warn({ err: err?.message }, 'Faculty-for-query: failed to resolve kerberos for author_id filter');
            }
        }

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
        const cacheKey = `faculty_query:${queryHash}`;

        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                this.logger.info({ cacheKey, query, mode }, 'Faculty-for-query cache HIT');
                return { ...JSON.parse(cached), cacheHit: true };
            }
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed for faculty-for-query');
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

        const facultyAggs = this.filterBuilder.facultyForQueryAggregations();
        const queryFilters = effFilters;

        const patchFacultyAggBody = (base) => {
            const body = { ...base };
            body.size = 0;
            body.from = 0;
            body.track_total_hits = true;
            body._source = false;
            body.aggs = facultyAggs;
            if (mode === 'advanced') {
                // Same relevance bar as POST /search and the drill-down so counts agree.
                body.min_score = this.searchConfig.minScore.relevant;
            } else {
                delete body.min_score;
            }
            delete body.sort;
            return body;
        };

        let osQuery;
        if (mode === 'basic') {
            const base = this.queryBuilder.buildBasicQuery(
                query, queryFilters, 1, 1, 'relevance',
                searchInNorm, refineChain,
                facultyAuthorIds, refineFacultyIds, authorRefineNarrow,
                facultyKerberosIds, refineKerberosIds
            );
            osQuery = patchFacultyAggBody(base);
        } else {
            const embedding = await this.embeddingService.embedQuery(query);
            const base = this.queryBuilder.buildNormalizedHybridQuery(
                query, embedding, queryFilters, 1, 1,
                searchInNorm, facultyAuthorIds, authorRefineNarrow,
                refineAnchor, facultyKerberosIds,
                { refineChain }
            );
            // Prior refinement terms become strict lexical FILTERS so per-faculty counts reflect
            // the same monotonically narrowed pool as the papers list.
            if (refineChain.length > 0 && !authorRefineNarrow) {
                const refineFilters = this.queryBuilder.buildRefineFilterClauses(refineChain, searchInNorm, {});
                const filterArrays = [
                    base.query?.bool?.filter,
                    base.query?.function_score?.query?.bool?.filter
                ].filter(Boolean);
                if (filterArrays.length) filterArrays[0].push(...refineFilters);
            }
            osQuery = patchFacultyAggBody(base);
        }

        this.logger.info({ query, mode, search_in: searchInNorm }, 'Faculty-for-query: querying OpenSearch aggregation');

        const osResponse = await this.opensearch.search({ index: this.indexName, body: osQuery });

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
            return { departments: [], total_faculty: 0, total_matching_papers: totalDocs, cacheHit: false };
        }

        let authorInfos = expertBuckets.map(bucket => {
            const maxRel = bucket.max_relevance?.value || 0;
            const avgRel = bucket.avg_relevance?.value || 0;
            const paperCount = bucket.doc_count;
            const authorScore = 0.6 * maxRel + 0.3 * avgRel + 0.1 * Math.log2(1 + paperCount);
            return {
                scopus_author_id: bucket.key,
                paper_count: paperCount,
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

        const facultyDedup = new Map();

        for (const author of authorInfos) {
            const faculty = facultyByScopusId.get(String(author.scopus_author_id));
            if (!faculty) continue;
            const facultyName = `${faculty.firstName} ${faculty.lastName}`.trim();
            const key = faculty.expert_id;
            if (facultyDedup.has(key)) {
                const existing = facultyDedup.get(key);
                existing.paper_count += author.paper_count;
                existing.author_score = Math.max(existing.author_score, author.author_score);
            } else {
                facultyDedup.set(key, {
                    name: facultyName,
                    expert_id: faculty.expert_id,
                    paper_count: author.paper_count,
                    author_score: author.author_score,
                    deptName: faculty?.department?.name || 'Other'
                });
            }
        }

        const expertScopusIds = new Map();
        for (const author of authorInfos) {
            const faculty = facultyByScopusId.get(String(author.scopus_author_id));
            if (!faculty) continue;
            if (!expertScopusIds.has(faculty.expert_id)) expertScopusIds.set(faculty.expert_id, new Set());
            expertScopusIds.get(faculty.expert_id).add(String(author.scopus_author_id));
        }

        for (const bucket of kerberosBuckets) {
            const k = String(bucket.key).trim().toLowerCase();
            const faculty = facultyByKerberos.get(k);
            if (!faculty) continue;

            const maxRel = bucket.max_relevance?.value || 0;
            const avgRel = bucket.avg_relevance?.value || 0;
            const paperCount = bucket.doc_count;
            const authorScore = 0.6 * maxRel + 0.3 * avgRel + 0.1 * Math.log2(1 + paperCount);

            const key = faculty.expert_id;
            if (facultyDedup.has(key)) {
                const existing = facultyDedup.get(key);
                existing.paper_count = Math.max(existing.paper_count, paperCount);
                existing.author_score = Math.max(existing.author_score, authorScore);
            } else {
                facultyDedup.set(key, {
                    name: `${faculty.firstName} ${faculty.lastName}`.trim(),
                    expert_id: faculty.expert_id,
                    paper_count: paperCount,
                    author_score: authorScore,
                    deptName: faculty?.department?.name || 'Other'
                });
            }
        }

        // OpenSearch counts scopus_id and kerberos independently; neither alone captures the
        // union. Recount per-faculty over the matching mongo_ids using $or to correct undercounts.
        if (facultyDedup.size > 0) {
            try {
                const idsQuery = { ...osQuery, size: totalDocs, _source: ['mongo_id'], aggs: undefined };
                delete idsQuery.aggs;
                const idsResponse = await this.opensearch.search({ index: this.indexName, body: idsQuery });
                const mongoIds = idsResponse.body.hits.hits.map(h => h._source?.mongo_id).filter(Boolean);

                if (mongoIds.length > 0) {
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
                }
            } catch (correctionErr) {
                this.logger.warn({
                    err: correctionErr?.message || String(correctionErr),
                    stack: correctionErr?.stack
                }, 'Faculty-for-query: MongoDB correction failed, using aggregation counts');
            }
        }

        const deptMap = new Map();
        let includedCount = 0;

        for (const [, merged] of facultyDedup) {
            const deptName = merged.deptName;
            if (!deptMap.has(deptName)) {
                deptMap.set(deptName, { name: deptName, faculty: [], facultyScores: [], totalPaperCount: 0 });
            }
            const dept = deptMap.get(deptName);
            dept.faculty.push({
                name: merged.name,
                author_id: merged.expert_id,
                paper_count: merged.paper_count,
                relevance_score: Math.round(merged.author_score * 100) / 100
            });
            dept.facultyScores.push(merged.author_score);
            dept.totalPaperCount += merged.paper_count;
            includedCount++;
        }

        // Score departments by the average of their top-3 faculty scores, with a small bonus
        // for having more relevant faculty, so large low-relevance departments do not win.
        const departments = Array.from(deptMap.values())
            .map(dept => {
                const topScores = dept.facultyScores.sort((a, b) => b - a).slice(0, 3);
                const avgTopScore = topScores.reduce((s, v) => s + v, 0) / topScores.length;
                const deptScore = avgTopScore * (1 + 0.1 * Math.log2(dept.facultyScores.length));
                return {
                    name: dept.name,
                    faculty: dept.faculty.sort((a, b) => b.relevance_score - a.relevance_score),
                    total_paper_count: dept.totalPaperCount,
                    _deptScore: deptScore
                };
            })
            .sort((a, b) => {
                if (a.name === 'Other') return 1;
                if (b.name === 'Other') return -1;
                return b._deptScore - a._deptScore;
            })
            .map(({ _deptScore, ...dept }) => dept);

        const response = { departments, total_faculty: includedCount, total_matching_papers: totalDocs };

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
