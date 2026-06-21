import { test } from 'node:test';
import assert from 'node:assert/strict';
import QueryBuilder from '../../src/services/search/QueryBuilder.js';
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
    assert.equal(tiers.length, 4);
    // Tier 1 = exact phrase on title with the highest boost.
    assert.equal(tiers[0].match_phrase.title.slop, 0);
    assert.equal(tiers[0].match_phrase.title.boost, 20);
    // Later tiers are weaker (exact title > near title > abstract).
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
    assert.equal(fns.length, 3, 'expected bm25 + knn + lexical floor');
    const floor = fns.find(f => f.filter && f.weight === searchConfig.minScore.relevant);
    assert.ok(floor, 'lexical-floor function missing');
    assert.equal(body.query.function_score.score_mode, 'sum');
    assert.equal(body.query.function_score.boost_mode, 'replace');
    assert.equal(body.min_score, searchConfig.minScore.relevant);
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
