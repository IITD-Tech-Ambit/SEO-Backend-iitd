import { test } from 'node:test';
import assert from 'node:assert/strict';
import InventorScopedSearch from '../../src/services/ipSearch/InventorScopedSearch.js';
import QueryBuilder from '../../src/services/ipSearch/QueryBuilder.js';
import FilterBuilder from '../../src/services/ipSearch/FilterBuilder.js';
import { buildSearchConfig } from '../../src/services/ipSearch/constants.js';

const searchConfig = buildSearchConfig({});
const filterBuilder = new FilterBuilder(searchConfig);
const queryBuilder = new QueryBuilder({ searchConfig, filterBuilder });

const EMBED = new Array(8).fill(0.1);
const KERBEROS = 'bkpanigrahi';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Classifies the request bodies InventorScopedSearch issues so a fake OpenSearch can answer each
 * one independently: the inventor patent-count probe, the loose lexical-grounding probe, the
 * refine-chain anchor lookup, and the main ranking query.
 */
function classify(body) {
    if (body?.query?.hybrid) {
        const isAnchor = Array.isArray(body._source) && body._source.length === 1 && body._source[0] === 'mongo_id';
        return isAnchor ? 'anchor' : 'ranking';
    }
    if (body?.query?.bool?.must?.[0]?.multi_match) return 'grounding';
    return 'inventorCount';
}

function armsOf(body) {
    return body?.query?.hybrid?.queries || [];
}

function hasKnnArm(body) {
    return armsOf(body).some(arm => arm?.bool?.must?.[0]?.knn?.embedding);
}

const hitsFor = (n) => Array.from({ length: n }, (_, i) => ({
    _source: { mongo_id: `doc${i}`, title: `Patent ${i}` },
    _score: 1 / (61 + i)
}));

/**
 * @param counts.ranking answers the main ranking query; a function receives the body so a test
 *   can return a different total for the widened (two-arm) query than the lexical-only one.
 */
function makeService({ ranking, grounding = 0, inventorPatents = 17, anchor = 3 } = {}) {
    const calls = [];
    const opensearch = {
        async search({ body }) {
            const kind = classify(body);
            calls.push({ kind, body });
            if (kind === 'inventorCount') return { body: { hits: { hits: [], total: { value: inventorPatents } } } };
            if (kind === 'grounding') {
                const q = body.query.bool.must[0].multi_match.query;
                const n = typeof grounding === 'function' ? grounding(q) : grounding;
                return { body: { hits: { hits: [], total: { value: n } } } };
            }
            if (kind === 'anchor') return { body: { hits: { hits: hitsFor(anchor), total: { value: anchor } } } };
            const n = typeof ranking === 'function' ? ranking(body) : ranking;
            return { body: { hits: { hits: hitsFor(Math.min(n, body.size ?? 20)), total: { value: n } } } };
        }
    };

    const service = new InventorScopedSearch({
        opensearch,
        indexName: 'ip_documents',
        mongoose: {
            model: () => ({
                findOne: () => ({
                    lean: async () => ({
                        firstName: 'Bijaya Ketan',
                        lastName: 'Panigrahi',
                        email: `${KERBEROS}@ee.iitd.ac.in`
                    })
                })
            })
        },
        redis: { get: async () => null, setex: async () => {} },
        redisTTL: { searchResults: 60 },
        logger: noopLogger,
        queryBuilder,
        filterBuilder,
        embeddingService: { embedQuery: async () => EMBED },
        hydrator: {
            hydrateFromMongoDB: async (hits) => hits.map(h => ({ _id: h._source.mongo_id, title: h._source.title })),
            applyFacultyDisplayNames: async () => {}
        }
    });

    return { service, calls };
}

const rankingQueries = (calls) => calls.filter(c => c.kind === 'ranking');

/**
 * The text each loose-lexical probe asked about. Two call sites share that probe shape: the
 * refine-chain anchor gate asks about a CHAIN TERM, while semantic widening asks about the MAIN
 * QUERY — so the probed text, not the count, is what tells them apart.
 */
const groundedTerms = (calls) => calls
    .filter(c => c.kind === 'grounding')
    .map(c => c.body.query.bool.must[0].multi_match.query);

const jsonOf = (v) => JSON.stringify(v);

// ── Semantic-recall arm shape ──

test('the semantic-recall arm uses a small k and keeps facet filters out of the ANN pre-filter', () => {
    // k is deliberately far below the corpus-wide default of 100: a single inventor's pool is
    // often smaller than k, at which point "top k nearest neighbours" is just the whole pool.
    const { service } = makeService();
    const facet = { term: { type_of_ip: 'Patent' } };
    const bm25Arm = { bool: { must: [{ match: { title: 'grid stability' } }], filter: [facet] } };

    const arm = service._buildSemanticRecallArm(EMBED, bm25Arm, null, {});
    const knn = arm.bool.must[0].knn.embedding;

    assert.ok(knn.k > 0 && knn.k <= 10, `expected a small k, got ${knn.k}`);
    assert.equal(knn.filter, undefined, 'no scope filters means no ANN pre-filter');
    assert.deepEqual(arm.bool.filter, [facet], 'facet filters stay a sibling so they cannot re-target the ANN search');
});

test('the semantic-recall arm pre-filters the inventor scope from inside the kNN clause', () => {
    // A sibling filter would run kNN against the whole index first, so an inventor whose patents
    // miss the corpus-wide top-k would earn no semantic recall at all — exactly the recall this
    // arm exists to provide.
    const { service } = makeService();
    const facet = { term: { type_of_ip: 'Patent' } };
    const bm25Arm = { bool: { must: [{ match: { title: 'grid stability' } }], filter: [facet] } };

    const arm = service._buildSemanticRecallArm(EMBED, bm25Arm, null, { kerberos: KERBEROS, type_of_ip: 'Patent' });
    const preFilter = arm.bool.must[0].knn.embedding.filter.bool.filter;

    assert.ok(jsonOf(preFilter).includes('inventors.kerberos'), 'the inventor scope must pre-filter kNN');
    assert.ok(!jsonOf(preFilter).includes('type_of_ip'), 'a facet must not pre-filter kNN');
});

test('the semantic-recall arm is gated on the lexical clause when search_in is set', () => {
    // search_in asserts the term actually OCCURS in the selected field, so the ANN arm is gated on
    // the lexical arm's own admission clause: it may reorder in-scope patents but never admit an
    // off-scope one on overall topical similarity alone.
    const { service } = makeService();
    const lexical = { match: { 'title.standard': 'grid' } };
    const bm25Arm = { bool: { must: [lexical], filter: [] } };

    const arm = service._buildSemanticRecallArm(EMBED, bm25Arm, ['title'], { kerberos: KERBEROS });
    const preFilter = arm.bool.must[0].knn.embedding.filter.bool.filter;

    assert.ok(preFilter.some(c => jsonOf(c) === jsonOf(lexical)), 'search_in must gate the ANN arm');
});

test('the semantic-recall arm is not gated on the lexical clause without search_in', () => {
    const { service } = makeService();
    const bm25Arm = { bool: { must: [{ match: { title: 'photovoltaic' } }], filter: [] } };
    const arm = service._buildSemanticRecallArm(EMBED, bm25Arm, null, { kerberos: KERBEROS });
    assert.ok(!jsonOf(arm).includes('photovoltaic'), 'an unscoped query must not gate kNN on the lexical clause');
});

// ── Lexical-grounding probe ──

test('the grounding probe is an any-term OR scoped to the inventor', () => {
    // Deliberately looser than the ranking arm's AND-of-all-terms conjunction: the question is
    // "does this inventor patent about ANY of these words", not "does one patent contain all".
    const { service, calls } = makeService({ grounding: 9 });

    return service._countInventorLexicalGrounding('grid stability', null, { kerberos: KERBEROS }).then((count) => {
        assert.equal(count, 9);
        const probe = calls.find(c => c.kind === 'grounding');
        assert.ok(probe, 'expected a grounding probe');
        assert.equal(probe.body.query.bool.must[0].multi_match.minimum_should_match, '1');
        assert.ok(jsonOf(probe.body.query.bool.filter).includes('inventors.kerberos'), 'the probe must stay inventor-scoped');
        assert.equal(probe.body.size, 0, 'the probe only needs a count');
    });
});

test('the grounding probe is skipped for an inventor-only search_in', async () => {
    // getSearchFields(['inventor']) is deliberately empty: an identity lookup has no topical
    // neighbourhood to widen into, and a multi_match over zero fields is not a valid query.
    const { service, calls } = makeService();
    const count = await service._countInventorLexicalGrounding('panigrahi', ['inventor'], { kerberos: KERBEROS });
    assert.equal(count, 0);
    assert.equal(calls.filter(c => c.kind === 'grounding').length, 0);
});

// ── Widening policy ──

test('a degenerate lexical result set is widened with a semantic arm', async () => {
    // Inside one inventor's portfolio the lexical arm is an AND-of-all-terms conjunction over
    // ~10^1-10^2 patents, so "grid stability" matched 0 of Prof Panigrahi's 17 patents while 9
    // mention grid. Widening recovers those without touching the lexical ranking.
    const { service, calls } = makeService({
        ranking: (body) => (hasKnnArm(body) ? 5 : 0),
        grounding: 9
    });

    const res = await service.search({ query: 'grid stability', inventor_id: KERBEROS, per_page: 20 });

    assert.equal(res.pagination.total, 5);
    const ranked = rankingQueries(calls);
    assert.equal(ranked.length, 2, 'expected a lexical query followed by a widened retry');
    assert.equal(armsOf(ranked[0].body).length, 1, 'the first query must stay lexical-only');
    assert.equal(armsOf(ranked[1].body).length, 2, 'the retry adds exactly one arm');
    assert.ok(hasKnnArm(ranked[1].body), 'the added arm is the kNN arm');
    assert.deepEqual(groundedTerms(calls), ['grid stability'], 'widening probes the main query');
});

test('a single stray lexical hit still counts as degenerate', async () => {
    // One hit is a dead end, not a ranked list: measured, "drug delivery" matched 1 of Prof Veena
    // Koul's 8 patents while the co-delivery, drug-release and hydrogel patents sat right there.
    const { service, calls } = makeService({ ranking: (body) => (hasKnnArm(body) ? 5 : 1), grounding: 2 });

    const res = await service.search({ query: 'drug delivery', inventor_id: KERBEROS, per_page: 20 });

    assert.equal(res.pagination.total, 5);
    assert.equal(rankingQueries(calls).length, 2);
});

test('widening only ever adds an arm, so the lexical arm still ranks unchanged', async () => {
    const { service, calls } = makeService({ ranking: (body) => (hasKnnArm(body) ? 5 : 0), grounding: 3 });
    await service.search({ query: 'catalytic conversion', inventor_id: KERBEROS, per_page: 20 });

    const ranked = rankingQueries(calls);
    assert.equal(
        jsonOf(armsOf(ranked[1].body)[0]), jsonOf(armsOf(ranked[0].body)[0]),
        'the lexical arm must be byte-identical after widening'
    );
});

test('an ungrounded query is NOT widened, so gibberish stays at zero results', async () => {
    // The precision guard. A kNN arm returns nearest neighbours for ANY vector, so widening on an
    // empty result set alone would answer "qwxzjkvbnm" with a page of this inventor's patents.
    const { service, calls } = makeService({ ranking: 0, grounding: 0 });

    const res = await service.search({ query: 'qwxzjkvbnm', inventor_id: KERBEROS, per_page: 20 });

    assert.equal(res.pagination.total, 0);
    assert.deepEqual(res.results, []);
    assert.equal(rankingQueries(calls).length, 1, 'no widened retry may be issued');
    assert.ok(calls.some(c => c.kind === 'grounding'), 'the grounding probe should have run and vetoed widening');
});

test('a healthy lexical result set is left alone — no probe, no widening', async () => {
    const { service, calls } = makeService({ ranking: 29, grounding: 29 });

    const res = await service.search({ query: 'photovoltaic', inventor_id: KERBEROS, per_page: 10 });

    assert.equal(res.pagination.total, 29);
    assert.equal(rankingQueries(calls).length, 1);
    assert.equal(calls.filter(c => c.kind === 'grounding').length, 0, 'a healthy result set must not cost an extra probe');
});

test('a result set exactly at the useful-hits threshold is left alone', async () => {
    // Boundary: MIN_USEFUL_LEXICAL_HITS is the first total the user can actually page through, so
    // it must be treated as healthy — widening there would change totals for ordinary queries.
    const { service, calls } = makeService({ ranking: 2, grounding: 5 });

    const res = await service.search({ query: 'catalytic conversion', inventor_id: KERBEROS, per_page: 20 });

    assert.equal(res.pagination.total, 2);
    assert.equal(rankingQueries(calls).length, 1);
    assert.equal(calls.filter(c => c.kind === 'grounding').length, 0);
});

test('basic mode is never widened', async () => {
    const { service, calls } = makeService({ ranking: 1, grounding: 9 });

    await service.search({ query: 'grid stability', inventor_id: KERBEROS, per_page: 20, mode: 'basic' });

    assert.equal(calls.filter(c => c.kind === 'grounding').length, 0);
    assert.ok(!calls.some(c => c.kind === 'ranking'), 'basic mode issues a plain bool query, not a hybrid one');
});

test('a filter-only browse is never widened', async () => {
    // An empty query has no vector worth taking nearest neighbours of, and the browse body is not
    // a hybrid query at all — it already returns this inventor's whole filtered portfolio.
    const { service, calls } = makeService({ ranking: 0, grounding: 9 });

    await service.search({ query: '  ', inventor_id: KERBEROS, per_page: 20 });

    assert.equal(calls.filter(c => c.kind === 'grounding').length, 0);
    assert.ok(!calls.some(c => c.kind === 'ranking'), 'a browse issues a filter-only body, not a hybrid one');
});

test('a refine chain is never widened: kNN is already admitted there', async () => {
    // buildNormalizedHybridQuery admits kNN itself once a chain is active, so the body already has
    // two arms and there is nothing to widen. Widening it would also break monotonic narrowing.
    const { service, calls } = makeService({ ranking: 1, grounding: 9 });

    await service.search({ query: 'stability', inventor_id: KERBEROS, per_page: 20, refine_chain: ['grid'] });

    const ranked = rankingQueries(calls);
    assert.equal(ranked.length, 1, 'no widened retry for a refine-chain query');
    assert.equal(armsOf(ranked[0].body).length, 2, 'the chain already admitted the kNN arm');
    assert.deepEqual(
        groundedTerms(calls), ['grid', 'stability'],
        'anchor gate first, then the newest query is probed so kNN cannot admit a nonsense refine'
    );
});

test('an inventor-only search_in query is never widened', async () => {
    // The grounding probe has no topical fields to ask about there, so it can only ever return 0 —
    // asserting the veto holds end to end rather than only inside the probe.
    const { service, calls } = makeService({ ranking: 0, grounding: 9 });

    const res = await service.search({ query: 'panigrahi', inventor_id: KERBEROS, per_page: 20, search_in: ['inventor'] });

    assert.equal(res.pagination.total, 0);
    assert.equal(rankingQueries(calls).length, 1, 'no widened retry may be issued');
});

test('widening keeps a selected facet enforced on both arms', async () => {
    // OpenSearch 2.19's `hybrid` query has no top-level filter, so an unfiltered added arm would
    // re-admit patents the facet excluded — the widened total would then exceed the facet count.
    const { service, calls } = makeService({ ranking: (body) => (hasKnnArm(body) ? 5 : 0), grounding: 9 });

    await service.search({
        query: 'grid stability', inventor_id: KERBEROS, per_page: 20,
        filters: { type_of_ip: 'Patent' }
    });

    const widened = rankingQueries(calls)[1].body;
    for (const arm of armsOf(widened)) {
        assert.ok(jsonOf(arm.bool.filter).includes('type_of_ip'), `an arm escaped the facet filter: ${jsonOf(arm)}`);
    }
});

// ── Refine-chain anchor gate ──

test('an anchor term absent from this inventor collapses to match_none instead of widening', async () => {
    // The anchor lookup falls back to a kNN-inclusive rerun when BM25 finds nothing, and kNN
    // returns nearest neighbours for ANY vector — so without this gate a gibberish refine term
    // invents a membership set and the refinement BROADENS. The fake index honours the
    // unsatisfiable filter here so the collapse is observable end to end.
    const { service, calls } = makeService({
        ranking: (body) => (jsonOf(body).includes('match_none') ? 0 : 20),
        grounding: (q) => (q === 'qwxzjkvbnm' ? 0 : 20),
        anchor: 3
    });

    const res = await service.search({ query: 'grid', inventor_id: KERBEROS, per_page: 20, refine_chain: ['qwxzjkvbnm'] });

    assert.ok(groundedTerms(calls).includes('qwxzjkvbnm'), 'the gate probes the anchor term');
    assert.equal(calls.filter(c => c.kind === 'anchor').length, 0, 'a gated-out anchor never runs the widening-capable lookup');
    assert.ok(jsonOf(rankingQueries(calls)[0].body).includes('match_none'), 'the anchor must contribute an unsatisfiable filter');
    assert.equal(res.pagination.total, 0, 'refining by a term this inventor never used yields nothing');
});

test('a grounded anchor keeps its id membership and ORs the term back in', async () => {
    // The id list is capped by the anchor query's result window, so filtering on that truncated
    // slice ALONE drops patents basic mode keeps; the literal clause restores exactly those.
    const { service, calls } = makeService({ ranking: 20, grounding: 9, anchor: 3 });

    await service.search({ query: 'stability', inventor_id: KERBEROS, per_page: 20, refine_chain: ['grid'] });

    assert.equal(calls.filter(c => c.kind === 'anchor').length, 1, 'a grounded anchor still runs its ranking-aware lookup');
    const body = jsonOf(rankingQueries(calls)[0].body);
    assert.ok(body.includes('doc0'), 'the matched ids are used as a membership filter');
    assert.ok(!body.includes('match_none'), 'a grounded anchor is never collapsed');
});

test('an ungrounded newest query inside a real refine chain stays empty', async () => {
    const { service, calls } = makeService({
        ranking: 20,
        grounding: (q) => (q === 'qwxzjkvbnm' ? 0 : 9),
        anchor: 3
    });

    const res = await service.search({
        query: 'qwxzjkvbnm', inventor_id: KERBEROS, per_page: 20, refine_chain: ['grid']
    });

    assert.equal(res.pagination.total, 0);
    assert.deepEqual(res.results, []);
    assert.equal(rankingQueries(calls).length, 0, 'kNN must not run inside the refined id set');
    assert.ok(groundedTerms(calls).includes('qwxzjkvbnm'), 'the newest query is probed');
    assert.ok(groundedTerms(calls).includes('grid'), 'the anchor is still gated');
});
