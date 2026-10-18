import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import QueryBuilder, { normalizeChain } from '../../src/services/search/QueryBuilder.js';
import FilterBuilder from '../../src/services/search/FilterBuilder.js';
import { buildSearchConfig, contentTerms, admissionMinRequired } from '../../src/services/search/constants.js';

const searchConfig = buildSearchConfig({});
const filterBuilder = new FilterBuilder(searchConfig);
const rosterWith = (ids) => ({ current: () => ids });

const makeQB = (rosterIds = ['111', '222']) =>
    new QueryBuilder({ searchConfig, filterBuilder, rosterService: rosterWith(rosterIds) });

const EMBED = new Array(8).fill(0.1);

test('a facet filter never re-targets the ANN search', () => {
    // kNN returns its k nearest *within* whatever filter it is given, so pre-filtering a facet
    // made "top k nearest Book Chapters" a different, larger pool than the Book Chapters inside
    // the unfiltered top k — a facet advertising 56 papers returned 307 once clicked.
    const qb = makeQB();
    const filters = { document_type: 'Book Chapter' };
    const bodies = [
        qb.buildNormalizedHybridQuery('polymer', EMBED, filters, 1, 20),
        qb.buildHybridQuery('polymer', EMBED, filters, 1, 20, 'date'),
        qb.buildImpactQuery('polymer', EMBED, filters, 1, 20)
    ];
    for (const body of bodies) {
        const knnClauses = JSON.stringify(body).match(/"knn":\{"embedding":\{.*?\}\}\}/g) || [];
        assert.ok(knnClauses.length > 0, 'expected a kNN arm');
        for (const knn of knnClauses) {
            assert.ok(!knn.includes('document_type'), `facet filter leaked into the ANN pre-filter: ${knn}`);
        }
        // ...but the filter is still enforced somewhere in the query.
        assert.ok(JSON.stringify(body).includes('Book Chapter'), 'facet filter must still be applied');
    }
});

test('author scoping still pre-filters the ANN search', () => {
    // Scope filters must stay inside the kNN clause: a sibling filter runs kNN against the whole
    // index first, so an author whose papers miss the global top-k gets no kNN recall at all.
    const qb = makeQB();
    const body = qb.buildNormalizedHybridQuery('polymer', EMBED, { author_id: '123' }, 1, 20);
    const knnClauses = JSON.stringify(body).match(/"knn":\{"embedding":\{.*?\}\}\}/g) || [];
    assert.ok(knnClauses.some(k => k.includes('authors.author_id')), 'author scope should pre-filter kNN');
});

test('phrase tiers: empty for single-word, tiered for multi-word', () => {
    const qb = makeQB();
    assert.deepEqual(qb._buildPhraseBoostTiers('quantum'), []);
    const tiers = qb._buildPhraseBoostTiers('machine learning');
    // Advanced (stemmed) mode prepends an un-stemmed literal exact-title tier.
    assert.equal(tiers.length, 5);
    assert.equal(tiers[0].match_phrase['title.standard'].slop, 0);
    assert.equal(tiers[0].match_phrase['title.standard'].boost, 25);
    assert.equal(tiers[1].match_phrase.title.slop, 0);
    assert.equal(tiers[1].match_phrase.title.boost, 20);
    // Boosts are strictly descending (literal exact > exact title > near title > abstract).
    const boosts = tiers.map(t => Object.values(t.match_phrase)[0].boost);
    for (let i = 1; i < boosts.length; i++) assert.ok(boosts[i] < boosts[i - 1]);
});

test('phrase tiers use un-stemmed .standard fields in literal mode', () => {
    const qb = makeQB();
    const tiers = qb._buildPhraseBoostTiers('machine learning', { literal: true });
    assert.ok('title.standard' in tiers[0].match_phrase);
    assert.ok('abstract.standard' in tiers[2].match_phrase);
});

test('buildBasicQuery (multi-word) adds phrase tiers as SHOULD boosts', () => {
    const qb = makeQB();
    const body = qb.buildBasicQuery('machine learning', {}, 1, 20, 'relevance');
    const should = body.query.bool.should;
    const phraseTiers = should.filter(c => c.match_phrase);
    assert.equal(phraseTiers.length, 4);
    // cross_fields AND is the recall gate (MUST), not a boost.
    assert.ok(body.query.bool.must.length >= 1);
});

test('buildNormalizedHybridQuery uses a native hybrid query with BM25 and kNN arms', () => {
    const qb = makeQB();
    const body = qb.buildNormalizedHybridQuery('machine learning', EMBED, {}, 1, 20);
    const arms = body.query.hybrid.queries;
    assert.equal(arms.length, 2, 'expected bm25 + knn arms');
    assert.ok(arms[0].bool.must[0], 'bm25 arm present');
    assert.ok(arms[1].bool.must[0].knn, 'knn arm present');
});

test('buildNormalizedHybridQuery drops the kNN arm when author-scoped', () => {
    const qb = makeQB();
    const body = qb.buildNormalizedHybridQuery('machine learning', EMBED, {}, 1, 20, null, null, false, null, null, { authorScoped: true });
    assert.equal(body.query.hybrid.queries.length, 1, 'only the bm25 arm should remain');
});

test('_buildTitleCoverageClause: requires all terms, multi-word only', () => {
    const qb = makeQB();
    assert.equal(qb._buildTitleCoverageClause('quantum'), null);
    const clause = qb._buildTitleCoverageClause('machine learning');
    assert.equal(clause.match['title.standard'].operator, 'and');
    assert.equal(clause.match['title.standard'].boost, 5);
});

test('buildStrictBm25Must: <=3 terms require all terms (must)', () => {
    const qb = makeQB();
    const clause = qb.buildStrictBm25Must('alpha beta gamma', ['title']);
    assert.ok(clause.bool.must);
    assert.equal(clause.bool.must.length, 3);
});

test('buildStrictBm25Must: 4+ terms relax to ~75% minimum_should_match', () => {
    const qb = makeQB();
    const clause = qb.buildStrictBm25Must('alpha beta gamma delta epsilon zeta', ['title']);
    assert.ok(clause.bool.should);
    assert.equal(clause.bool.minimum_should_match, Math.max(3, Math.ceil(6 * 0.75)));
});

test('buildStrictBm25Must: stopwords are excluded from the term-count threshold', () => {
    // A stopword's per-term clause queries fields analyzed with the same english_stop filter
    // that strips it from indexed content, so it can never match — counting it toward "N of M
    // terms" would make a sentence query with several stopwords structurally unsatisfiable.
    const qb = makeQB();
    const clause = qb.buildStrictBm25Must('the impact of alpha on beta and gamma', ['title']);
    assert.ok(clause.bool.should);
    // Content terms only: impact, alpha, beta, gamma = 4 (the, of, on, and are stopwords).
    assert.equal(clause.bool.should.length, 4);
    assert.equal(clause.bool.minimum_should_match, Math.max(3, Math.ceil(4 * 0.75)));
});

test('admission gate: content terms drop stopwords; 4 terms need 3', () => {
    assert.deepEqual(contentTerms('Cow Dung for curing cancer'), ['Cow', 'Dung', 'curing', 'cancer']);
    assert.equal(admissionMinRequired(2), 2);
    assert.equal(admissionMinRequired(3), 3);
    assert.equal(admissionMinRequired(4), 3);
    assert.equal(admissionMinRequired(1), 1);
});

test('admission pre-check uses ranking N-of-M, not any-2-tokens', () => {
    const qb = makeQB();
    const clause = qb.buildAdmissionPreCheckClause('Cow Dung for curing cancer');
    const text = clause.bool?.should?.[0] || clause;
    assert.ok(text.bool.should, '4 content terms must use should + MSM, not a flat 2-token match');
    assert.equal(text.bool.should.length, 4);
    assert.equal(text.bool.minimum_should_match, 3);
    assert.ok(!JSON.stringify(clause).includes('"minimum_should_match":"2"'));
});

test('long well-spelled queries are not typo-fallback candidates', () => {
    assert.ok(contentTerms('Cow Dung for curing cancer').length > 2);
    assert.ok(contentTerms('quamtum').length <= 2);
    assert.ok(contentTerms('cow dung').length <= 2);
});

test('admission pre-check for two content terms requires both', () => {
    const qb = makeQB();
    const clause = qb.buildAdmissionPreCheckClause('cow dung');
    const text = clause.bool?.should?.[0] || clause;
    assert.ok(text.bool.must);
    assert.equal(text.bool.must.length, 2);
});

test('buildIITDAuthorMatchClause returns null when roster is empty', () => {
    const qb = makeQB([]);
    assert.equal(qb.buildIITDAuthorMatchClause('basu'), null);
});

test('buildIITDAuthorMatchClause filters nested authors to the roster', () => {
    const qb = makeQB(['111', '222']);
    const clause = qb.buildIITDAuthorMatchClause('basu');
    const filter = clause.nested.query.bool.filter;
    assert.deepEqual(filter[0].terms['authors.author_id'], ['111', '222']);
});

test('buildConstrainedSearchInClause (author-only, no resolved ids) gates to roster', () => {
    const qb = makeQB(['111']);
    const clause = qb.buildConstrainedSearchInClause('basu', ['author'], { fuzziness: 'AUTO' });
    assert.deepEqual(clause.nested.query.bool.filter[0].terms['authors.author_id'], ['111']);
});

// Regression: "Oncology" used to fuzzy-expand to "ontology"/"ecology" and, because a fuzzy
// variant carries no edit-distance score penalty, those outranked every real oncology paper
// (609 recalled vs 40 matching exactly). Topic text in advanced mode must match exactly;
// misspellings are SearchService._fuzzyFallbackSearch's job.
test('advanced topic text is matched exactly, not fuzzily', () => {
    const qb = makeQB();
    for (const body of [
        qb.buildNormalizedHybridQuery('oncology', EMBED, {}, 1, 20),
        qb.buildHybridQuery('oncology', EMBED, {}, 1, 20, 'date'),
        qb.buildImpactQuery('oncology', EMBED, {}, 1, 20)
    ]) {
        // The text arm is a multi_match over the content fields; author arms are `match` on
        // nested authors.* and are allowed to stay fuzzy.
        const textArms = JSON.stringify(body).match(/"multi_match":\{[^}]*\}/g) || [];
        assert.ok(textArms.length > 0, 'expected a text multi_match arm');
        for (const arm of textArms) assert.ok(!arm.includes('fuzziness'), `topic text stayed fuzzy: ${arm}`);
    }
});

test('advanced keeps author-name matching fuzzy (transliteration variants)', () => {
    const qb = makeQB(['111']);
    const body = qb.buildNormalizedHybridQuery('basu', EMBED, {}, 1, 20);
    const nested = JSON.stringify(body.query.hybrid.queries[0]).match(/authors\.author_name[^}]*\}/g) || [];
    assert.ok(nested.some(s => s.includes('fuzziness')), 'author-name arms must stay fuzzy');
});

test('search_in text fields match exactly while author stays fuzzy', () => {
    const qb = makeQB(['111']);
    const textOnly = { fuzziness: 'AUTO', textFuzziness: undefined };
    const clause = qb.buildConstrainedSearchInClause('oncology', ['title', 'abstract'], textOnly);
    assert.ok(!JSON.stringify(clause).includes('fuzziness'), 'title/abstract must not be fuzzed');
    const authorClause = qb.buildConstrainedSearchInClause('basu', ['author'], textOnly);
    assert.ok(JSON.stringify(authorClause).includes('fuzziness'), 'author names must stay fuzzy');
    // Omitting textFuzziness entirely (the fuzzy-fallback path) must still fuzz text.
    const fallback = qb.buildConstrainedSearchInClause('oncolgy', ['title'], { fuzziness: 2 });
    assert.ok(JSON.stringify(fallback).includes('fuzziness'), 'fallback path must stay fuzzy');
});

// Regression: field_associated's per-term builder referenced an undefined `fuzz`, so any
// search_in including 'field' threw a ReferenceError and the request 500'd.
test('buildConstrainedSearchInClause supports search_in=field without throwing', () => {
    const qb = makeQB(['111']);
    const clause = qb.buildConstrainedSearchInClause('oncology', ['field'], { fuzziness: 'AUTO' });
    assert.ok(JSON.stringify(clause).includes('field_associated'));
});

test('normalizeChain: trims, drops empties, dedupes case-insensitively, preserves order', () => {
    assert.deepEqual(normalizeChain(null), []);
    assert.deepEqual(normalizeChain('solar'), ['solar']);
    assert.deepEqual(normalizeChain(['solar', ' battery ', '', 'Solar', 'lithium']), ['solar', 'battery', 'lithium']);
});

test('buildRefineFilterClauses: one strict literal clause per non-empty term', () => {
    const qb = makeQB();
    assert.deepEqual(qb.buildRefineFilterClauses([], null), []);
    const clauses = qb.buildRefineFilterClauses(['solar', 'battery'], null);
    assert.equal(clauses.length, 2);
    // Strict literal clauses carry no fuzziness (deterministic membership for narrowing).
    assert.ok(!JSON.stringify(clauses).includes('fuzziness'));
});

test('buildRefineAnchorFilter: keeps the lexical floor alongside the capped anchor ids', () => {
    // SearchService caps the anchor id list, so filtering on the ids ALONE silently truncates a
    // broad anchor. Measured: "energy" matches 15370 documents, the capped anchor held 2000 of
    // them, and query "solar" refined within "energy" returned 510 in advanced against 2267 in
    // basic — advanced must be a superset of basic, so the term's own literal clause (exactly what
    // basic filters on) has to stay in the filter next to the ids.
    const qb = makeQB();
    const filter = qb.buildRefineAnchorFilter('energy', ['a1', 'a2'], null);
    assert.equal(filter.bool.minimum_should_match, 1);
    assert.equal(filter.bool.should.length, 2);
    const idArm = filter.bool.should.find(a => a.terms?.mongo_id);
    assert.deepEqual(idArm.terms.mongo_id, ['a1', 'a2']);
    // The other arm is the same clause basic mode recalls (and filters) on.
    const lexicalArm = filter.bool.should.find(a => !a.terms?.mongo_id);
    assert.deepEqual(lexicalArm, qb.buildLiteralPrimaryClause('energy', null, {}));
    // Narrowing must stay deterministic: no fuzziness, and no kNN arm smuggled into filter
    // context (in filter context kNN ignores min_score and admits up to k non-matches).
    const asJson = JSON.stringify(filter);
    assert.ok(!asJson.includes('fuzziness'), 'refine anchor filter must not fuzz');
    assert.ok(!asJson.includes('"knn"'), 'refine anchor filter must not contain a kNN clause');
});

test('buildRefineAnchorFilter: no anchor ids narrows to the lexical clause, never match_all', () => {
    const qb = makeQB();
    for (const ids of [[], null, undefined]) {
        const filter = qb.buildRefineAnchorFilter('energy', ids, null);
        assert.deepEqual(filter, qb.buildLiteralPrimaryClause('energy', null, {}));
        assert.ok(!JSON.stringify(filter).includes('match_all'), 'an empty anchor must not broaden');
    }
});

test('buildRefineAnchorFilter: honours search_in so the floor matches the scoped corpus', () => {
    const qb = makeQB();
    const filter = qb.buildRefineAnchorFilter('energy', ['a1'], ['title']);
    const lexicalArm = filter.bool.should.find(a => !a.terms?.mongo_id);
    assert.deepEqual(lexicalArm, qb.buildLiteralPrimaryClause('energy', ['title'], {}));
    // A title-scoped floor must not reach into the abstract.
    assert.ok(!JSON.stringify(lexicalArm).includes('abstract'));
});

test('buildBasicQuery: prior chain terms go into FILTER context (not scoring must/should)', () => {
    const qb = makeQB();
    const body = qb.buildBasicQuery('lithium', {}, 1, 20, 'relevance', null, ['solar', 'battery']);
    // The newest query is the only scoring MUST; prior terms are strict filters.
    assert.equal(body.query.bool.must.length, 1);
    // Two refinement filter clauses are present in the filter array.
    assert.ok(body.query.bool.filter.length >= 2);
});

test('buildAuthorRefineNarrowMust: anchor + every narrow term becomes its own MUST', () => {
    const qb = makeQB();
    const clause = qb.buildAuthorRefineNarrowMust('lithium', 'basu', null, { fuzziness: 'AUTO' }, null, ['solar', 'battery']);
    // 1 author anchor + 3 narrow terms (solar, battery, lithium).
    assert.equal(clause.bool.must.length, 4);
});

test('buildAuthorRefineNarrowMust: empty/whitespace narrow terms are dropped', () => {
    const qb = makeQB();
    const clause = qb.buildAuthorRefineNarrowMust('lithium', 'basu', null, {}, null, ['', '  ', 'solar']);
    // 1 anchor + solar + lithium (the blanks are ignored).
    assert.equal(clause.bool.must.length, 3);
});

// In the advanced author-narrow path, the BM25 recall arm must carry anchor + every prior
// topic term + the newest query as separate MUSTs so each step strictly narrows.
const advancedAuthorNarrowBm25 = (body) =>
    body.query.hybrid.queries[0].bool.must[0];

test('buildNormalizedHybridQuery (author-narrow + chain): BM25 arm ANDs anchor + all narrow terms', () => {
    const qb = makeQB(['111']);
    const body = qb.buildNormalizedHybridQuery(
        'lithium', EMBED, {}, 1, 20, ['author'], ['111'], true, 'basu', null,
        { refineChain: ['basu', 'solar', 'battery'] }
    );
    const bm25 = advancedAuthorNarrowBm25(body);
    // anchor (basu) + solar + battery + lithium = 4 MUST clauses.
    assert.equal(bm25.bool.must.length, 4);
});

test('buildHybridQuery (author-narrow + chain): BM25 arm ANDs anchor + all narrow terms', () => {
    const qb = makeQB(['111']);
    const body = qb.buildHybridQuery(
        'lithium', EMBED, {}, 1, 20, 'date', ['author'], ['111'], true, 'basu', null,
        { refineChain: ['basu', 'solar'] }
    );
    // For date/citations sort the query is a plain bool with the recall gate in must[0].
    const bm25 = body.query.bool.must[0].bool.should[0];
    // anchor (basu) + solar + lithium = 3 MUST clauses.
    assert.equal(bm25.bool.must.length, 3);
});

/** Every `knn.embedding` object anywhere in a query body, in document order. */
const knnClausesIn = (node, out = []) => {
    if (node === null || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
        for (const child of node) knnClausesIn(child, out);
        return out;
    }
    if (node.knn?.embedding) out.push(node.knn.embedding);
    for (const value of Object.values(node)) knnClausesIn(value, out);
    return out;
};

// The advanced builders pass these to buildConstrainedSearchInClause (IDENTITY_FUZZ plus an
// explicitly-undefined textFuzziness), so the expected field-scope clause is reproducible here.
const ADVANCED_CSI_OPTS = { fuzziness: 'AUTO', textFuzziness: undefined, authorScoped: false };

const advancedBodies = (qb, query, searchIn, filters = {}) => [
    ['normalized hybrid', qb.buildNormalizedHybridQuery(query, EMBED, filters, 1, 20, searchIn)],
    ['hybrid (date sort)', qb.buildHybridQuery(query, EMBED, filters, 1, 20, 'date', searchIn)],
    ['impact', qb.buildImpactQuery(query, EMBED, filters, 1, 20, searchIn)]
];

// The whole-document embedding has no field structure, so an ungated ANN arm admitted documents
// by overall topical similarity regardless of search_in: "oncology" scoped to title returned 302
// hits with 13 of the first 20 having no "oncology" in the title at all.
test('search_in pre-filters the ANN arm with the BM25 arm\'s own field-scope clause', () => {
    const qb = makeQB(['111']);
    const gate = qb.buildConstrainedSearchInClause('oncology', ['title'], ADVANCED_CSI_OPTS);
    for (const [label, body] of advancedBodies(qb, 'oncology', ['title'])) {
        const knns = knnClausesIn(body);
        assert.ok(knns.length > 0, `${label}: expected a kNN arm`);
        for (const knn of knns) {
            assert.ok(knn.filter, `${label}: kNN arm must be pre-filtered by the field scope`);
            assert.deepEqual(knn.filter.bool.filter.at(-1), gate, `${label}: gate must match the BM25 arm`);
        }
    }
});

// A document with the term only in its abstract is off-scope for search_in=["title"], and the
// kNN arm must not be the thing that lets it in.
test('search_in=["title"] leaves the ANN arm unable to admit a title-less match', () => {
    const qb = makeQB(['111']);
    for (const [label, body] of advancedBodies(qb, 'oncology', ['title'])) {
        for (const knn of knnClausesIn(body)) {
            const gate = JSON.stringify(knn.filter);
            assert.ok(gate.includes('oncology'), `${label}: the query term must be required`);
            assert.ok(gate.includes('title'), `${label}: the title field must be required`);
            assert.ok(!gate.includes('abstract'), `${label}: an abstract-only match is off-scope`);
        }
    }
});

// getSearchFields(['author']) is deliberately empty (author matching is routed through the
// nested authors path), so a field-list-based gate would have matched nothing here.
test('search_in=["author"] gates the ANN arm on nested authors, not an empty field list', () => {
    const qb = makeQB(['111']);
    for (const [label, body] of advancedBodies(qb, 'basu', ['author'])) {
        for (const knn of knnClausesIn(body)) {
            const gate = JSON.stringify(knn.filter);
            assert.ok(!gate.includes('match_none'), `${label}: gate must not be unsatisfiable`);
            assert.ok(gate.includes('authors.author_name'), `${label}: expected a nested author gate`);
            assert.ok(gate.includes('"authors.author_id":["111"]'), `${label}: roster gating must survive`);
        }
    }
});

// The scope/facet split is what makes a facet count equal the total you get after clicking it;
// gating search_in must not drag facet filters into the ANN pre-filter alongside it.
test('search_in gating keeps facet filters out of the ANN pre-filter', () => {
    const qb = makeQB(['111']);
    const filters = { document_type: 'Book Chapter' };
    for (const [label, body] of advancedBodies(qb, 'oncology', ['title'], filters)) {
        for (const knn of knnClausesIn(body)) {
            assert.ok(!JSON.stringify(knn.filter).includes('document_type'), `${label}: facet leaked into ANN pre-filter`);
        }
        assert.ok(JSON.stringify(body).includes('Book Chapter'), `${label}: facet filter must still be applied`);
    }
});

// Digests of the bodies as built before search_in gating existed. The no-search_in path is the
// common case and must stay bit-for-bit identical; the gate is reachable only through the
// `searchIn && searchIn.length > 0` guard, and this is what proves nothing leaks past it.
// `publication_year`'s gauss origin is the current year, so it is normalized out to keep the
// digest stable across calendar years. A failure here means an unscoped body changed shape:
// re-pin only after confirming the change was intended.
const bodyDigest = (body) => createHash('sha256')
    .update(JSON.stringify(body).replace(/"origin":\d{4}/g, '"origin":0'))
    .digest('hex');

test('no search_in: query construction is byte-identical to pre-gating behaviour', () => {
    const qb = makeQB(['111', '222']);
    const facet = { document_type: 'Book Chapter' };
    const cases = [
        ['normalized hybrid', qb.buildNormalizedHybridQuery('machine learning', EMBED, facet, 1, 20),
            '0d9344d9f806d97129bc9c81f74d0e03b89f2667a5b48e7650f9587961b501e4'],
        ['hybrid (date sort)', qb.buildHybridQuery('machine learning', EMBED, facet, 1, 20, 'date'),
            '74e06818295c7edd25580f5f6865816e3f69fdfeb594c08210f47bedc4eb646a'],
        ['impact', qb.buildImpactQuery('machine learning', EMBED, facet, 1, 20),
            '3c0e2660558b3d13184382e9b1422e957aa4371aab08ae034e13a74664784124'],
        ['author-scoped filter', qb.buildNormalizedHybridQuery('polymer', EMBED, { author_id: '123' }, 1, 20),
            '525f0c572fca4299fff2f660fa96211bcc3b5ba6dfd363aca9f68b846e6e1704'],
        ['refine chain', qb.buildNormalizedHybridQuery('lithium', EMBED, {}, 1, 20, null, null, false, null, null, { refineChain: ['solar'] }),
            '439a986ddd8f78e94216761a748dc5a94dae8146f59461d2423f6d867fd23f26']
    ];
    for (const [label, body, expected] of cases) assert.equal(bodyDigest(body), expected, label);
});

test('no search_in: the ANN arm stays unfiltered when nothing scopes it', () => {
    const qb = makeQB(['111']);
    for (const searchIn of [null, undefined, []]) {
        for (const [label, body] of advancedBodies(qb, 'oncology', searchIn)) {
            for (const knn of knnClausesIn(body)) {
                assert.deepEqual(Object.keys(knn), ['vector', 'k'], `${label}: unexpected ANN pre-filter for search_in=${JSON.stringify(searchIn)}`);
            }
        }
    }
});

// ── kNN recall policy: no recall option may be accepted and then ignored ──

const normalizedHybrid = (qb, opts, { query = 'lithium', searchIn = null, filters = {} } = {}) =>
    qb.buildNormalizedHybridQuery(query, EMBED, filters, 1, 20, searchIn, null, false, null, null, opts);

const authorNarrowHybrid = (qb, opts) =>
    qb.buildNormalizedHybridQuery('lithium', EMBED, {}, 1, 20, ['author'], ['111'], true, 'basu', null,
        { refineChain: ['basu', 'solar'], ...opts });

test('allowKnnRecall opts a fresh author-scoped query into a bounded kNN arm', () => {
    // Without it the lexical conjunction is the only gate, which inside one author's ~10^2 papers
    // can collapse an ordinary topical query to a dead end (AuthorScopedSearch widens on this once
    // it has confirmed the query is lexically grounded in that author's own corpus).
    const qb = makeQB(['111']);
    const facet = { document_type: 'Book Chapter' };
    const body = normalizedHybrid(qb, { authorScoped: true, allowKnnRecall: true }, { query: 'photovoltaic', filters: facet });
    const arms = body.query.hybrid.queries;

    assert.equal(arms.length, 2, 'the kNN arm is added');
    const knn = arms[1].bool.must[0].knn.embedding;
    assert.ok(knn.k > 0 && knn.k <= 10, `expected a k sized for one author's pool, got ${knn.k}`);
    assert.ok(!JSON.stringify(knn.filter ?? {}).includes('Book Chapter'), 'a facet must not re-target the ANN search');
    assert.ok(JSON.stringify(arms[1].bool.filter).includes('Book Chapter'), 'the facet is applied as a sibling filter');

    // Ranking must be unaffected: the opt-in adds an arm, it does not rebuild the lexical one.
    const lexicalOnly = normalizedHybrid(qb, { authorScoped: true }, { query: 'photovoltaic', filters: facet });
    assert.deepEqual(arms[0], lexicalOnly.query.hybrid.queries[0]);
});

test('an opted-in kNN arm is still gated by search_in', () => {
    const qb = makeQB(['111']);
    const gate = qb.buildConstrainedSearchInClause('oncology', ['title'], { ...ADVANCED_CSI_OPTS, authorScoped: true });
    const body = normalizedHybrid(qb, { authorScoped: true, allowKnnRecall: true }, { query: 'oncology', searchIn: ['title'] });
    const knn = knnClausesIn(body);
    assert.equal(knn.length, 1);
    assert.deepEqual(knn[0].filter.bool.filter.at(-1), gate, 'the gate must match the BM25 arm');
});

test('k follows the candidate pool: corpus-wide by default, small once author-scoped', () => {
    // The right k is a property of the pool, not of the request: within one author's papers a
    // corpus-wide k exceeds the pool itself, so "top k nearest neighbours" is the whole pool.
    const qb = makeQB(['111']);
    const corpusWide = knnClausesIn(normalizedHybrid(qb, {}))[0].k;
    const scoped = knnClausesIn(normalizedHybrid(qb, { authorScoped: true, allowKnnRecall: true }))[0].k;
    const scopedWithChain = knnClausesIn(normalizedHybrid(qb, { authorScoped: true, refineChain: ['solar'] }))[0].k;

    assert.equal(corpusWide, 100);
    assert.ok(scoped < corpusWide, `an author-scoped arm must not use the corpus-wide k (${scoped})`);
    assert.equal(scopedWithChain, scoped, 'the pool is the same size once a chain has narrowed to one author');
});

test('no option set accepts a recall option it does not honour', () => {
    // Regression: `knnK` was accepted and discarded on the fresh author-scoped path — the one path
    // that built no kNN arm at all — so a caller could size a recall arm that did not exist, and
    // the only way to notice was to read the builder. Either an arm exists and carries the k the
    // caller asked for, or asking is rejected outright.
    const qb = makeQB(['111']);
    const optionSets = [
        {},
        { refineChain: ['solar'] },
        { authorScoped: true },
        { authorScoped: true, allowKnnRecall: true },
        { authorScoped: true, refineChain: ['solar'] },
        { restrictKnn: true },
        { restrictKnn: true, allowKnnRecall: true },
        { restrictKnn: true, refineChain: ['solar'] }
    ];

    for (const opts of optionSets) {
        const label = JSON.stringify(opts);
        const hasKnn = knnClausesIn(normalizedHybrid(qb, opts)).length > 0;
        if (hasKnn) {
            assert.equal(knnClausesIn(normalizedHybrid(qb, { ...opts, knnK: 7 }))[0].k, 7, `${label}: knnK must reach the arm`);
        } else {
            assert.throws(() => normalizedHybrid(qb, { ...opts, knnK: 7 }), /knnK/, `${label}: a knnK that cannot take effect must be rejected`);
        }
    }

    // The author-narrow shape refuses recall regardless of chain length, so both recall options
    // are unsatisfiable there rather than merely unused.
    assert.equal(knnClausesIn(authorNarrowHybrid(qb, {})).length, 0);
    assert.throws(() => authorNarrowHybrid(qb, { knnK: 7 }), /knnK/);
    assert.throws(() => authorNarrowHybrid(qb, { allowKnnRecall: true }), /allowKnnRecall/,
        'an exact scopus_id/kerberos match must not be widened semantically, and saying so beats ignoring the request');
});

test('search_in does not resurrect the kNN arm where it is already excluded', () => {
    const qb = makeQB(['111']);
    const armCount = (body) => body.query.hybrid.queries.length;

    // authorScoped on a fresh query: the candidate pool is too small for kNN scores to discriminate.
    assert.equal(armCount(qb.buildNormalizedHybridQuery('oncology', EMBED, {}, 1, 20, ['title'], null, false, null, null, { authorScoped: true })), 1);
    // restrictKnn, same rationale, requested by the caller.
    assert.equal(armCount(qb.buildNormalizedHybridQuery('oncology', EMBED, {}, 1, 20, ['title'], null, false, null, null, { restrictKnn: true })), 1);
    // authorRefineNarrow + author-only is excluded regardless of chain length.
    assert.equal(armCount(qb.buildNormalizedHybridQuery('lithium', EMBED, {}, 1, 20, ['author'], ['111'], true, 'basu', null, { refineChain: ['basu', 'solar'] })), 1);
    // ...but an active refine chain alone still admits kNN.
    assert.equal(armCount(qb.buildNormalizedHybridQuery('lithium', EMBED, {}, 1, 20, ['title'], null, false, null, null, { authorScoped: true, refineChain: ['solar'] })), 2);

    // The date/citations and impact builders drop the kNN recall arm when author-scoped.
    for (const body of [
        qb.buildHybridQuery('oncology', EMBED, {}, 1, 20, 'date', ['title'], null, false, null, null, { authorScoped: true }),
        qb.buildImpactQuery('oncology', EMBED, {}, 1, 20, ['title'], null, false, null, null, { authorScoped: true })
    ]) {
        assert.equal(knnClausesIn(body).length, 0, 'author-scoped recall must not include a kNN arm');
    }
});
