/**
 * Resolves raw department-name strings (from the classification CSV) to
 * Department documents, using maps built once from a single DB fetch —
 * never per-row lookups. `code` (indexed, unique) is the canonical key.
 */
export default class DepartmentResolver {
    // Verified naming variants in the CSV that differ from Department.name.
    // Keys are lowercased/trimmed CSV values, values are Department.code.
    static ALIASES = new Map([
        ['energy science and engineering', 'dese'],
        ['centre for rural development and technology', 'rdat'],
    ]);

    constructor(departments) {
        this.byCode = new Map();
        this.byName = new Map();
        for (const d of departments) {
            if (d.code) this.byCode.set(String(d.code).toLowerCase().trim(), d);
            if (d.name) this.byName.set(String(d.name).toLowerCase().trim(), d);
        }
        // rawName -> hit count, for the final report
        this.unresolved = new Map();
    }

    /**
     * @param {string} rawName department name as it appears in the CSV
     * @returns {object|null} Department document, or null if unresolvable
     */
    resolveByName(rawName) {
        const key = String(rawName || '').toLowerCase().trim();
        if (!key) return null;

        const aliasCode = DepartmentResolver.ALIASES.get(key);
        const dept = aliasCode ? this.byCode.get(aliasCode) : this.byName.get(key);
        if (dept) return dept;

        this.unresolved.set(rawName, (this.unresolved.get(rawName) || 0) + 1);
        return null;
    }

    unresolvedReport() {
        return [...this.unresolved.entries()].map(([name, rows]) => ({ name, rows }));
    }
}
