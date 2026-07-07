/**
 * Resolve an author identifier (Scopus author id or Faculty expert_id) to the
 * underlying Faculty record's kerberos + scopus ids. Was previously
 * duplicated near-verbatim in SearchService, FacultyForQueryService,
 * AuthorScopedSearch, and documentController.
 */
export async function resolveFacultyByAuthorId(Faculty, authorId) {
    if (!authorId) return { faculty: null, kerberos: null, scopusIds: [] };

    let faculty = await Faculty.findOne({ scopus_id: authorId }).select('email scopus_id').lean();
    if (!faculty) {
        faculty = await Faculty.findOne({ expert_id: authorId }).select('email scopus_id').lean();
    }

    const kerberos = faculty?.email ? (faculty.email.split('@')[0].trim().toLowerCase() || null) : null;
    const scopusIds = (faculty?.scopus_id || []).map(String).filter(Boolean);

    return { faculty, kerberos, scopusIds };
}
