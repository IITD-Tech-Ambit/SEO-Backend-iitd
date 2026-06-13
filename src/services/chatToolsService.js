/**
 * Chat Tools Service
 * Tool definitions + executors for the agentic chatbot. The LLM picks a tool,
 * we run it against OpenSearch / MongoDB, and feed the JSON result back.
 */

const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'search_papers',
            description: 'Semantic search over IIT Delhi research papers. Use for questions about research content, findings, or specific topics, e.g. "what research exists on solar cells".',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The research topic or question to search for' },
                    year_from: { type: 'integer', description: 'Only include papers published in or after this year' },
                    year_to: { type: 'integer', description: 'Only include papers published in or before this year' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'find_faculty_for_topic',
            description: 'Find IIT Delhi professors/faculty who work on a given research topic, with their department, email and number of relevant papers. Use for questions like "which professor works on X" or "who should I contact about Y".',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: 'The research topic to find faculty for' }
                },
                required: ['topic']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_faculty_profile',
            description: 'Look up a specific IIT Delhi professor by name: their email, department, designation, areas of expertise, and publication statistics (paper counts, top subjects, most cited papers). Use for questions about a named professor.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The professor\'s name (with or without titles like Prof./Dr.)' }
                },
                required: ['name']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_publication_stats',
            description: 'Get publication count statistics, optionally for one department and/or a year range. Use for questions like "how many papers did Civil Engineering publish", "publications per year", or "which department publishes the most".',
            parameters: {
                type: 'object',
                properties: {
                    department: { type: 'string', description: 'Department name to filter by, e.g. "Civil Engineering"' },
                    year_from: { type: 'integer', description: 'Start year (inclusive)' },
                    year_to: { type: 'integer', description: 'End year (inclusive)' },
                    group_by: {
                        type: 'string',
                        enum: ['department', 'year', 'document_type'],
                        description: 'Group counts by this dimension when no single department is asked for'
                    }
                }
            }
        }
    }
];

const TOOL_STATUS = {
    search_papers: 'Searching publications...',
    find_faculty_for_topic: 'Finding relevant faculty...',
    get_faculty_profile: 'Looking up faculty profile...',
    get_publication_stats: 'Computing statistics...'
};

export default class ChatToolsService {
    constructor(fastify, config) {
        this.fastify = fastify;
        this.mongoose = fastify.mongoose;
        this.logger = fastify.log;
        this.config = config;
    }

    get definitions() {
        return TOOL_DEFINITIONS;
    }

    statusFor(toolName) {
        return TOOL_STATUS[toolName] || 'Working...';
    }

    /**
     * Execute one tool call. Returns { result, sources }.
     * `result` is the compact JSON object given to the LLM;
     * `sources` (papers) is sent to the UI when present.
     */
    async execute(name, args = {}) {
        switch (name) {
            case 'search_papers': return this._searchPapers(args);
            case 'find_faculty_for_topic': return this._findFacultyForTopic(args);
            case 'get_faculty_profile': return this._getFacultyProfile(args);
            case 'get_publication_stats': return this._getPublicationStats(args);
            default:
                return { result: { error: `Unknown tool: ${name}` } };
        }
    }

    async _searchPapers({ query, year_from, year_to }) {
        let papers = await this.fastify.ragService.retrieve(query);

        if (year_from) papers = papers.filter(p => p.publication_year == null || p.publication_year >= year_from);
        if (year_to) papers = papers.filter(p => p.publication_year == null || p.publication_year <= year_to);
        papers = papers.map((p, i) => ({ ...p, index: i + 1 }));

        const result = {
            papers: papers.map(p => ({
                citation_index: p.index,
                title: p.title,
                authors: p.authors,
                year: p.publication_year,
                field: p.field_associated,
                citations: p.citation_count,
                abstract: p.abstract.length > 1200 ? `${p.abstract.slice(0, 1200)}...` : p.abstract
            }))
        };
        return { result, sources: papers };
    }

    async _findFacultyForTopic({ topic }) {
        const agg = await this.fastify.searchService.getAllFacultyForQuery(topic);

        // Flatten departments -> faculty, keep the most relevant ones
        const flat = [];
        for (const dept of agg.departments || []) {
            for (const f of dept.faculty || []) {
                flat.push({ ...f, department: dept.name });
            }
        }
        flat.sort((a, b) => b.relevance_score - a.relevance_score);
        const top = flat.slice(0, 10);

        // Enrich with email / designation / expertise from the Faculty collection
        const Faculty = this.mongoose.model('Faculty');
        const facultyDocs = await Faculty.find({ expert_id: { $in: top.map(f => f.author_id) } })
            .populate('department', 'name')
            .select('expert_id title firstName lastName email designation department expertise brief_expertise h_index citation_count')
            .lean();
        const byExpertId = new Map(facultyDocs.map(d => [d.expert_id, d]));

        const faculty = top.map(f => {
            const doc = byExpertId.get(f.author_id);
            return {
                name: doc ? `${doc.title || ''} ${doc.firstName} ${doc.lastName}`.trim() : f.name,
                department: doc?.department?.name || f.department,
                designation: doc?.designation || null,
                email: doc?.email || null,
                expertise: (doc?.brief_expertise?.length ? doc.brief_expertise : doc?.expertise || []).slice(0, 6),
                relevant_paper_count: f.paper_count,
                h_index: doc?.h_index ?? null
            };
        });

        return {
            result: {
                topic,
                total_matching_papers: agg.total_matching_papers,
                faculty
            }
        };
    }

    async _getFacultyProfile({ name }) {
        const Faculty = this.mongoose.model('Faculty');
        const cleaned = String(name || '')
            .replace(/\b(prof\.?|professor|dr\.?|mr\.?|ms\.?|mrs\.?)\b/gi, '')
            .trim();
        if (!cleaned) return { result: { error: 'No name provided' } };

        // Text-index search first, regex on name parts as fallback
        let matches = await Faculty.find(
            { $text: { $search: cleaned } },
            { score: { $meta: 'textScore' } }
        )
            .sort({ score: { $meta: 'textScore' } })
            .limit(3)
            .populate('department', 'name')
            .lean();

        if (!matches.length) {
            const tokens = cleaned.split(/\s+/).filter(t => t.length >= 2);
            if (tokens.length) {
                const regexes = tokens.map(t => new RegExp(t, 'i'));
                matches = await Faculty.find({
                    $or: [
                        { firstName: { $in: regexes } },
                        { lastName: { $in: regexes } }
                    ]
                })
                    .limit(3)
                    .populate('department', 'name')
                    .lean();
            }
        }

        if (!matches.length) {
            return { result: { error: `No IIT Delhi faculty found matching "${name}". The person may not be in the directory.` } };
        }

        const f = matches[0];
        const kerberos = (f.email || '').split('@')[0].toLowerCase();
        const scopusIds = (f.scopus_id || []).map(String);

        const orClauses = [];
        if (kerberos) orClauses.push({ kerberos });
        if (scopusIds.length) orClauses.push({ 'authors.author_id': { $in: scopusIds } });

        let stats = null;
        if (orClauses.length) {
            const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');
            const match = { $or: orClauses };

            const [totalPapers, byYear, topSubjects, topFields, topPapers] = await Promise.all([
                ResearchDocument.countDocuments(match),
                ResearchDocument.aggregate([
                    { $match: match },
                    { $group: { _id: '$publication_year', count: { $sum: 1 } } },
                    { $sort: { _id: -1 } },
                    { $limit: 8 }
                ]),
                ResearchDocument.aggregate([
                    { $match: match },
                    { $unwind: '$subject_area' },
                    { $group: { _id: '$subject_area', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                    { $limit: 8 }
                ]),
                ResearchDocument.aggregate([
                    { $match: match },
                    { $group: { _id: '$field_associated', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                    { $limit: 5 }
                ]),
                ResearchDocument.find(match)
                    .sort({ citation_count: -1 })
                    .limit(5)
                    .select('title publication_year citation_count')
                    .lean()
            ]);

            stats = {
                total_papers: totalPapers,
                papers_by_recent_year: byYear.map(b => ({ year: b._id, count: b.count })),
                top_subject_areas: topSubjects.filter(b => b._id).map(b => ({ subject: b._id, papers: b.count })),
                top_fields: topFields.filter(b => b._id).map(b => ({ field: b._id, papers: b.count })),
                most_cited_papers: topPapers.map(p => ({
                    title: p.title,
                    year: p.publication_year,
                    citations: p.citation_count
                }))
            };
        }

        return {
            result: {
                profile: {
                    name: `${f.title || ''} ${f.firstName} ${f.lastName}`.trim(),
                    email: f.email || null,
                    department: f.department?.name || null,
                    designation: f.designation || null,
                    expertise: (f.brief_expertise?.length ? f.brief_expertise : f.expertise || []).slice(0, 10),
                    subjects: (f.subjects || []).slice(0, 10),
                    h_index: f.h_index ?? null,
                    total_citations: f.citation_count ?? null
                },
                publication_stats: stats,
                other_possible_matches: matches.slice(1).map(m => ({
                    name: `${m.title || ''} ${m.firstName} ${m.lastName}`.trim(),
                    department: m.department?.name || null
                }))
            }
        };
    }

    async _getPublicationStats({ department, year_from, year_to, group_by }) {
        const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');

        const yearMatch = {};
        if (year_from) yearMatch.$gte = year_from;
        if (year_to) yearMatch.$lte = year_to;
        const baseMatch = Object.keys(yearMatch).length ? { publication_year: yearMatch } : {};

        if (department) {
            return { result: await this._departmentStats(department, baseMatch) };
        }

        const dimension = group_by === 'year' ? '$publication_year'
            : group_by === 'document_type' ? '$document_type'
            : '$field_associated';

        const [total, buckets] = await Promise.all([
            ResearchDocument.countDocuments(baseMatch),
            ResearchDocument.aggregate([
                { $match: baseMatch },
                { $group: { _id: dimension, count: { $sum: 1 } } },
                { $sort: group_by === 'year' ? { _id: -1 } : { count: -1 } },
                { $limit: 25 }
            ])
        ]);

        return {
            result: {
                total_papers: total,
                year_from: year_from || null,
                year_to: year_to || null,
                grouped_by: group_by || 'department',
                groups: buckets.filter(b => b._id != null && b._id !== '').map(b => ({
                    [group_by === 'year' ? 'year' : group_by === 'document_type' ? 'type' : 'field']: b._id,
                    papers: b.count
                }))
            }
        };
    }

    /**
     * Stats for one department: resolve via the Department collection -> its
     * faculty -> their papers (by kerberos/scopus id). Falls back to matching
     * the papers' field_associated string when no Department record matches.
     */
    async _departmentStats(department, baseMatch) {
        const Department = this.mongoose.model('Department');
        const Faculty = this.mongoose.model('Faculty');
        const ResearchDocument = this.mongoose.model('ResearchMetaDataScopus');

        const deptRegex = new RegExp(department.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const dept = await Department.findOne({
            $or: [{ name: deptRegex }, { code: deptRegex }]
        }).lean();

        if (dept) {
            const facultyDocs = await Faculty.find({ department: dept._id })
                .select('email scopus_id')
                .lean();

            const kerberosIds = facultyDocs
                .map(f => (f.email || '').split('@')[0].toLowerCase())
                .filter(Boolean);
            const scopusIds = facultyDocs.flatMap(f => (f.scopus_id || []).map(String));

            const orClauses = [];
            if (kerberosIds.length) orClauses.push({ kerberos: { $in: kerberosIds } });
            if (scopusIds.length) orClauses.push({ 'authors.author_id': { $in: scopusIds } });

            if (orClauses.length) {
                const match = { ...baseMatch, $or: orClauses };
                const [total, byYear, byType] = await Promise.all([
                    ResearchDocument.countDocuments(match),
                    ResearchDocument.aggregate([
                        { $match: match },
                        { $group: { _id: '$publication_year', count: { $sum: 1 } } },
                        { $sort: { _id: -1 } },
                        { $limit: 10 }
                    ]),
                    ResearchDocument.aggregate([
                        { $match: match },
                        { $group: { _id: '$document_type', count: { $sum: 1 } } },
                        { $sort: { count: -1 } },
                        { $limit: 8 }
                    ])
                ]);

                return {
                    department: dept.name,
                    faculty_count: facultyDocs.length,
                    total_papers: total,
                    papers_by_recent_year: byYear.map(b => ({ year: b._id, count: b.count })),
                    papers_by_type: byType.filter(b => b._id).map(b => ({ type: b._id, count: b.count }))
                };
            }
        }

        // Fallback: match the papers' field_associated label directly
        const match = { ...baseMatch, field_associated: deptRegex };
        const total = await ResearchDocument.countDocuments(match);
        if (total === 0) {
            return { error: `No department or research field matching "${department}" was found.` };
        }
        const byYear = await ResearchDocument.aggregate([
            { $match: match },
            { $group: { _id: '$publication_year', count: { $sum: 1 } } },
            { $sort: { _id: -1 } },
            { $limit: 10 }
        ]);
        return {
            matched_field: department,
            note: 'Counted by research field label on papers (no exact department record matched)',
            total_papers: total,
            papers_by_recent_year: byYear.map(b => ({ year: b._id, count: b.count }))
        };
    }
}
