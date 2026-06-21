/**
 * Turns OpenSearch hits into API-ready documents: hydrates from MongoDB in hit order,
 * strips non-IITD co-authors, overlays Faculty display names, derives the related-faculty
 * sidebar, and parses facet aggregations.
 */
export default class ResultHydrator {
    constructor({ mongoose, logger }) {
        this.mongoose = mongoose;
        this.logger = logger;
    }

    parseFacets(aggregations) {
        const buckets = (agg) => agg?.buckets?.map(b => ({ value: b.key, count: b.doc_count })) || [];
        return {
            years: buckets(aggregations?.years),
            year_ranges: buckets(aggregations?.year_ranges),
            document_types: buckets(aggregations?.document_types),
            fields: buckets(aggregations?.fields),
            subject_areas: buckets(aggregations?.subject_areas)
        };
    }

    /**
     * Hydrate OpenSearch hits from MongoDB, preserving the OpenSearch ranking order.
     */
    async hydrateFromMongoDB(osHits) {
        if (!osHits.length) return [];

        const mongoIds = osHits.map(hit => hit._source.mongo_id);
        const scoreById = new Map(osHits.map(hit => [hit._source.mongo_id, hit._score]));
        const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');
        const docs = await ResearchDocument.find({ _id: { $in: mongoIds } }).select('-__v').lean();
        const docMap = new Map(docs.map(d => [d._id.toString(), d]));
        const ordered = mongoIds.map(id => docMap.get(id)).filter(Boolean);
        // Carry the first-stage OpenSearch score so the reranker can fuse it with the
        // cross-encoder score instead of discarding the lexical/hybrid signal entirely.
        for (const doc of ordered) {
            const score = scoreById.get(doc._id.toString());
            if (typeof score === 'number') doc._firstStageScore = score;
        }
        await this.filterAuthorsToFacultyRoster(ordered);
        return ordered;
    }

    /**
     * Keep only paper authors whose Scopus author_id is on a Faculty record (IIT Delhi roster).
     * Uses paper.kerberos to guarantee the primary faculty author is always retained.
     * Mutates each document in place.
     */
    async filterAuthorsToFacultyRoster(results) {
        if (!results?.length) return;

        const scopusIds = new Set();
        const kerberosValues = new Set();
        for (const doc of results) {
            for (const a of doc.authors || []) {
                if (a?.author_id != null && String(a.author_id).trim() !== '') {
                    scopusIds.add(String(a.author_id).trim());
                }
            }
            if (doc.kerberos && String(doc.kerberos).trim()) {
                kerberosValues.add(String(doc.kerberos).trim());
            }
        }
        if (scopusIds.size === 0 && kerberosValues.size === 0) return;

        const Faculty = this.mongoose.model('Faculty');
        const [scopusFacultyDocs, kerberosFacultyDocs] = await Promise.all([
            scopusIds.size > 0
                ? Faculty.find({ scopus_id: { $in: [...scopusIds] } }, { scopus_id: 1 }).lean()
                : [],
            kerberosValues.size > 0
                ? Faculty.find(
                    { email: { $in: [...kerberosValues].map(k => new RegExp(`^${k}@`, 'i')) } },
                    { scopus_id: 1, email: 1, title: 1, firstName: 1, lastName: 1 }
                ).lean()
                : []
        ]);

        const allowed = new Set();
        for (const f of [...scopusFacultyDocs, ...kerberosFacultyDocs]) {
            for (const sid of f.scopus_id || []) {
                if (sid != null && String(sid).trim()) allowed.add(String(sid).trim());
            }
        }

        const kerberosFacultyMap = new Map();
        for (const f of kerberosFacultyDocs) {
            const k = (f.email || '').split('@')[0].toLowerCase();
            if (k) kerberosFacultyMap.set(k, f);
        }

        for (const doc of results) {
            if (doc.authors?.length) {
                doc.authors = doc.authors.filter(
                    (a) => a.author_id != null && allowed.has(String(a.author_id).trim())
                );
            }
            if ((!doc.authors || doc.authors.length === 0) && doc.kerberos) {
                const faculty = kerberosFacultyMap.get(String(doc.kerberos).trim().toLowerCase());
                if (faculty) {
                    const name = [faculty.title, faculty.firstName, faculty.lastName]
                        .filter(p => p && String(p).trim())
                        .join(' ').replace(/\s+/g, ' ').trim();
                    if (name) {
                        doc.authors = [{ author_name: name, author_id: (faculty.scopus_id || [])[0] || '' }];
                    }
                }
            }
        }
    }

    /**
     * Replace paper author_name (Scopus string) with the canonical Faculty directory name
     * when authors.author_id matches Faculty.scopus_id, or via paper.kerberos.
     */
    async applyFacultyDisplayNames(results) {
        if (!results?.length) return;

        const scopusIds = new Set();
        const kerberosValues = new Set();
        for (const doc of results) {
            for (const a of doc.authors || []) {
                if (a?.author_id != null && String(a.author_id).trim() !== '') {
                    scopusIds.add(String(a.author_id).trim());
                }
            }
            if (doc.kerberos && String(doc.kerberos).trim()) {
                kerberosValues.add(String(doc.kerberos).trim());
            }
        }
        if (scopusIds.size === 0 && kerberosValues.size === 0) return;

        const Faculty = this.mongoose.model('Faculty');
        const [scopusFacultyDocs, kerberosFacultyDocs] = await Promise.all([
            scopusIds.size > 0
                ? Faculty.find({ scopus_id: { $in: [...scopusIds] } }).select('title firstName lastName scopus_id').lean()
                : [],
            kerberosValues.size > 0
                ? Faculty.find({ email: { $in: [...kerberosValues].map(k => new RegExp(`^${k}@`, 'i')) } })
                    .select('title firstName lastName scopus_id email').lean()
                : []
        ]);

        const idToDisplayName = new Map();
        for (const f of [...scopusFacultyDocs, ...kerberosFacultyDocs]) {
            const parts = [f.title, f.firstName, f.lastName].filter((p) => p && String(p).trim());
            const name = parts.join(' ').replace(/\s+/g, ' ').trim();
            if (!name) continue;
            for (const sid of f.scopus_id || []) {
                if (sid != null && String(sid).trim()) idToDisplayName.set(String(sid).trim(), name);
            }
        }

        const kerberosToName = new Map();
        for (const f of kerberosFacultyDocs) {
            const k = (f.email || '').split('@')[0].toLowerCase();
            const parts = [f.title, f.firstName, f.lastName].filter(p => p && String(p).trim());
            const name = parts.join(' ').replace(/\s+/g, ' ').trim();
            if (k && name) kerberosToName.set(k, name);
        }

        for (const doc of results) {
            if (!doc.authors?.length) continue;
            for (const a of doc.authors) {
                if (a.author_id == null) continue;
                const display = idToDisplayName.get(String(a.author_id).trim());
                if (display) a.author_name = display;
            }
            if (doc.kerberos) {
                const kName = kerberosToName.get(String(doc.kerberos).trim().toLowerCase());
                if (kName) {
                    for (const a of doc.authors) {
                        if (!a.author_name || !a.author_name.trim()) a.author_name = kName;
                    }
                }
            }
        }
    }

    /**
     * Build the related-faculty sidebar from hydrated docs. Counts unique papers per
     * faculty via the union of scopus_id and kerberos matches.
     */
    async extractRelatedFaculty(results) {
        if (!results.length) return [];

        const Faculty = this.mongoose.model('Faculty');

        const scopusIds = new Set();
        const kerberosValues = new Set();
        for (const doc of results) {
            for (const a of doc.authors || []) {
                if (a?.author_id != null && String(a.author_id).trim()) {
                    scopusIds.add(String(a.author_id).trim());
                }
            }
            const k = (doc.kerberos || '').trim().toLowerCase();
            if (k) kerberosValues.add(k);
        }

        const authorIds = [...scopusIds];
        const kerberosArr = [...kerberosValues];

        this.logger.info(
            { uniqueAuthorIds: authorIds.length, uniqueKerberos: kerberosArr.length },
            'Related faculty: IDs collected from results'
        );

        if (authorIds.length === 0 && kerberosArr.length === 0) return [];

        const [scopusFacultyDocs, kerberosFacultyDocs] = await Promise.all([
            authorIds.length > 0
                ? Faculty.find({ scopus_id: { $in: authorIds } })
                    .populate('department', 'name')
                    .select('firstName lastName email expert_id department scopus_id').lean()
                : [],
            kerberosArr.length > 0
                ? Faculty.find({ email: { $in: kerberosArr.map(k => new RegExp(`^${k}@`, 'i')) } })
                    .populate('department', 'name')
                    .select('firstName lastName email expert_id department scopus_id').lean()
                : []
        ]);

        this.logger.info(
            { scopusMatched: scopusFacultyDocs.length, kerberosMatched: kerberosFacultyDocs.length },
            'Related faculty: lookup results'
        );

        const facultyByExpertId = new Map();
        const scopusToExpertId = new Map();
        const kerberosToExpertId = new Map();

        for (const f of scopusFacultyDocs) {
            facultyByExpertId.set(f.expert_id, f);
            for (const sid of f.scopus_id || []) scopusToExpertId.set(String(sid).trim(), f.expert_id);
        }
        for (const f of kerberosFacultyDocs) {
            facultyByExpertId.set(f.expert_id, f);
            const k = (f.email || '').split('@')[0].toLowerCase();
            if (k) kerberosToExpertId.set(k, f.expert_id);
            for (const sid of f.scopus_id || []) scopusToExpertId.set(String(sid).trim(), f.expert_id);
        }

        const facultyPaperSets = new Map();
        for (let i = 0; i < results.length; i++) {
            const doc = results[i];
            const docKey = doc._id?.toString() || String(i);
            const matched = new Set();

            for (const a of doc.authors || []) {
                const aid = a?.author_id != null ? String(a.author_id).trim() : '';
                if (!aid) continue;
                const eid = scopusToExpertId.get(aid);
                if (eid) matched.add(eid);
            }

            const k = (doc.kerberos || '').trim().toLowerCase();
            if (k) {
                const eid = kerberosToExpertId.get(k);
                if (eid) matched.add(eid);
            }

            for (const eid of matched) {
                if (!facultyPaperSets.has(eid)) facultyPaperSets.set(eid, new Set());
                facultyPaperSets.get(eid).add(docKey);
            }
        }

        const facultyList = [];
        for (const [expertId, paperSet] of facultyPaperSets) {
            const f = facultyByExpertId.get(expertId);
            if (!f) continue;
            facultyList.push({
                _id: f._id,
                name: `${f.firstName} ${f.lastName}`.trim(),
                email: f.email,
                expert_id: f.expert_id,
                department: f.department,
                paperCount: paperSet.size
            });
        }

        return facultyList.sort((a, b) => b.paperCount - a.paperCount);
    }
}
