import { test } from 'node:test';
import assert from 'node:assert/strict';
import QueryBuilder, { normalizeChain } from '../../src/services/search/QueryBuilder.js';
import FilterBuilder from '../../src/services/search/FilterBuilder.js';
import { buildSearchConfig } from '../../src/services/search/constants.js';

const searchConfig = buildSearchConfig({});
const filterBuilder = new FilterBuilder(searchConfig);
const rosterWith = (ids) => ({ current: () => ids });

const makeQB = (rosterIds = ['111', '222']) =>
    new QueryBuilder({ searchConfig, filterBuilder, rosterService: rosterWith(rosterIds) });

const EMBED = new Array(8).fill(0.1);

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

test('buildNormalizedHybridQuery includes the lexical-floor function', () => {
    const qb = makeQB();
    const body = qb.buildNormalizedHybridQuery('machine learning', EMBED, {}, 1, 20);
    const fns = body.query.function_score.functions;
    // knn_score moved to `rescore` (bounded window) — the base function_score keeps only the
    // cheap bm25 sigmoid + lexical floor, so min_score filtering stays O(1)/doc regardless of
    // how many documents match the recall gate.
    assert.equal(fns.length, 2, 'expected bm25 + lexical floor');
    const floor = fns.find(f => f.filter && f.weight === searchConfig.minScore.relevant);
    assert.ok(floor, 'lexical-floor function missing');
    assert.equal(body.query.function_score.score_mode, 'sum');
    assert.equal(body.query.function_score.boost_mode, 'replace');
    assert.equal(body.min_score, searchConfig.minScore.relevant);
});

test('buildNormalizedHybridQuery bounds knn_score to a rescore window', () => {
    const qb = makeQB();
    const body = qb.buildNormalizedHybridQuery('machine learning', EMBED, {}, 1, 20);
    assert.ok(body.rescore, 'rescore block missing');
    assert.equal(body.rescore.window_size, searchConfig.rescoreWindow);
    const rescoreFns = body.rescore.query.rescore_query.function_score.functions;
    assert.equal(rescoreFns.length, 1);
    assert.equal(rescoreFns[0].script_score.script.lang, 'knn');
    assert.equal(rescoreFns[0].weight, searchConfig.hybridWeights.vector);
    assert.equal(body.rescore.query.query_weight, 1);
    assert.equal(body.rescore.query.rescore_query_weight, 1);
    assert.equal(body.rescore.query.score_mode, 'total');
});

test('buildNormalizedHybridQuery: rescore window covers deep pagination', () => {
    const qb = makeQB();
    const body = qb.buildNormalizedHybridQuery('machine learning', EMBED, {}, 50, 20); // from = 980
    assert.ok(body.rescore.window_size >= 980 + 20, 'rescore window must cover the requested page');
});

test('_resolveHybridWeights: lexical-rich leans BM25, sparse leans vector', () => {
    const qb = makeQB();
    const { adaptiveHybridWeights: a, hybridWeights: base } = searchConfig;
    assert.deepEqual(qb._resolveHybridWeights(60, 50), a.lexicalRich, 'ratio >= 1 -> lexical-rich');
    assert.deepEqual(qb._resolveHybridWeights(5, 50), a.semantic, 'ratio < 0.2 -> semantic');
    assert.deepEqual(qb._resolveHybridWeights(20, 50), base, 'mid ratio -> base');
    assert.deepEqual(qb._resolveHybridWeights(null, 50), base, 'no hint -> base');
});

test('_buildTitleCoverageClause: requires all terms, multi-word only', () => {
    const qb = makeQB();
    assert.equal(qb._buildTitleCoverageClause('quantum'), null);
    const clause = qb._buildTitleCoverageClause('machine learning');
    assert.equal(clause.match['title.standard'].operator, 'and');
    assert.equal(clause.match['title.standard'].boost, 5);
});

test('buildNormalizedHybridQuery: lexical-rich hint shifts BM25 weight into the script', () => {
    const qb = makeQB();
    const body = qb.buildNormalizedHybridQuery('machine learning', EMBED, {}, 1, 20, null, null, false, null, null, { bm25HitCount: 100, candidateK: 50 });
    const bm25Fn = body.query.function_score.functions.find(f => f.script_score?.script?.lang === 'painless');
    assert.ok(bm25Fn.script_score.script.source.startsWith(String(searchConfig.adaptiveHybridWeights.lexicalRich.bm25)));
});

test('buildStrictBm25Must: <=3 terms require all terms (must)', () => {
    const qb = makeQB();
    const clause = qb.buildStrictBm25Must('alpha beta gamma', ['title']);
    assert.ok(clause.bool.must);
    assert.equal(clause.bool.must.length, 3);
});

test('buildStrictBm25Must: 4+ terms relax to ~75% minimum_should_match', () => {
    const qb = makeQB();
    const clause = qb.buildStrictBm25Must('a b c d e f', ['title']);
    assert.ok(clause.bool.should);
    assert.equal(clause.bool.minimum_should_match, Math.max(3, Math.ceil(6 * 0.75)));
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
    body.query.function_score.query.bool.must[0].bool.should[0];

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
