import mongoose from "mongoose";

/**
 * Taxonomy facet-members — precomputed "Browse Faculty" list per browse
 * configuration, keyed by the same nullable 4-tuple as the facet-counts cube.
 *
 * Stores ONLY kerberos IDs (ordered by paper_count within this combination,
 * desc, at rollup time). The frontend resolves cards/profiles through the
 * existing directory API by kerberos — no faculty display data is
 * duplicated here.
 */
const taxonomyFacetMembersSchema = new mongoose.Schema({
    thematic_area_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ThematicArea',
        default: null,
    },
    domain_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Domain',
        default: null,
    },
    subdomain_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Subdomain',
        default: null,
    },
    // null = all departments (unfiltered view)
    department_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Department',
        default: null,
    },
    // Ordered by h_index desc at rollup time; capped defensively (see rollup job)
    kerberos_list: [{
        type: String,
    }],
    // True count before capping, so the UI can paginate / show "+N more"
    faculty_total: {
        type: Number,
        default: 0,
    },
    // How many of kerberos_list to show by default before a "Show all"
    // action is needed — a per-combination statistical cutoff, not a fixed
    // page size (see scripts/taxonomy/lib/recommendedCount.js)
    recommended_count: {
        type: Number,
        default: 0,
    },
    updated_at: {
        type: Date,
    }
});

taxonomyFacetMembersSchema.index(
    { thematic_area_id: 1, domain_id: 1, subdomain_id: 1, department_id: 1 },
    { unique: true }
);

export default mongoose.model("TaxonomyFacetMembers", taxonomyFacetMembersSchema);
