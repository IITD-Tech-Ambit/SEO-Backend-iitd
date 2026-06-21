/**
 * Build a deterministic, corpus-aligned golden set for retrieval evaluation.
 *
 * All queries are derived from documents in test_corpus.json — no random author
 * names or hardcoded topic clusters that may not exist in the sample.
 *
 * Graded relevance: 3 = source doc / exact match, 2 = highly relevant, 1 = topical.
 */

const STOPWORDS = new Set([
    'a', 'an', 'the', 'of', 'in', 'to', 'for', 'and', 'or', 'is', 'are', 'was', 'were',
    'on', 'at', 'by', 'with', 'from', 'as', 'it', 'its', 'this', 'that', 'be', 'been',
    'has', 'have', 'had', 'not', 'but', 'can', 'will', 'do', 'does', 'did', 'which',
    'who', 'whom', 'their', 'there', 'these', 'those', 'we', 'our', 'us', 'them',
    'would', 'could', 'should', 'may', 'might', 'about', 'more', 'into', 'over',
    'under', 'also', 'such', 'than', 'very', 'each', 'between', 'both', 'through',
    'using', 'based', 'study', 'paper', 'research', 'results', 'analysis', 'approach',
    'method', 'proposed', 'present', 'show', 'new', 'used', 'two', 'one', 'high', 'low',
    'different', 'effect', 'effects', 'however', 'investigated', 'examined', 'various',
]);

/** Stable pick: sort by mongo_id, stride through list for diversity. */
export function pickDeterministic(arr, n, stride = 7) {
    if (!arr.length) return [];
    const sorted = [...arr].sort((a, b) => a.mongo_id.localeCompare(b.mongo_id));
    const out = [];
    let i = 0;
    while (out.length < n && i < sorted.length * 2) {
        const doc = sorted[i % sorted.length];
        if (!out.find(d => d.mongo_id === doc.mongo_id)) out.push(doc);
        i += stride;
    }
    return out.slice(0, n);
}

export function extractKeywords(text, count = 4) {
    if (!text) return [];
    const words = text.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
    return [...new Set(words)].slice(0, count);
}

export function titleSnippet(title, maxLen = 60) {
    if (!title) return '';
    if (title.length <= maxLen) return title;
    return title.substring(0, maxLen).replace(/\s\S*$/, '').trim();
}

/** Last name token from author string (Scopus format: "Surname, Given" or "Given Surname"). */
export function getAuthorSurname(doc) {
    const authors = doc.authors || [];
    if (!authors.length) return null;
    const name = authors[0].name || authors[0].author_name || '';
    const parts = name.split(/[,\s]+/).map(p => p.replace(/[^a-zA-Z]/g, '')).filter(Boolean);
    if (!parts.length) return null;
    const surname = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    return surname.length >= 4 ? surname : null;
}

/** Prefer IITD faculty papers (kerberos set) for author queries. */
export function pickAuthorDocs(docs, n) {
    const withKerberos = docs.filter(d => d.kerberos && getAuthorSurname(d));
    const pool = withKerberos.length >= n ? withKerberos : docs.filter(d => getAuthorSurname(d));
    return pickDeterministic(pool, n, 11);
}

function topFieldsFromCorpus(docs, minDocs = 3, maxFields = 8) {
    const counts = new Map();
    for (const d of docs) {
        const f = d.field_associated;
        if (!f) continue;
        counts.set(f, (counts.get(f) || 0) + 1);
    }
    return [...counts.entries()]
        .filter(([, c]) => c >= minDocs)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, maxFields)
        .map(([field]) => field);
}

/** Mine title bigrams that appear in ≥ minDocs documents. */
function discoverTopicClusters(docs, minDocs = 3, maxClusters = 10) {
    const bigramCounts = new Map();
    for (const d of docs) {
        const words = extractKeywords(d.title, 12);
        for (let i = 0; i < words.length - 1; i++) {
            const bg = `${words[i]} ${words[i + 1]}`;
            bigramCounts.set(bg, (bigramCounts.get(bg) || 0) + 1);
        }
    }
    return [...bigramCounts.entries()]
        .filter(([, c]) => c >= minDocs)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, maxClusters)
        .map(([query, count]) => ({
            query,
            filter: (d) => {
                const [w1, w2] = query.split(' ');
                const t = (d.title || '').toLowerCase();
                return t.includes(w1) && t.includes(w2);
            },
            matching_docs: count,
        }));
}

const PARAPHRASE_TEMPLATES = [
    (title) => {
        const kw = extractKeywords(title, 3);
        if (kw.length < 2) return null;
        return `innovations related to ${kw.join(' and ')}`;
    },
    (title) => {
        const kw = extractKeywords(title, 2);
        if (kw.length < 2) return null;
        return `how does ${kw[0]} relate to ${kw[1]}`;
    },
    (title) => {
        const kw = extractKeywords(title, 3);
        if (kw.length < 2) return null;
        return `recent advances in ${kw.slice(0, 2).join(' ')} techniques`;
    },
];

/**
 * @param {{ documents: object[], total_documents?: number, sample_size?: number }} corpus
 * @param {{ perCategory?: Record<string, number> }} [options]
 */
export function buildComprehensiveGoldenSet(corpus, options = {}) {
    const docs = corpus.documents || [];
    const perCategory = {
        exact_title: 20,
        partial_title: 20,
        abstract_keyword: 15,
        semantic: 10,
        author: 10,
        cross_field: 10,
        ...options.perCategory,
    };

    const queries = [];
    let qid = 0;

    const docsWithAbstract = docs.filter(d => d.abstract && d.abstract.length > 80 && d.title?.length > 10);
    const docsWithField = docs.filter(d => d.field_associated && d.title?.length > 10);

    for (const doc of pickDeterministic(docsWithAbstract, perCategory.exact_title, 5)) {
        queries.push({
            id: `exact-title-${++qid}`,
            query: titleSnippet(doc.title),
            type: 'exact_title',
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 3 },
        });
    }

    for (const doc of pickDeterministic(docsWithAbstract, perCategory.partial_title, 6)) {
        const kw = extractKeywords(doc.title, 4);
        if (kw.length < 2) continue;
        queries.push({
            id: `partial-title-${++qid}`,
            query: kw.join(' '),
            type: 'partial_title',
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 3 },
        });
    }

    for (const doc of pickDeterministic(docsWithAbstract, perCategory.abstract_keyword, 8)) {
        const kw = extractKeywords(doc.abstract, 4);
        if (kw.length < 3) continue;
        queries.push({
            id: `abstract-kw-${++qid}`,
            query: kw.join(' '),
            type: 'abstract_keyword',
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 2 },
        });
    }

    for (const doc of pickDeterministic(docsWithAbstract, perCategory.semantic, 13)) {
        const template = PARAPHRASE_TEMPLATES[qid % PARAPHRASE_TEMPLATES.length];
        const paraphrase = template(doc.title);
        if (!paraphrase) continue;
        queries.push({
            id: `semantic-${++qid}`,
            query: paraphrase,
            type: 'semantic',
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 2 },
        });
    }

    for (const doc of pickAuthorDocs(docsWithAbstract, perCategory.author)) {
        const surname = getAuthorSurname(doc);
        if (!surname) continue;
        queries.push({
            id: `author-${++qid}`,
            query: surname,
            type: 'author',
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            kerberos: doc.kerberos || null,
            relevant: { [doc.mongo_id]: 2 },
        });
    }

    for (const field of topFieldsFromCorpus(docs)) {
        const fieldDocs = docs.filter(d => d.field_associated === field);
        const samples = pickDeterministic(fieldDocs, Math.min(5, fieldDocs.length), 3);
        const relevant = {};
        for (const d of samples) relevant[d.mongo_id] = 1;
        queries.push({
            id: `field-${++qid}`,
            query: field,
            type: 'field_broad',
            expected_min_results: fieldDocs.length,
            relevant,
        });
    }

    for (const doc of pickDeterministic(docsWithField, perCategory.cross_field, 9)) {
        const kw = extractKeywords(doc.title, 2);
        if (!kw.length) continue;
        queries.push({
            id: `cross-${++qid}`,
            query: `${kw[0]} ${doc.field_associated}`,
            type: 'cross_field',
            source_mongo_id: doc.mongo_id,
            source_title: doc.title,
            relevant: { [doc.mongo_id]: 2 },
        });
    }

    for (const cluster of discoverTopicClusters(docs)) {
        const matching = docs.filter(cluster.filter);
        if (matching.length < 2) continue;
        const relevant = {};
        const [leadWord] = cluster.query.split(' ');
        for (const d of pickDeterministic(matching, Math.min(10, matching.length), 2)) {
            relevant[d.mongo_id] = (d.title || '').toLowerCase().includes(leadWord) ? 3 : 2;
        }
        queries.push({
            id: `topic-${++qid}`,
            query: cluster.query,
            type: 'multi_relevant',
            matching_docs: matching.length,
            relevant,
        });
    }

    return {
        version: 3,
        description: 'Comprehensive golden set derived deterministically from the test corpus sample',
        corpus_documents: corpus.total_documents ?? docs.length,
        corpus_sample_size: corpus.sample_size ?? docs.length,
        exported_at: new Date().toISOString(),
        categories: {
            exact_title: 'Title substring from corpus doc — source doc should rank in top 10',
            partial_title: 'Keywords from corpus title — source doc should appear in top 50',
            abstract_keyword: 'Distinctive abstract terms from corpus doc',
            semantic: 'Paraphrased title — tests vector recall',
            author: 'Author surname from corpus doc (prefers IITD kerberos papers)',
            field_broad: 'Broad field name present in corpus sample',
            cross_field: 'Title keyword + field from same corpus doc',
            multi_relevant: 'Title bigram cluster mined from corpus (≥3 docs)',
        },
        queries,
    };
}
