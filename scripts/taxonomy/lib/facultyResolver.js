/**
 * Resolves faculty identity from either side of the authorship join,
 * using maps built once from a single Faculty fetch:
 *  - kerberos = Faculty.email prefix (same derivation ResultHydrator uses)
 *  - Scopus author_id ∈ Faculty.scopus_id[]
 */
export default class FacultyResolver {
    constructor(faculties) {
        this.byKerberos = new Map();
        this.byScopusId = new Map();
        for (const f of faculties) {
            const kerberos = FacultyResolver.kerberosOf(f);
            if (kerberos) this.byKerberos.set(kerberos, f);
            for (const sid of f.scopus_id || []) {
                const key = String(sid ?? '').trim();
                if (key) this.byScopusId.set(key, f);
            }
        }
    }

    static kerberosOf(faculty) {
        return String(faculty.email || '').split('@')[0].toLowerCase().trim() || null;
    }

    resolveByKerberos(kerberos) {
        return this.byKerberos.get(String(kerberos || '').toLowerCase().trim()) || null;
    }

    resolveByScopusId(authorId) {
        return this.byScopusId.get(String(authorId ?? '').trim()) || null;
    }
}
