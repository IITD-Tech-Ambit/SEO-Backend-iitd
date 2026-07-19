/**
 * Turns OpenSearch hits into API-ready IP documents: Mongo hydration (hit order preserved),
 * Faculty display-name overlay, related-faculty sidebar, and facet parsing.
 *
 * Faculty/kerberos lives on each inventor (`is_faculty`, `kerberos`) rather than a Scopus-id roster.
 */
export default class ResultHydrator {
    constructor({ mongoose, logger }) {
        this.mongoose = mongoose;
        this.logger = logger;
    }

    parseFacets(aggregations) {
        const buckets = (agg) => agg?.buckets?.map((b) => ({ value: b.key, count: b.doc_count })) || [];
        return {
            years: buckets(aggregations?.years),
            type_of_ip: buckets(aggregations?.type_of_ip),
            field_of_invention: buckets(aggregations?.field_of_invention),
            country: buckets(aggregations?.country),
            classification: buckets(aggregations?.classification)
        };
    }

    async hydrateFromMongoDB(osHits) {
        if (!osHits.length) return [];

        const mongoIds = osHits.map((hit) => hit._source.mongo_id);
        const scoreById = new Map(osHits.map((hit) => [hit._source.mongo_id, hit._score]));
        const IPMetaData = this.mongoose.model('IPMetaData');
        const docs = await IPMetaData.find({ _id: { $in: mongoIds } }).select('-__v').lean();
        const docMap = new Map(docs.map((d) => [d._id.toString(), d]));
        const ordered = mongoIds.map((id) => docMap.get(id)).filter(Boolean);
        // Preserve first-stage score for reranker fusion with the cross-encoder score.
        for (const doc of ordered) {
            const score = scoreById.get(doc._id.toString());
            if (typeof score === 'number') doc._firstStageScore = score;
        }
        return ordered;
    }

    _collectFacultyKerberos(results) {
        const kerberos = new Set();
        for (const doc of results) {
            for (const inv of doc.inventors || []) {
                if (inv?.is_faculty && inv.kerberos && String(inv.kerberos).trim()) {
                    kerberos.add(String(inv.kerberos).trim().toLowerCase());
                }
            }
        }
        return kerberos;
    }

    /** Faculty keyed by lower-cased kerberos (== email prefix). Empty Map on no input / failure. */
    async _facultyByKerberos(kerberosSet) {
        if (!kerberosSet || kerberosSet.size === 0) return new Map();
        const Faculty = this.mongoose.model('Faculty');
        const kerberosArr = [...kerberosSet];
        const docs = await Faculty.find({
            email: { $in: kerberosArr.map((k) => new RegExp(`^${k}@`, 'i')) }
        })
            .populate('department', 'name')
            .select('firstName lastName title email expert_id department')
            .lean();
        const map = new Map();
        for (const f of docs) {
            const k = (f.email || '').split('@')[0].toLowerCase();
            if (k) map.set(k, f);
        }
        return map;
    }

    /** Overlay canonical Faculty directory names onto faculty inventors. Mutates in place. */
    async applyFacultyDisplayNames(results) {
        if (!results?.length) return;
        const kerberosSet = this._collectFacultyKerberos(results);
        if (kerberosSet.size === 0) return;

        const facultyMap = await this._facultyByKerberos(kerberosSet);
        if (facultyMap.size === 0) return;

        for (const doc of results) {
            for (const inv of doc.inventors || []) {
                if (!inv?.is_faculty || !inv.kerberos) continue;
                const f = facultyMap.get(String(inv.kerberos).trim().toLowerCase());
                if (!f) continue;
                const name = [f.title, f.firstName, f.lastName]
                    .filter((p) => p && String(p).trim())
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (name) inv.name = name;
            }
        }
    }

    /** Related-faculty sidebar: unique document counts per faculty inventor kerberos. */
    async extractRelatedFaculty(results) {
        if (!results.length) return [];

        const kerberosSet = this._collectFacultyKerberos(results);
        if (kerberosSet.size === 0) return [];

        const facultyMap = await this._facultyByKerberos(kerberosSet);

        this.logger?.info(
            { uniqueKerberos: kerberosSet.size, matched: facultyMap.size },
            'IP related faculty: lookup results'
        );

        if (facultyMap.size === 0) return [];

        const facultyDocSets = new Map();
        for (let i = 0; i < results.length; i++) {
            const doc = results[i];
            const docKey = doc._id?.toString() || String(i);
            const matched = new Set();
            for (const inv of doc.inventors || []) {
                if (!inv?.is_faculty || !inv.kerberos) continue;
                const k = String(inv.kerberos).trim().toLowerCase();
                if (facultyMap.has(k)) matched.add(k);
            }
            for (const k of matched) {
                if (!facultyDocSets.has(k)) facultyDocSets.set(k, new Set());
                facultyDocSets.get(k).add(docKey);
            }
        }

        const facultyList = [];
        for (const [k, docSet] of facultyDocSets) {
            const f = facultyMap.get(k);
            if (!f) continue;
            facultyList.push({
                _id: f._id,
                name: `${f.firstName} ${f.lastName}`.trim(),
                email: f.email,
                expert_id: f.expert_id,
                kerberos: k,
                department: f.department,
                ipCount: docSet.size
            });
        }

        return facultyList.sort((a, b) => b.ipCount - a.ipCount);
    }
}
