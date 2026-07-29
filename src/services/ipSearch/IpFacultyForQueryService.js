import crypto from 'crypto';
import { normalizeChain } from './QueryBuilder.js';

/**
 * People sidebar for patent search (GET /ip/faculty-for-query): all IITD faculty inventors
 * matching a query across the ENTIRE result set, not just the current page.
 *
 * Uses the SAME query builders as POST /ip/search so total_faculty and total_matching_ip
 * agree with the patents list — mirrors src/services/search/FacultyForQueryService.js, but
 * simpler: IP inventors carry kerberos directly (no scopus_id merge needed).
 */
export default class IpFacultyForQueryService {
    constructor({ opensearch, indexName, mongoose, redis, logger, searchConfig, queryBuilder, filterBuilder, embeddingService, candidateK, rrfPipeline }) {
        this.opensearch = opensearch;
        this.indexName = indexName;
        this.mongoose = mongoose;
        this.redis = redis;
        this.logger = logger;
        this.searchConfig = searchConfig;
        this.queryBuilder = queryBuilder;
        this.filterBuilder = filterBuilder;
        this.embeddingService = embeddingService;
        this.candidateK = candidateK;
        this.rrfPipeline = rrfPipeline || 'rrf-hybrid';
    }

    _buildCacheKey(query, mode, searchInNorm, refineChain, filters) {
        const queryHash = crypto.createHash('sha256')
            .update(JSON.stringify({ query, type: 'ip_faculty_for_query', mode, search_in: searchInNorm, refine_chain: refineChain, filters }))
            .digest('hex').slice(0, 16);
        return `ip_faculty_query:${queryHash}`;
    }

    async _readCache(cacheKey) {
        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) return { ...JSON.parse(cached), cacheHit: true };
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache read failed for ip-faculty-for-query');
        }
        return null;
    }

    /** Nested agg: only faculty (affiliated) inventors, bucketed by kerberos. */
    _facultyInventorAggs() {
        return {
            faculty_inventors: {
                nested: { path: 'inventors' },
                aggs: {
                    affiliated: {
                        filter: { term: { 'inventors.is_faculty': true } },
                        aggs: {
                            by_kerberos: { terms: { field: 'inventors.kerberos', size: 500 } }
                        }
                    }
                }
            }
        };
    }

    /** Filter-only browse (mirrors QueryBuilder.buildBrowseQuery) — no relevance gate to apply. */
    _buildBrowseAggQuery(filters) {
        const filterClauses = this.filterBuilder.buildFilters(filters);
        return {
            size: 0,
            from: 0,
            track_total_hits: true,
            _source: false,
            query: filterClauses.length > 0 ? { bool: { filter: filterClauses } } : { match_all: {} },
            aggs: this._facultyInventorAggs()
        };
    }

    /**
     * bm25HitCount/candidateK must match what IpSearchService's own advanced search resolves
     * for the same query, or the two pick different (fixed vs adaptive) min_score bars and the
     * per-person counts shown here stop agreeing with what a click-through actually returns.
     */
    async _buildAggQuery(mode, query, filters, searchInNorm, refineChain, bm25HitCount) {
        const chain = normalizeChain(refineChain);
        const patch = (base) => {
            const body = { ...base };
            body.size = 0;
            body.from = 0;
            body.track_total_hits = true;
            body._source = false;
            body.aggs = this._facultyInventorAggs();
            delete body.sort;
            return body;
        };

        if (mode === 'basic') {
            return patch(this.queryBuilder.buildBasicQuery(query, filters, 1, 1, 'relevance', searchInNorm, chain));
        }

        const embedding = await this.embeddingService.embedQuery(query);
        // Sidebar counts must agree with InventorScopedSearch's own BM25-preferred admission
        // (see QueryBuilder.buildNormalizedHybridQuery): prefer BM25-only recall here too, and
        // only fall back to including kNN if BM25 found literally nothing for this query+scope
        // (bm25HitCount === 0 already short-circuits to an empty response before reaching here
        // in advanced mode, so this is mostly a defensive default for future callers).
        return patch(this.queryBuilder.buildNormalizedHybridQuery(query, embedding, filters, 1, 1, searchInNorm, {
            refineChain: chain,
            restrictKnn: true,
            bm25AdmitsNothing: bm25HitCount === 0,
            candidateK: this.candidateK
        }));
    }

    async _bm25PreCheck(query, searchInNorm, refineChain) {
        const chain = normalizeChain(refineChain);
        let preCheckClause;
        if (searchInNorm && searchInNorm.length > 0) {
            preCheckClause = this.queryBuilder.buildConstrainedSearchInClause(query, searchInNorm, { fuzziness: 'AUTO' });
        } else {
            const textMatch = {
                multi_match: { query, fields: ['title', 'abstract', 'field_of_invention'], type: 'cross_fields', minimum_should_match: '1' }
            };
            const inventorClause = this.queryBuilder.buildInventorMatchClause(query, { fuzziness: 'AUTO' });
            preCheckClause = inventorClause
                ? { bool: { should: [textMatch, inventorClause], minimum_should_match: 1 } }
                : textMatch;
        }
        const body = (chain.length > 0)
            ? { size: 0, query: { bool: { must: [preCheckClause], filter: this.queryBuilder.buildRefineFilterClauses(chain, searchInNorm) } } }
            : { size: 0, query: preCheckClause };
        const response = await this.opensearch.search({ index: this.indexName, body });
        return response.body.hits.total.value;
    }

    /** Resolve Faculty docs (with profile image) for the matched kerberos buckets, grouped by department. */
    async _resolveFaculty(kerberosBuckets) {
        const kerberosValues = kerberosBuckets.map(b => String(b.key).trim().toLowerCase()).filter(Boolean);
        if (kerberosValues.length === 0) return { departments: [], includedCount: 0 };

        const Faculty = this.mongoose.model('Faculty');
        const kerberosRegexes = kerberosValues.map(k => new RegExp(`^${k}@`, 'i'));
        const facultyDocs = await Faculty.find({ email: { $in: kerberosRegexes } })
            .populate('department', 'name')
            .select('firstName lastName expert_id department email profile_image_url').lean();

        const facultyByKerberos = new Map();
        for (const f of facultyDocs) {
            const k = (f.email || '').split('@')[0].toLowerCase();
            if (k) facultyByKerberos.set(k, f);
        }

        const deptMap = new Map();
        let includedCount = 0;
        for (const bucket of kerberosBuckets) {
            const k = String(bucket.key).trim().toLowerCase();
            const faculty = facultyByKerberos.get(k);
            if (!faculty) continue;

            const deptName = faculty?.department?.name || 'Other';
            if (!deptMap.has(deptName)) deptMap.set(deptName, { name: deptName, faculty: [], totalIpCount: 0 });
            const dept = deptMap.get(deptName);
            dept.faculty.push({
                _id: faculty._id,
                name: `${faculty.firstName} ${faculty.lastName}`.trim(),
                expert_id: faculty.expert_id,
                kerberos: k,
                profile_image_url: faculty.profile_image_url || null,
                ipCount: bucket.doc_count
            });
            dept.totalIpCount += bucket.doc_count;
            includedCount++;
        }

        const departments = Array.from(deptMap.values())
            .map(dept => ({
                name: dept.name,
                faculty: dept.faculty.sort((a, b) => b.ipCount - a.ipCount),
                total_ip_count: dept.totalIpCount
            }))
            .sort((a, b) => {
                if (a.name === 'Other') return 1;
                if (b.name === 'Other') return -1;
                return b.total_ip_count - a.total_ip_count;
            });

        return { departments, includedCount };
    }

    async getAllFacultyForQuery(query, mode = 'advanced', search_in = null, filters = null, refine_chain = null) {
        const searchInNorm = this.filterBuilder.normalizeSearchIn(search_in);
        const refineChain = normalizeChain(refine_chain);
        const effFilters = filters || {};

        const cacheKey = this._buildCacheKey(query, mode, searchInNorm, refineChain, effFilters);
        const cached = await this._readCache(cacheKey);
        if (cached) return cached;

        if (!query || !query.trim()) {
            const osQuery = this._buildBrowseAggQuery(effFilters);
            const osResponse = await this.opensearch.search({ index: this.indexName, body: osQuery });
            const totalDocs = osResponse.body.hits.total.value;
            const kerberosBuckets = osResponse.body.aggregations?.faculty_inventors?.affiliated?.by_kerberos?.buckets || [];
            const { departments, includedCount } = await this._resolveFaculty(kerberosBuckets);
            const response = { departments, total_faculty: includedCount, total_matching_ip: totalDocs };
            try {
                await this.redis.setex(cacheKey, 600, JSON.stringify(response));
            } catch (err) {
                this.logger.warn({ err }, 'Redis cache write failed for ip-faculty-for-query (browse)');
            }
            return { ...response, cacheHit: false };
        }

        let bm25HitCount = null;
        if (mode === 'advanced') {
            bm25HitCount = await this._bm25PreCheck(query, searchInNorm, refineChain);
            if (bm25HitCount === 0) {
                const emptyResponse = { departments: [], total_faculty: 0, total_matching_ip: 0 };
                try {
                    await this.redis.setex(cacheKey, 600, JSON.stringify(emptyResponse));
                } catch (err) {
                    this.logger.warn({ err }, 'Redis cache write failed for ip-faculty-for-query (empty)');
                }
                return { ...emptyResponse, cacheHit: false };
            }
        }

        const osQuery = await this._buildAggQuery(mode, query, effFilters, searchInNorm, refineChain, bm25HitCount);
        const osResponse = await this.opensearch.search({
            index: this.indexName,
            body: osQuery,
            ...(mode === 'advanced' ? { search_pipeline: this.rrfPipeline } : {})
        });

        const totalDocs = osResponse.body.hits.total.value;
        const kerberosBuckets = osResponse.body.aggregations?.faculty_inventors?.affiliated?.by_kerberos?.buckets || [];

        const { departments, includedCount } = await this._resolveFaculty(kerberosBuckets);
        const response = { departments, total_faculty: includedCount, total_matching_ip: totalDocs };

        try {
            await this.redis.setex(cacheKey, 600, JSON.stringify(response));
        } catch (err) {
            this.logger.warn({ err }, 'Redis cache write failed for ip-faculty-for-query');
        }

        return { ...response, cacheHit: false };
    }
}
