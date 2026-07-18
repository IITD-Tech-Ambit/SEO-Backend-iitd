import mongoose from "mongoose";

/**
 * Thematic Area — top-level browse facet (9 fixed strategic themes).
 *
 * Independent of the Domain/Subdomain axis: a paper carries one thematic area
 * AND one domain/subdomain, but themes are not parents of domains.
 * `stats` is written only by the offline rollup job (scripts/taxonomy/rollup.js);
 * read paths never compute it.
 */
const thematicAreaSchema = new mongoose.Schema({
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
        updated_at: { type: Date },
    }
}, {
    timestamps: true
});

thematicAreaSchema.index({ display_order: 1 });

export default mongoose.model("ThematicArea", thematicAreaSchema);
