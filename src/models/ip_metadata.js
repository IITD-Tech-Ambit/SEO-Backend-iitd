import mongoose from "mongoose";
import crypto from "crypto";

/**
 * Unique negative-number string used to seed `open_search_id` before a document
 * is indexed. Mirrors negative_opensearch_id() in
 * workers/data_pipeline/domain/transform.py: a 63-bit negative integer keeps the
 * unique index satisfied while marking the document as "not yet indexed". The
 * OpenSearch indexer overwrites this with the real (positive) id after indexing.
 */
export function negativeOpenSearchId() {
    const magnitude = crypto.randomBytes(8).readBigUInt64BE() >> 1n;
    return String(-(magnitude + 1n));
}

/**
 * Inventor on an IP filing. Index 0 is always the primary inventor (population invariant).
 * Faculty inventors use Faculty display `name` via kerberos; `raw_name` keeps the source spelling.
 */
const InventorSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    is_faculty: {
        type: Boolean,
        required: true,
        default: false,
    },
    kerberos: {
        type: String,
        default: null,
    },
    faculty_ref: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Faculty',
        default: null,
    },
    raw_name: {
        type: String,
    },
    address: {
        type: String,
    },
}, { _id: false });

const IPMetaData = new mongoose.Schema({
    application_number: {
        type: String,
        required: true,
        unique: true,
    },
    title: {
        type: String,
        required: true,
    },
    abstract: {
        type: String,
    },
    type_of_ip: {
        type: String,
        required: true,
        index: true,
    },
    department: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Department',
        index: true,
    },
    field_of_invention: {
        type: String,
    },
    classification: [{
        type: String,
    }],
    filing_date: {
        type: Date,
    },
    publication_date: {
        type: Date,
        default: null,
    },
    // Derived from publication_date at write time; stored and indexed to power
    // cheap year sort/filter without a $year aggregation per query.
    publication_year: {
        type: Number,
    },
    // Filing jurisdiction (e.g. "IN"), from application-number prefix / IpCategory.
    country: {
        type: String,
        index: true,
    },
    // Reserved for future legal status (e.g. published/granted); not populated yet.
    application_status: {
        type: String,
        default: null,
    },
    inventors: [InventorSchema],
    // Applicant names (typically the institute name).
    applicants: [{
        type: String,
    }],
    open_search_id: {
        type: String,
        required: true,
        unique: true,
        default: negativeOpenSearchId,
    },
}, {
    timestamps: true,
});

IPMetaData.index({ publication_year: -1, field_of_invention: 1, type_of_ip: 1 });

IPMetaData.index({ department: 1, publication_year: -1 });

IPMetaData.index({ "inventors.kerberos": 1, publication_year: -1 });

IPMetaData.index({ "inventors.faculty_ref": 1 });

IPMetaData.index({ type_of_ip: 1, filing_date: -1 });

IPMetaData.index({ country: 1, publication_year: -1 });

IPMetaData.index({ classification: 1 });

IPMetaData.index(
    { title: "text", abstract: "text" },
    { weights: { title: 10, abstract: 1 }, name: "ip_text_search_fallback" }
);

export default mongoose.model("IPMetaData", IPMetaData);
