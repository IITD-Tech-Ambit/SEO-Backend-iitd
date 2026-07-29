// Private Use Area code points as highlight markers so the frontend never renders raw
// injected HTML — it splits on these and builds its own <mark> elements.
export const HIGHLIGHT_PRE_TAG = '';
export const HIGHLIGHT_POST_TAG = '';

// The plain `title`/`abstract` fields (not `.standard`) use OpenSearch's built-in `english`
// analyzer on both indices, which already strips stopwords ("at", "the", ...) via its
// english_stop filter — matching/highlighting here avoids hardcoding a stopword list ourselves.
export const HIGHLIGHT_FIELDS = { title: 'title', abstract: 'abstract' };

export function buildHighlightQuery(terms, fields, fuzziness = 'AUTO') {
    const clean = [...new Set((terms || []).map((t) => (t || '').trim()).filter(Boolean))];
    if (!clean.length || !fields.length) return null;
    const should = [];
    for (const term of clean) {
        for (const field of fields) {
            should.push({ match: { [field]: { query: term, fuzziness } } });
        }
    }
    return { bool: { should, minimum_should_match: 1 } };
}

// Whole-field for both: title and abstract render identically in list cards (CSS line-clamp
// truncates the preview) and in the full detail modal, with no snippet/full-text mismatch
// to reconcile between the two views.
export function buildHighlightBlock(highlightQuery, { titleField = HIGHLIGHT_FIELDS.title, abstractField = HIGHLIGHT_FIELDS.abstract } = {}) {
    if (!highlightQuery) return undefined;
    return {
        pre_tags: [HIGHLIGHT_PRE_TAG],
        post_tags: [HIGHLIGHT_POST_TAG],
        require_field_match: false,
        highlight_query: highlightQuery,
        fields: {
            [titleField]: { number_of_fragments: 0 },
            [abstractField]: { number_of_fragments: 0 }
        }
    };
}

export function extractHighlight(hit, { titleField = HIGHLIGHT_FIELDS.title, abstractField = HIGHLIGHT_FIELDS.abstract } = {}) {
    const highlight = hit?.highlight;
    if (!highlight) return null;
    const title = highlight[titleField]?.[0];
    const abstract = highlight[abstractField]?.[0];
    if (!title && !abstract) return null;
    return { ...(title ? { title } : {}), ...(abstract ? { abstract } : {}) };
}
