import mongoose from "mongoose";

const facultySchema = new mongoose.Schema({
    //Unique Identifiers...
    expert_id:{
        type:String,
        required:true,
        unique:true
    },
    experience_id:{
        type:String,
        required:true,
        unique:true
    },
    qualification_id:{
        type:String,
    },
    //Personal Info...
    title:{
        type:String,
        required:true
    },
    firstName:{
        type:String,
        required:true
    },
    lastName:{
        type:String,
        required:true
    },
    email:{
        type:String,
        required:true,
    },
    gender:{
        type:String,
        enum:['Male','Female','Other'],
        required:true
    },
    department:{
        type:mongoose.Schema.Types.ObjectId,
        ref:'Department',
        required:true
    },
    profile_image_url:{
        type:String,
    },
    //Professional Info...
    designation:{
        type:String,
    },
    working_from_year:{
        type:Number,
    },
    expertise_id:{
        type:"String",
    },
    subject:{
        type:String,
    },
    h_index:{
        type:Number,
    },
    citation_count:{
        type:Number,
    },
    wos_subjects:[String],
    expertise:[String],
    brief_expertise:[String],
    subjects:[String],

    // Precomputed dominant taxonomy Domains for this faculty (Pareto/coverage
    // cutoff over classification.domain_id paper counts), written once by
    // scripts/taxonomy/populateFacultyDomains.js. Read directly by the
    // directory API — no live aggregation.
    dominant_domains: [{
        domain_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Domain' },
        name: String,
        slug: String,
        paper_count: Number,
        _id: false
    }],
    dominant_domains_updated_at: { type: Date },

    //Research Identifiers...
    orcid_id:[String],
    researcher_id:[String],
    google_scholar_id:[String],
    scopus_id:[String]
}, {
    timestamps: true
});

// Create text index for full-text search capabilities across multiple string fields
facultySchema.index({
    firstName: 'text',
    lastName: 'text',
    expertise: 'text',
    brief_expertise: 'text',
    subjects: 'text',
    wos_subjects: 'text'
}, {
    name: 'faculty_text_search_index',
    weights: {
        firstName: 10,
        lastName: 10,
        expertise: 5,
        brief_expertise: 5,
        subjects: 3,
        wos_subjects: 3
    }
});

// Index for frequently used non-text queries
facultySchema.index({ department: 1 });
facultySchema.index({ firstName: 1, lastName: 1 });

// This service does $in lookups on scopus_id on every search-result
// hydration — was previously unindexed, forcing a collection scan on
// Faculty's hottest read path from here.
facultySchema.index({ scopus_id: 1 });

// IP-search hydration (ResultHydrator._facultyByKerberos, IpFacultyForQueryService,
// IpSuggestService) resolves faculty by kerberos via anchored email regex ($in of /^k@/i)
// on every patent search/suggest/people-sidebar request — same "hottest read path" shape
// as scopus_id above, previously unindexed.
facultySchema.index({ email: 1 });

export default mongoose.model("Faculty", facultySchema);
