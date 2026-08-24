import { test } from 'node:test';
import assert from 'node:assert/strict';
import QueryBuilder from '../../src/services/ipSearch/QueryBuilder.js';
import FilterBuilder from '../../src/services/ipSearch/FilterBuilder.js';
import { buildSearchConfig } from '../../src/services/ipSearch/constants.js';

const searchConfig = buildSearchConfig({});
const filterBuilder = new FilterBuilder(searchConfig);
const makeQB = () => new QueryBuilder({ searchConfig, filterBuilder });

const EMBED = new Array(8).fill(0.1);

// Structural traversal rather than a regex over the serialized body: a `knn` clause can carry a
// nested filter bool, so a non-greedy regex would stop at the first inner brace and silently
// truncate away exactly the sub-object these assertions are about.
function collect(node, key, out = []) {
    if (Array.isArray(node)) {
        for (const item of node) collect(item, key, out);
        return out;
    }
    if (!node || typeof node !== 'object') return out;
    if (node[key] && typeof node[key] === 'object') out.push(node[key]);
    for (const value of Object.values(node)) collect(value, key, out);
    return out;
}

const inventorMatchOpts = (node) =>
    collect(node, 'match')
        .filter((m) => m['inventors.name'] || m.inventor_names)
        .map((m) => Object.values(m)[0]);

// Regression: 'AUTO' fuzziness let a one-edit neighbour ("oncology" -> "ontology", "polymer" ->
// "polymers") match with no edit-distance score penalty, so the commoner wrong word outranked
// the rarer right one. Topic text in advanced mode must match exactly; genuine misspellings are
// IpSearchService._fuzzyFallbackSearch's job.
test('advanced topic text is matched exactly, not fuzzily', () => {
    const qb = makeQB();
    for (const body of [
        qb.buildNormalizedHybridQuery('oncology', EMBED, {}, 1, 20),
        qb.buildHybridQuery('oncology', EMBED, {}, 1, 20, 'date')
    ]) {
        const textArms = collect(body, 'multi_match');
        assert.ok(textArms.length > 0, 'expected a text multi_match arm');
        for (const arm of textArms) {
            assert.ok(!('fuzziness' in arm), `topic text stayed fuzzy: ${JSON.stringify(arm)}`);
        }
    }
});

test('advanced keeps inventor-name matching fuzzy (transliteration variants)', () => {
    const qb = makeQB();
    const body = qb.buildNormalizedHybridQuery('chatterjee', EMBED, {}, 1, 20);
    const bm25Arm = body.query.hybrid.queries[0].bool.must[0];
    const opts = inventorMatchOpts(bm25Arm);
    assert.ok(opts.length > 0, 'expected an inventor-name arm');
    assert.ok(opts.some((o) => o.fuzziness != null), 'inventor-name arms must stay fuzzy');
});

test('search_in topic fields match exactly while inventor stays fuzzy', () => {
    const qb = makeQB();
    const textOnly = { fuzziness: 'AUTO', textFuzziness: undefined };
    for (const searchIn of [['title', 'abstract'], ['field_of_invention'], ['classification']]) {
        const clause = qb.buildConstrainedSearchInClause('oncology', searchIn, textOnly);
        assert.ok(!JSON.stringify(clause).includes('fuzziness'), `${searchIn} must not be fuzzed`);
    }
    const inventorClause = qb.buildConstrainedSearchInClause('chatterjee', ['inventor'], textOnly);
    assert.ok(JSON.stringify(inventorClause).includes('fuzziness'), 'inventor names must stay fuzzy');
    // Omitting textFuzziness entirely (the fuzzy-fallback path) must still fuzz topic text.
    const fallback = qb.buildConstrainedSearchInClause('oncolgy', ['title'], { fuzziness: 2 });
    assert.ok(JSON.stringify(fallback).includes('fuzziness'), 'fallback path must stay fuzzy');
});

test('a facet filter never re-targets the ANN search', () => {
    // kNN returns its k nearest *within* whatever filter it is given, so pre-filtering a facet
    // made "top k nearest Patents" a different, larger pool than the Patents inside the unfiltered
    // top k — on the paper side a facet advertising 56 documents returned 307 once clicked.
    const qb = makeQB();
    const filters = { type_of_ip: 'Patent', department: 'Chemistry', year_from: 2010, primary_inventor_only: true };
    const bodies = [
        qb.buildNormalizedHybridQuery('polymer', EMBED, filters, 1, 20),
        qb.buildHybridQuery('polymer', EMBED, filters, 1, 20, 'date')
    ];
    for (const body of bodies) {
        const knnClauses = collect(body, 'knn');
        assert.ok(knnClauses.length > 0, 'expected a kNN arm');
        for (const knn of knnClauses) {
            const json = JSON.stringify(knn);
            for (const facet of ['type_of_ip', 'department_name', 'publication_year', 'inventor_position']) {
                assert.ok(!json.includes(facet), `facet filter ${facet} leaked into the ANN pre-filter: ${json}`);
            }
        }
        // ...but every facet filter is still enforced elsewhere in the query.
        const json = JSON.stringify(body);
        for (const facet of ['type_of_ip', 'department_name', 'publication_year', 'inventor_position']) {
            assert.ok(json.includes(facet), `facet filter ${facet} must still be applied`);
        }
    }
});

test('inventor scoping still pre-filters the ANN search', () => {
    // Scope filters must stay inside the kNN clause: a sibling filter runs kNN against the whole
    // index first, so an inventor whose patents miss the global top-k gets no kNN recall at all.
    const qb = makeQB();
    const body = qb.buildNormalizedHybridQuery(
        'polymer', EMBED, { kerberos: 'jdoe', type_of_ip: 'Patent' }, 1, 20, null,
        { allowKnnRecall: true }
    );
    const knnClauses = collect(body, 'knn');
    assert.ok(knnClauses.length > 0, 'expected a kNN arm');
    assert.ok(
        knnClauses.some((k) => JSON.stringify(k).includes('inventors.kerberos')),
        'kerberos scope should pre-filter kNN'
    );
});

test('allowKnnRecall is the inventor-scoped kNN opt-in, matching the paper stack', () => {
    const qb = makeQB();
    const scoped = { kerberos: 'jdoe' };
    assert.equal(collect(qb.buildNormalizedHybridQuery('polymer', EMBED, scoped, 1, 20), 'knn').length, 0);
    assert.ok(collect(qb.buildNormalizedHybridQuery('polymer', EMBED, scoped, 1, 20, null, { allowKnnRecall: true }), 'knn').length > 0);
    assert.equal(
        collect(qb.buildNormalizedHybridQuery('polymer', EMBED, scoped, 1, 20, null, { forceIncludeKnn: true }), 'knn').length,
        0,
        'the old forceIncludeKnn name must not be silently honoured'
    );
});

test('refine-chain clauses scope the ANN search as well as filtering it', () => {
    const qb = makeQB();
    const refineFilterClauses = [{ terms: { mongo_id: ['abc', 'def'] } }];
    for (const body of [
        qb.buildNormalizedHybridQuery('lithium', EMBED, {}, 1, 20, null, { refineChain: ['solar'], refineFilterClauses }),
        qb.buildHybridQuery('lithium', EMBED, {}, 1, 20, 'date', null, { refineChain: ['solar'], refineFilterClauses })
    ]) {
        const knnClauses = collect(body, 'knn');
        assert.ok(
            knnClauses.some((k) => JSON.stringify(k).includes('mongo_id')),
            'a refine chain narrows which corpus is searched, so it must scope kNN too'
        );
    }
});

test('buildScopeFilters keeps identity scoping and drops facet filters', () => {
    const filters = {
        kerberos: 'jdoe',
        year_from: 2010,
        type_of_ip: 'Patent',
        type_of_ip_list: ['Patent', 'Copyright'],
        field_of_invention: 'Chemical Engineering',
        classification: ['C08J'],
        department: 'Chemistry',
        country: 'IN',
        primary_inventor_only: true
    };
    const scope = filterBuilder.buildScopeFilters(filters);
    const scopeJson = JSON.stringify(scope);
    assert.ok(scopeJson.includes('inventors.kerberos'), 'kerberos scoping belongs in the kNN pre-filter');
    const facetSignals = [
        'publication_year', 'type_of_ip', 'field_of_invention', 'classification',
        'department_name', 'country', 'inventor_position'
    ];
    for (const facetSignal of facetSignals) {
        assert.ok(!scopeJson.includes(facetSignal), `${facetSignal} must not pre-filter the ANN search`);
    }
    // Scope filters are still enforced overall — they are a subset of the full filter list.
    const allJson = JSON.stringify(filterBuilder.buildFilters(filters));
    assert.ok(allJson.includes('inventors.kerberos'));
    for (const facetSignal of facetSignals) {
        assert.ok(allJson.includes(facetSignal), `${facetSignal} must still be enforced`);
    }
});

test('an inventor-scoped caller can shrink k below the corpus-wide default', () => {
    // A single inventor's pool is routinely smaller than the default k=100 (the portfolios
    // measured run 7-88 patents), so "top k nearest neighbours" there is just the whole pool and
    // kNN stops discriminating at all. InventorScopedSearch relies on this override for both the
    // refine-chain arm and its semantic-recall arm, so the parameter has to reach the clause.
    const qb = makeQB();
    const scoped = qb.buildNormalizedHybridQuery(
        'grid stability', EMBED, { kerberos: 'bkpanigrahi' }, 1, 20, null,
        { refineChain: ['grid'], knnK: 5 }
    );
    const ks = collect(scoped, 'embedding').map((e) => e.k);
    assert.ok(ks.length > 0, 'expected a kNN arm once a refine chain is active');
    assert.deepEqual(ks, [5]);
    // Unscoped corpus-wide search keeps the default: there the pool is far larger than k.
    assert.deepEqual(collect(qb.buildNormalizedHybridQuery('polymer', EMBED, {}, 1, 20), 'embedding').map((e) => e.k), [100]);
});

test('one stray fuzzy token is not enough to call a patent an inventor match', () => {
    // The flat `inventor_names` arm ORs its terms, so before this threshold a single junk token
    // landing within one edit of a real surname ("lll" -> "Lall") was reported as a name match.
    // That cleared advanced mode's admission gate and kNN answered the nonsense with ~100
    // unrelated patents; "jjj kkk lll mmm" returned 111 hits this way.
    const qb = makeQB();
    const flat = qb.buildInventorMatchClause('jjj kkk lll mmm', { fuzziness: 'AUTO' })
        .bool.should.find((c) => c.match?.inventor_names);
    assert.equal(flat.match.inventor_names.minimum_should_match, '2');
});

test('inventor matching forwards every fuzz option, not just fuzziness', () => {
    // The clause used to rebuild a fresh `{ fuzziness }`, silently dropping whatever else the
    // caller passed, so a caller tightening the match had no effect and no error.
    const qb = makeQB();
    const clause = qb.buildInventorMatchClause('chatterjee', { fuzziness: 'AUTO', prefix_length: 1 });
    const nested = clause.bool.should.find((c) => c.nested);
    assert.equal(nested.nested.query.bool.must[0].match['inventors.name'].prefix_length, 1);
    assert.equal(clause.bool.should.find((c) => c.match?.inventor_names).match.inventor_names.prefix_length, 1);
});

test('a real one- or two-word name query is unaffected by the corroboration threshold', () => {
    // Lucene requires ALL optional clauses when a query has fewer terms than the threshold, so
    // the guard above must not make short, genuine name searches unsatisfiable.
    const qb = makeQB();
    for (const name of ['deopura', 'bhim singh']) {
        const flat = qb.buildInventorMatchClause(name, { fuzziness: 'AUTO' })
            .bool.should.find((c) => c.match?.inventor_names);
        assert.equal(flat.match.inventor_names.query, name);
        assert.equal(flat.match.inventor_names.minimum_should_match, '2');
    }
});

test('the normalized-hybrid kNN arm carries facet filters as a sibling filter', () => {
    const qb = makeQB();
    const body = qb.buildNormalizedHybridQuery('polymer', EMBED, { type_of_ip: 'Patent' }, 1, 20);
    const knnArm = body.query.hybrid.queries[1];
    assert.ok(knnArm.bool.must[0].knn, 'expected the kNN arm');
    // Each hybrid arm filters independently: OpenSearch 2.19's `hybrid` query has no top-level
    // filter, so an unfiltered arm would re-admit documents the facet excluded.
    assert.ok(JSON.stringify(knnArm.bool.filter).includes('type_of_ip'), 'facet must narrow the kNN arm');
});
