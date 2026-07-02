import mongoose from "mongoose";

/**
 * Taxonomy facet-counts cube — one row per browse configuration that has papers.
 *
 * Theme and Domain/Subdomain are independent axes the user can combine, and
 * faculty_count is a distinct-count (never summable from finer cells), so every
 * supported filter configuration is precomputed as its own row by the rollup job:
 *   (T), (D), (D,S), (T,D), (T,D,S) — each with department_id set or null.
 *
 * Null means "not part of this configuration". A missing row means zero papers
 * for that configuration — no zero rows are ever written, so read paths need
 * no hiding logic.
 */
const taxonomyFacetCountsSchema = new mongoose.Schema({
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
    // Non-null subdomain_id always has its parent domain_id set too
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
    department_name: {
        type: String,
        default: null,
    },
    department_code: {
        type: String,
        default: null,
    },
    paper_count: {
        type: Number,
        default: 0,
    },
    // True distinct faculty count for this configuration, computed independently
    // of paper_count — never derived by summing other rows.
    faculty_count: {
        type: Number,
        default: 0,
    },
    updated_at: {
        type: Date,
    }
});

// === INDEXES ===
// Point lookup for any exact browse configuration
taxonomyFacetCountsSchema.index(
    { thematic_area_id: 1, domain_id: 1, subdomain_id: 1, department_id: 1 },
    { unique: true }
);
// List screens: all rows of one mask level in a single query
taxonomyFacetCountsSchema.index({ domain_id: 1, department_id: 1 });
taxonomyFacetCountsSchema.index({ thematic_area_id: 1, department_id: 1 });

export default mongoose.model("TaxonomyFacetCounts", taxonomyFacetCountsSchema);
