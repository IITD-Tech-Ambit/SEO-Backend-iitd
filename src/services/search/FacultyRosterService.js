/**
 * Owns the IIT Delhi Faculty Scopus-id roster and author-name -> Scopus-id resolution.
 *
 * The roster gates all author-name matching: a co-author whose Scopus id is not on a
 * Faculty record must never cause a match, otherwise typing a non-IITD surname would
 * surface papers merely because a non-affiliated co-author shares that name.
 */
const REDIS_KEY = 'iitd_faculty:scopus_ids:v1';
const REDIS_TTL_SECONDS = 600;

export default class FacultyRosterService {
    constructor({ mongoose, redis, logger, filterBuilder }) {
        this.mongoose = mongoose;
        this.redis = redis;
        this.logger = logger;
        this.filterBuilder = filterBuilder;
        this._cache = { value: null, loadedAt: 0, ttlMs: 10 * 60 * 1000, inflight: null };
    }

    /**
     * Full list of IITD Faculty Scopus author ids. Cached in-memory and in Redis,
     * de-duped under concurrent calls. Returns [] only if Mongo genuinely has none.
     */
    async getAll() {
        const now = Date.now();
        const cache = this._cache;
        if (cache.value && now - cache.loadedAt < cache.ttlMs) return cache.value;
        if (cache.inflight) return cache.inflight;

        cache.inflight = (async () => {
            try {
                try {
                    const cached = await this.redis.get(REDIS_KEY);
                    if (cached) {
                        const parsed = JSON.parse(cached);
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            cache.value = parsed;
                            cache.loadedAt = now;
                            return parsed;
                        }
                    }
                } catch (err) {
                    this.logger.warn({ err: err?.message }, 'Redis read failed for iitd_faculty:scopus_ids');
                }

                const Faculty = this.mongoose.model('Faculty');
                const rows = await Faculty.find(
                    { scopus_id: { $exists: true, $ne: [] } },
                    { scopus_id: 1, _id: 0 }
                ).lean();
                const ids = new Set();
                for (const row of rows) {
                    for (const sid of row.scopus_id || []) {
                        const trimmed = sid == null ? '' : String(sid).trim();
                        if (trimmed) ids.add(trimmed);
                    }
                }
                const list = [...ids];
                cache.value = list;
                cache.loadedAt = Date.now();
                try {
                    await this.redis.setex(REDIS_KEY, REDIS_TTL_SECONDS, JSON.stringify(list));
                } catch (err) {
                    this.logger.warn({ err: err?.message }, 'Redis write failed for iitd_faculty:scopus_ids');
                }
                this.logger.info({ count: list.length }, 'Loaded IITD Faculty scopus_id roster');
                return list;
            } finally {
                cache.inflight = null;
            }
        })();
        return cache.inflight;
    }

    /**
     * Synchronous accessor for the warmed roster; null if {@link getAll} has not run yet.
     * Query builders rely on this — callers await {@link getAll} before building queries.
     */
    current() {
        return this._cache.value;
    }

    /**
     * Resolve IITD Faculty Scopus ids + kerberos ids from a free-text author query.
     * Tries full-name, first/last, last/first, then single-token matches.
     */
    async resolveScopusIdsForAuthorQuery(query) {
        const q = (query || '').trim();
        if (!q) return { scopusIds: [], kerberosIds: [] };
        const Faculty = this.mongoose.model('Faculty');
        const esc = (s) => this.filterBuilder.escapeRegexForMongo(s);
        const tokens = q.split(/\s+/).filter(Boolean);

        let candidates = [];

        const pattern = `^${esc(q).replace(/\s+/g, '\\s+')}$`;
        try {
            candidates = await Faculty.find({
                $expr: {
                    $regexMatch: {
                        input: { $trim: { input: { $concat: ['$firstName', ' ', '$lastName'] } } },
                        regex: pattern,
                        options: 'i'
                    }
                }
            }).select('scopus_id email').limit(25).lean();
        } catch (err) {
            this.logger.warn({ err }, 'Faculty full-name regex lookup failed');
        }

        if (candidates.length === 0 && tokens.length >= 2) {
            const first = tokens[0];
            const last = tokens.slice(1).join(' ');
            candidates = await Faculty.find({
                firstName: new RegExp(`^${esc(first)}$`, 'i'),
                lastName: new RegExp(`^${esc(last)}$`, 'i')
            }).select('scopus_id email').limit(25).lean();
        }

        if (candidates.length === 0 && tokens.length >= 2) {
            const last = tokens[tokens.length - 1];
            const first = tokens.slice(0, -1).join(' ');
            candidates = await Faculty.find({
                firstName: new RegExp(`^${esc(first)}$`, 'i'),
                lastName: new RegExp(`^${esc(last)}$`, 'i')
            }).select('scopus_id email').limit(25).lean();
        }

        if (candidates.length === 0 && tokens.length === 1) {
            const re = new RegExp(`^${esc(tokens[0])}$`, 'i');
            candidates = await Faculty.find({
                $or: [{ firstName: re }, { lastName: re }]
            }).select('scopus_id email').limit(25).lean();
        }

        const ids = new Set();
        const kerberosIds = new Set();
        for (const f of candidates) {
            for (const sid of f.scopus_id || []) ids.add(String(sid));
            if (f.email) {
                const k = f.email.split('@')[0].toLowerCase();
                if (k) kerberosIds.add(k);
            }
        }
        return { scopusIds: [...ids], kerberosIds: [...kerberosIds] };
    }
}
