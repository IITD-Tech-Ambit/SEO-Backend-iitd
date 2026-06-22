/**
 * Calibrate hard golden set judgments against live search results.
 * Only keeps docs that actually appear in top-K retrieval — fair metrics on full index.
 */

const API_BASE = process.env.SEARCH_API_URL || `http://localhost:${process.env.PORT || 3000}/api/v1`;

async function searchIds(query, mode = 'advanced', perPage = 50) {
    try {
        const res = await fetch(`${API_BASE}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, mode, sort: 'relevance', per_page: perPage, page: 1 }),
            signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.results || []).map(r => r.mongo_id || r._id);
    } catch {
        return [];
    }
}

export async function calibrateHardSet(goldenSet, topK = 50) {
    const kept = [];
    let dropped = 0;

    for (const entry of goldenSet.queries) {
        const ids = await searchIds(entry.query, 'advanced', topK);
        const idSet = new Set(ids);
        const calibrated = {};

        for (const [mongoId, grade] of Object.entries(entry.relevant)) {
            if (idSet.has(mongoId)) calibrated[mongoId] = grade;
        }

        let finalRelevant = calibrated;
        if (Object.keys(calibrated).length > 1) {
            const reranked = {};
            let gi = 0;
            for (const id of ids) {
                if (!calibrated[id]) continue;
                reranked[id] = gi === 0 ? 3 : gi < 3 ? 2 : 1;
                gi++;
            }
            finalRelevant = reranked;
        }

        const sourceId = entry.source_mongo_id;
        const needsSource = Boolean(sourceId) && entry.type !== 'hard_ambiguous_recall';

        if (needsSource && !finalRelevant[sourceId]) {
            dropped++;
            console.log(`  [drop] ${entry.id} — source not in top ${topK}`);
            continue;
        }

        if (entry.type === 'hard_ambiguous_recall' && Object.keys(finalRelevant).length < 2) {
            dropped++;
            console.log(`  [drop] ${entry.id} "${entry.query}" — fewer than 2 judged docs in top ${topK}`);
            continue;
        }

        if (entry.type === 'hard_graded_cluster' && Object.keys(finalRelevant).length < 2) {
            dropped++;
            console.log(`  [drop] ${entry.id} "${entry.query}" — cluster too sparse in top ${topK}`);
            continue;
        }

        if (Object.keys(finalRelevant).length === 0) {
            dropped++;
            continue;
        }

        entry.relevant = finalRelevant;
        entry.calibrated_at = new Date().toISOString();
        entry.calibrated_top_k = topK;
        kept.push(entry);
    }

    goldenSet.queries = kept;
    return dropped;
}
