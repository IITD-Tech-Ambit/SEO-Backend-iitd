import mongoose from "mongoose";


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

// 2. Author-based queries
ResearchMetaDataScopus.index({ "authors.author_id": 1 });

// 3. Subject area filtering
ResearchMetaDataScopus.index({ subject_area: 1, publication_year: -1 });

// 4. Citation-based sorting
ResearchMetaDataScopus.index({ citation_count: -1 });

// 5. Kerberos-based sorting
ResearchMetaDataScopus.index({ kerberos: 1 });

// 5. Text index for fallback keyword search
ResearchMetaDataScopus.index(
    { title: "text", abstract: "text" },
    { weights: { title: 10, abstract: 1 }, name: "text_search_fallback" }
);

export default mongoose.model("ResearchMetaDataScopus", ResearchMetaDataScopus);
