/**
 * Selects the single winning classification per paper from its CSV row group
 * (rows sharing one MongoDB_ID — the classifier occasionally emits more than
 * one row per document, most visibly for generic titles like "Preface" that
 * collide upstream). Confidence and score are used ONLY here, transiently, to
 * pick the winner — they are never persisted.
 *
 * Theme and Domain/Subdomain are independent axes with independent
 * confidence/score columns (L1 for theme, L3 for sub-domain), so their
 * winners are picked independently and may come from different physical
 * rows. Domain is always taken from the winning subdomain row (Sub_Domain ->
 * Domain is 1:1, asserted at bootstrap). IITD_Department is also taken from
 * the subdomain-winner row, used only as a fallback when the document's own
 * authorship data doesn't resolve a department (see iitdAuthorsBuilder).
 */

const CONFIDENCE_RANK = { HIGH: 2, MEDIUM: 1, LOW: 0 };
const TOPICS_CAP = 25;

function pickWinner(rows, confidenceColumn, scoreColumn) {
    let winner = rows[0];
    let winnerRank = -1;
    let winnerScore = -Infinity;
    for (const row of rows) {
        const rank = CONFIDENCE_RANK[String(row[confidenceColumn] || '').toUpperCase()] ?? 0;
        const score = Number.parseFloat(row[scoreColumn]);
        const safeScore = Number.isFinite(score) ? score : -Infinity;
        // Strict > keeps the earliest row on ties (deterministic, CSV order)
        if (rank > winnerRank || (rank === winnerRank && safeScore > winnerScore)) {
            winner = row;
            winnerRank = rank;
            winnerScore = safeScore;
        }
    }
    return winner;
}

/**
 * @param {object[]} rows all CSV rows sharing one MongoDB_ID
 * @returns {{themeName: string, domainName: string, subdomainName: string, topics: string[], fallbackDepartmentName: string}}
 */
export function selectClassification(rows) {
    const themeRow = pickWinner(rows, 'L1_Confidence', 'L1_Score');
    const subdomainRow = pickWinner(rows, 'L3_Confidence', 'L3_Score');

    const topics = [];
    const seen = new Set();
    for (const row of rows) {
        const topic = String(row.Topic || '').trim();
        const key = topic.toLowerCase();
        if (!topic || seen.has(key)) continue;
        seen.add(key);
        topics.push(topic);
        if (topics.length >= TOPICS_CAP) break;
    }

    return {
        themeName: String(themeRow.Broad_Theme).trim(),
        domainName: String(subdomainRow.Domain).trim(),
        subdomainName: String(subdomainRow.Sub_Domain).trim(),
        topics,
        fallbackDepartmentName: String(subdomainRow.IITD_Department || '').trim()
    };
}
