/**
 * MongoDB data access for the taxonomy read path. Every method is a lookup
 * against precomputed rollup collections, except findPapersInContext which is
 * a live — but tightly indexed — query on the papers collection.
 *
 * The facet cube stores one row per exact configuration; null in a dimension
 * means "not part of this configuration", so every filter here pins ALL four
 * dimensions (to a value or to null) and hits the unique compound index.
 */
export default class TaxonomyRepository {
    constructor({ mongoose }) {
        this.mongoose = mongoose;
    }

    get _counts() { return this.mongoose.model('TaxonomyFacetCounts'); }
    get _members() { return this.mongoose.model('TaxonomyFacetMembers'); }
    get _papers() { return this.mongoose.model('ResearchMetaDataScopus'); }

    listThemeCounts({ departmentId }) {
        return this._counts.find({
            thematic_area_id: { $ne: null },
            domain_id: null,
            subdomain_id: null,
            department_id: departmentId
        }).lean();
    }

    listDomainCounts({ themeId, departmentId }) {
        return this._counts.find({
            thematic_area_id: themeId,
            domain_id: { $ne: null },
            subdomain_id: null,
            department_id: departmentId
        }).lean();
    }

    listSubdomainCounts({ domainId, themeId, departmentId }) {
        return this._counts.find({
            thematic_area_id: themeId,
            domain_id: domainId,
            subdomain_id: { $ne: null },
            department_id: departmentId
        }).lean();
    }

    /** Departments that actually appear in the cube (i.e. have classified papers). */
    async listDepartmentsWithPapers() {
        return this._counts.aggregate([
            { $match: { department_id: { $ne: null } } },
            {
                $group: {
                    _id: '$department_id',
                    name: { $first: '$department_name' },
                    code: { $first: '$department_code' }
                }
            },
            { $sort: { name: 1 } }
        ]);
    }

    getConfigCounts({ themeId, domainId, subdomainId, departmentId }) {
        return this._counts.findOne({
            thematic_area_id: themeId,
            domain_id: domainId,
            subdomain_id: subdomainId,
            department_id: departmentId
        }).lean();
    }

    getConfigMembers({ themeId, domainId, subdomainId, departmentId }) {
        return this._members.findOne({
            thematic_area_id: themeId,
            domain_id: domainId,
            subdomain_id: subdomainId,
            department_id: departmentId
        }).lean();
    }

    async findPapersInContext({ themeId, domainId, subdomainId, kerberos, page, perPage }) {
        const filter = { 'iitd_authors.kerberos': kerberos };
        if (themeId) filter['classification.thematic_area_id'] = themeId;
        if (subdomainId) filter['classification.subdomain_id'] = subdomainId;
        else if (domainId) filter['classification.domain_id'] = domainId;

        const [items, total] = await Promise.all([
            this._papers.find(filter)
                .select('title abstract link publication_year document_type citation_count classification.topics')
                .sort({ publication_year: -1, citation_count: -1 })
                .skip((page - 1) * perPage)
                .limit(perPage)
                .lean(),
            this._papers.countDocuments(filter)
        ]);
        return { items, total };
    }
}
