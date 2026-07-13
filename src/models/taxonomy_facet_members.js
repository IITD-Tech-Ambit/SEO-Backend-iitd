import mongoose from "mongoose";

/**
 * Taxonomy facet-members — precomputed "Browse Faculty" list per browse
 * configuration, keyed by the same nullable 4-tuple as the facet-counts cube.
 *
 * Stores ONLY kerberos IDs (ordered by h-index at rollup time). The frontend
 * resolves cards/profiles through the existing directory API by kerberos —
 * no faculty display data is duplicated here.
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
    updated_at: {
        type: Date,
    }
});

taxonomyFacetMembersSchema.index(
    { thematic_area_id: 1, domain_id: 1, subdomain_id: 1, department_id: 1 },
    { unique: true }
);

export default mongoose.model("TaxonomyFacetMembers", taxonomyFacetMembersSchema);
