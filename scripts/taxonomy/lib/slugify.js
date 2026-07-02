/**
 * Slug generation for taxonomy node names.
 * Pure functions — no I/O, no state.
 */

/**
 * "AI/ML, Supercomputing & Quantum Computing" -> "ai-ml-supercomputing-quantum-computing"
 */
export function slugify(name) {
    return String(name)
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Slugify a list of names, guaranteeing uniqueness within the list by
 * suffixing -2, -3, ... on collisions (defensive only — node names are
 * unique per collection, so collisions imply two names slugging identically).
 * Returns Map<name, slug>.
 */
export function slugifyUnique(names) {
    const used = new Set();
    const byName = new Map();
    for (const name of names) {
        const base = slugify(name);
        let slug = base;
        let n = 2;
        while (used.has(slug)) {
            slug = `${base}-${n++}`;
        }
        used.add(slug);
        byName.set(name, slug);
    }
    return byName;
}
