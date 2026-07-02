/**
 * Builds the iitd_authors[] subdocuments for one paper — the write-time union
 * of the two resolutions ResultHydrator otherwise re-derives on every search:
 *   (a) kerberos side: the document's own `kerberos` field -> Faculty by email prefix
 *   (b) scopus side: the document's authors[].author_id -> Faculty.scopus_id
 * Both are read from the matched Mongo document itself — the classification
 * CSV carries no per-author kerberos anymore. Deduped by faculty; an author
 * matched by both paths gets matched_via 'both'.
 */
export default class IitdAuthorsBuilder {
    constructor({ facultyResolver, departmentResolver }) {
        this.facultyResolver = facultyResolver;
        this.departmentResolver = departmentResolver;
        this.stats = { faculty: 0, csv_fallback: 0, null_department: 0 };
    }

    /**
     * @param {string} paperKerberos the document's own `kerberos` field
     * @param {string[]} scopusAuthorIds the document's authors[].author_id
     * @param {string} fallbackDepartmentName raw IITD_Department string from the
     *   CSV's winning row, used only when paperKerberos doesn't resolve to a Faculty
     * @returns {object[]} iitd_authors subdocuments
     */
    build(paperKerberos, scopusAuthorIds, fallbackDepartmentName) {
        const byFacultyId = new Map(); // faculty _id string -> entry
        let kerberosOnlyEntry = null; // set when the doc's own kerberos has no Faculty match

        const kerberos = String(paperKerberos || '').toLowerCase().trim();
        if (kerberos) {
            const faculty = this.facultyResolver.resolveByKerberos(kerberos);
            if (faculty) {
                byFacultyId.set(String(faculty._id), {
                    kerberos,
                    faculty_ref: faculty._id,
                    department_ref: faculty.department || null,
                    matched_via: 'kerberos',
                    department_source: 'faculty'
                });
                this.stats.faculty++;
            } else {
                const dept = this.departmentResolver.resolveByName(fallbackDepartmentName);
                kerberosOnlyEntry = {
                    kerberos,
                    faculty_ref: null,
                    department_ref: dept ? dept._id : null,
                    matched_via: 'kerberos',
                    department_source: 'csv_fallback'
                };
                this.stats.csv_fallback++;
                if (!dept) this.stats.null_department++;
            }
        }

        for (const authorId of scopusAuthorIds) {
            const faculty = this.facultyResolver.resolveByScopusId(authorId);
            if (!faculty) continue;

            const id = String(faculty._id);
            const existing = byFacultyId.get(id);
            if (existing) {
                existing.matched_via = 'both';
                continue;
            }
            const facultyKerberos = String(faculty.email || '').split('@')[0].toLowerCase().trim() || null;
            // The scopus match may resolve the same faculty already recorded as
            // a no-faculty fallback entry (kerberos didn't match by email but
            // the author id did) — prefer the resolved entry over the fallback.
            if (facultyKerberos && kerberosOnlyEntry?.kerberos === facultyKerberos) kerberosOnlyEntry = null;
            byFacultyId.set(id, {
                kerberos: facultyKerberos,
                faculty_ref: faculty._id,
                department_ref: faculty.department || null,
                matched_via: 'scopus_id',
                department_source: 'faculty'
            });
        }

        return kerberosOnlyEntry
            ? [...byFacultyId.values(), kerberosOnlyEntry]
            : [...byFacultyId.values()];
    }
}
