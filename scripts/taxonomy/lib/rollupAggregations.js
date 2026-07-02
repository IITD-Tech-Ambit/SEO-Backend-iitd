/**
 * Pure aggregation-pipeline builders for the taxonomy rollup job.
 * No I/O — every function takes a mask (the classification fields that define
 * one browse configuration) and returns a MongoDB pipeline.
 *
 * Masks used by the rollup: ['thematic_area_id'], ['domain_id'],
 * ['domain_id','subdomain_id'], ['thematic_area_id','domain_id'],
 * ['thematic_area_id','domain_id','subdomain_id'] — each run with and
 * without the department dimension.
 *
 * paper_count and faculty_count are distinct-counts computed with the
 * two-stage $group idiom (dedupe first, count second): a paper with two
 * co-authors in the same department must count once, and counts are never
 * derived by summing other rows.
 *
 * Faculty identity is the kerberos of iitd_authors entries with a resolved
 * faculty_ref — entries without a Faculty record are excluded everywhere
 * (they cannot be counted as faculty nor rendered by the directory API).
 */

export const MASKS = [
    ['thematic_area_id'],
    ['domain_id'],
    ['domain_id', 'subdomain_id'],
    ['thematic_area_id', 'domain_id'],
    ['thematic_area_id', 'domain_id', 'subdomain_id'],
];

function maskMatch(mask) {
    const match = {};
    for (const field of mask) match[`classification.${field}`] = { $ne: null };
    return match;
}

function maskKey(mask, from = '$classification.') {
    const key = {};
    for (const field of mask) key[field] = `${from}${field}`;
    return key;
}

function liftMaskFromId(mask) {
    const key = {};
    for (const field of mask) key[field] = `$_id.${field}`;
    return key;
}

export function paperCountPipeline(mask, withDepartment) {
    if (!withDepartment) {
        return [
            { $match: maskMatch(mask) },
            { $group: { _id: maskKey(mask), paper_count: { $sum: 1 } } }
        ];
    }
    return [
        { $match: maskMatch(mask) },
        { $unwind: '$iitd_authors' },
        { $match: { 'iitd_authors.department_ref': { $ne: null } } },
        {
            $group: {
                _id: {
                    ...maskKey(mask),
                    department_id: '$iitd_authors.department_ref',
                    paper: '$_id'
                }
            }
        },
        {
            $group: {
                _id: { ...liftMaskFromId(mask), department_id: '$_id.department_id' },
                paper_count: { $sum: 1 }
            }
        }
    ];
}

export function facultyCountPipeline(mask, withDepartment) {
    const authorMatch = { 'iitd_authors.faculty_ref': { $ne: null } };
    if (withDepartment) authorMatch['iitd_authors.department_ref'] = { $ne: null };

    const dedupeKey = { ...maskKey(mask), kerberos: '$iitd_authors.kerberos' };
    const regroupKey = liftMaskFromId(mask);
    if (withDepartment) {
        dedupeKey.department_id = '$iitd_authors.department_ref';
        regroupKey.department_id = '$_id.department_id';
    }

    return [
        { $match: maskMatch(mask) },
        { $unwind: '$iitd_authors' },
        { $match: authorMatch },
        { $group: { _id: dedupeKey } },
        { $group: { _id: regroupKey, faculty_count: { $sum: 1 } } }
    ];
}

export function membersPipeline(mask, withDepartment) {
    const authorMatch = { 'iitd_authors.faculty_ref': { $ne: null } };
    if (withDepartment) authorMatch['iitd_authors.department_ref'] = { $ne: null };

    const groupKey = maskKey(mask);
    if (withDepartment) groupKey.department_id = '$iitd_authors.department_ref';

    return [
        { $match: maskMatch(mask) },
        { $unwind: '$iitd_authors' },
        { $match: authorMatch },
        { $group: { _id: groupKey, kerberos_set: { $addToSet: '$iitd_authors.kerberos' } } }
    ];
}
