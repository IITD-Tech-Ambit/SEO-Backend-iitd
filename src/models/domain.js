import mongoose from "mongoose";

/**
 * Domain — top level of the discipline facet (35 nodes). Subdomains nest under
 * a Domain via Subdomain.domain_id; Domains do NOT nest under Thematic Areas
 * (the two facets are independent classification axes on each paper).
 * `stats` is written only by the offline rollup job.
 */
const domainSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true,
    },
    slug: {
        type: String,
        required: true,
        unique: true,
    },
    display_order: {
        type: Number,
        default: 0,
    },
    stats: {
        paper_count: { type: Number, default: 0 },
        faculty_count: { type: Number, default: 0 },
        subdomain_count: { type: Number, default: 0 },
        updated_at: { type: Date },
    }
}, {
    timestamps: true
});

// === INDEXES ===
domainSchema.index({ display_order: 1 });

export default mongoose.model("Domain", domainSchema);
