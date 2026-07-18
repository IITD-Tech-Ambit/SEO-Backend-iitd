import mongoose from "mongoose";

/**
 * Subdomain — second level of the discipline facet (186 nodes). Each subdomain
 * belongs to exactly one Domain (verified 1:1 in the source classification data;
 * the ingestion script asserts this holds).
 * `stats` is written only by the offline rollup job.
 */
const subdomainSchema = new mongoose.Schema({
    domain_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Domain',
        required: true,
    },
    name: {
        type: String,
        required: true,
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
        updated_at: { type: Date },
    }
}, {
    timestamps: true
});

subdomainSchema.index({ domain_id: 1, name: 1 }, { unique: true });
subdomainSchema.index({ domain_id: 1, display_order: 1 });

export default mongoose.model("Subdomain", subdomainSchema);
