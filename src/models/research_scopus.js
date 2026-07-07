import mongoose from "mongoose";


/**
 * IITD-faculty authorship, resolved once at write time by the taxonomy ingestion
 * script (scripts/ingest-taxonomy-classification.js) via the union of the two
 * matches ResultHydrator otherwise re-derives per request: kerberos → Faculty.email
 * prefix, and authors[].author_id → Faculty.scopus_id.
 */
const IitdAuthorSchema = new mongoose.Schema({
    kerberos: {
        type: String,
        default: null,
    },
    faculty_ref: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Faculty',
        default: null,
    },
    department_ref: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Department',
        default: null,
    },
    matched_via: {
        type: String,
        enum: ['kerberos', 'scopus_id', 'both'],
        required: true,
    },
    // 'faculty' = department taken from the Faculty record (authoritative);
    // 'csv_fallback' = kerberos had no Faculty record, department resolved
    // from the classification CSV's own department column.
    department_source: {
        type: String,
        enum: ['faculty', 'csv_fallback'],
        required: true,
    }
}, { _id: false });

/**
 * Single-label classification on the two independent browse facets
 * (thematic area, domain/subdomain), assigned by the ML classification
 * pipeline and imported by the ingestion script. Topics are display-only
 * tags, not taxonomy nodes.
 */
const ClassificationSchema = new mongoose.Schema({
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
    topics: [{
        type: String,
    }],
    classified_at: {
        type: Date,
    }
}, { _id: false });

const AuthorSchema = new mongoose.Schema({
    author_id: {
        type: String,
        required: true,
    },
    author_position: {
        type: String,
    },
    author_name: {
        type: String,
        required: true
    },
    author_avaialable_names: [{
        type: String,
    }]
})

const ResearchMetaDataScopus = new mongoose.Schema({
    document_eid: {
        type: String,
        required: true,
        unique: true
    },
    document_scopus_id: {
        type: String,
        required: true,
        unique: true
    },
    link: {
        type: String,
    },
    publication_year: {
        type: Number,
    },
    document_type: {
        type: String,
    },
    citation_count: {
        type: Number,
    },
    reference_count: {
        type: Number,
    },
    title: {
        type: String,
        required: true
    },
    abstract: {
        type: String,
        required: true
    },
    field_associated: {
        type: String,
    },
    subject_area: [{
        type: String,
    }],
    authors: [AuthorSchema],
    kerberos:{
        type: String,
        required: true,
    },
    // Resolved IITD authorship + taxonomy classification (set by the ingestion
    // script; absent on papers not covered by the classification snapshot)
    iitd_authors: [IitdAuthorSchema],
    classification: ClassificationSchema,
    open_search_id: {
        type: String,
        required: true,
        unique: true
    }
}, {
    timestamps: true
});

// === INDEXES ===

// 1. Primary filter compound index (handles year + department + type queries)
ResearchMetaDataScopus.index({
    publication_year: -1,
    field_associated: 1,
    document_type: 1
});

// 2. Author-based queries (getDocumentsByAuthor matches + sorts publication_year)
ResearchMetaDataScopus.index({ "authors.author_id": 1, publication_year: -1 });

// 3. Subject area filtering
ResearchMetaDataScopus.index({ subject_area: 1, publication_year: -1 });

// 4. Citation-based sorting
ResearchMetaDataScopus.index({ citation_count: -1 });

// 5. Kerberos-based sorting (getDocumentsByAuthor matches + sorts publication_year)
ResearchMetaDataScopus.index({ kerberos: 1, publication_year: -1 });

// 5. Text index for fallback keyword search
ResearchMetaDataScopus.index(
    { title: "text", abstract: "text" },
    { weights: { title: 10, abstract: 1 }, name: "text_search_fallback" }
);

// 6. Resolved IITD authorship lookups. The kerberos one carries
// publication_year/citation_count as trailing keys since findPapersInContext
// (TaxonomyRepository) matches on kerberos alone (no theme/domain/subdomain
// filter) and sorts by both — without the trailing keys that fell back to
// an in-memory sort per request.
ResearchMetaDataScopus.index({ "iitd_authors.faculty_ref": 1 });
ResearchMetaDataScopus.index({ "iitd_authors.kerberos": 1, publication_year: -1, citation_count: -1 });
ResearchMetaDataScopus.index({ "iitd_authors.department_ref": 1 });

// 7. Taxonomy browse — department-filtered live queries per facet level
ResearchMetaDataScopus.index({ "classification.thematic_area_id": 1, "iitd_authors.department_ref": 1 });
ResearchMetaDataScopus.index({ "classification.domain_id": 1, "iitd_authors.department_ref": 1 });
ResearchMetaDataScopus.index({ "classification.subdomain_id": 1, "iitd_authors.department_ref": 1 });

// 8. Faculty-papers-in-taxonomy-context (kerberos-keyed, matching the browse
// flow) — trailing publication_year/citation_count cover findPapersInContext's
// sort so it doesn't fall back to an in-memory sort after the index match.
ResearchMetaDataScopus.index({ "classification.thematic_area_id": 1, "iitd_authors.kerberos": 1, publication_year: -1, citation_count: -1 });
ResearchMetaDataScopus.index({ "classification.domain_id": 1, "iitd_authors.kerberos": 1, publication_year: -1, citation_count: -1 });
ResearchMetaDataScopus.index({ "classification.subdomain_id": 1, "iitd_authors.kerberos": 1, publication_year: -1, citation_count: -1 });

export default mongoose.model("ResearchMetaDataScopus", ResearchMetaDataScopus);
