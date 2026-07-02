import fs from 'node:fs';
import { parse } from 'csv-parse/sync';

/**
 * Reads and validates the ML classification CSV.
 * Single responsibility: file -> validated row objects. No resolution logic.
 */

// MongoDB_ID is the document's own _id — the direct foreign key into
// ResearchMetaDataScopus. Kerberos is carried in the header for lineage but
// is empty on every row in this CSV generation; it is not used for matching.
export const REQUIRED_COLUMNS = [
    'Title', 'MongoDB_ID', 'Broad_Theme', 'L1_Score', 'L1_Confidence',
    'IITD_Department', 'Domain', 'Sub_Domain', 'L3_Score',
    'L3_Confidence', 'Topic'
];

export function readClassificationCsv(csvPath) {
    const raw = fs.readFileSync(csvPath, 'utf8');
    const rows = parse(raw, {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });

    if (rows.length === 0) {
        throw new Error(`CSV at ${csvPath} has no data rows`);
    }

    const missing = REQUIRED_COLUMNS.filter(c => !(c in rows[0]));
    if (missing.length > 0) {
        throw new Error(`CSV at ${csvPath} is missing expected columns: ${missing.join(', ')}`);
    }

    return rows;
}
