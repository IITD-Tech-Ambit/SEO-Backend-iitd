import { test } from 'node:test';
import assert from 'node:assert/strict';
import AuthorScopedSearch from '../../src/services/search/AuthorScopedSearch.js';
import QueryBuilder from '../../src/services/search/QueryBuilder.js';
import FilterBuilder from '../../src/services/search/FilterBuilder.js';
import { buildSearchConfig } from '../../src/services/search/constants.js';

const searchConfig = buildSearchConfig({});
const filterBuilder = new FilterBuilder(searchConfig);
const queryBuilder = new QueryBuilder({
    searchConfig,
    filterBuilder,
    rosterService: { current: () => ['111', '222'] }
});

const EMBED = new Array(8).fill(0.1);
const AUTHOR_FILTER = {
    bool: {
        should: [{ nested: { path: 'authors', query: { terms: { 'authors.author_id': ['36789930200'] } } } }],
        minimum_should_match: 1
    }
};

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Classifies the request bodies AuthorScopedSearch issues so a fake OpenSearch can answer each
 * one independently: the author paper-count probe, the loose lexical-grounding probe, the
 * refine-chain anchor lookup, and the main ranking query.
 */
function classify(body) {
    if (body?.query?.hybrid) {
        const isAnchor = Array.isArray(body._source) && body._source.length === 1 && body._source[0] === 'mongo_id';
        return isAnchor ? 'anchor' : 'ranking';
    }
    if (body?.query?.bool?.must?.[0]?.multi_match) return 'grounding';
    return 'authorCount';
}

function armsOf(body) {
    return body?.query?.hybrid?.queries || [];
}

function hasKnnArm(body) {
    return armsOf(body).some(arm => arm?.bool?.must?.[0]?.knn?.embedding);
}

const hitsFor = (n) => Array.from({ length: n }, (_, i) => ({
    _source: { mongo_id: `doc${i}`, title: `Paper ${i}` },
    _score: 1 / (61 + i)
}));

/**
 * @param counts.ranking answers the main ranking query; a function receives the body so a test
 *   can return a different total for the widened (two-arm) query than the lexical-only one.
 */
function makeService({ ranking, grounding = 0, authorPapers = 144, anchor = 3 } = {}) {
    const calls = [];
    const opensearch = {
        async search({ body }) {
            const kind = classify(body);
            calls.push({ kind, body });
            if (kind === 'authorCount') return { body: { hits: { hits: [], total: { value: authorPapers } } } };
            if (kind === 'grounding') return { body: { hits: { hits: [], total: { value: grounding } } } };
            if (kind === 'anchor') return { body: { hits: { hits: hitsFor(anchor), total: { value: anchor } } } };
            const n = typeof ranking === 'function' ? ranking(body) : ranking;
            return { body: { hits: { hits: hitsFor(Math.min(n, body.size ?? 20)), total: { value: n } } } };
        }
    };

    const service = new AuthorScopedSearch({
        opensearch,
        indexName: 'research_documents',
        mongoose: {
            model: () => ({
                findOne: () => ({
                    lean: async () => ({
                        firstName: 'Abhijit',
                        lastName: 'Abhyankar',
                        scopus_id: ['36789930200'],
                        email: 'abhijit@ee.iitd.ac.in'
                    })
                })
            })
        },
        redis: { get: async () => null, setex: async () => {} },
        redisTTL: { searchResults: 60 },
        logger: noopLogger,
        queryBuilder,
        filterBuilder,
        rosterService: {
            getAll: async () => {},
            current: () => ['111', '222'],
            resolveScopusIdsForAuthorQuery: async () => ({ scopusIds: [], kerberosIds: [] })
        },
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

// ── Author scoping placement ──

test('the author filter pre-filters the kNN arm from the inside, not as a sibling', () => {
    // Regression: the kNN arm buildNormalizedHybridQuery produces also carries a sibling
    // `bool.filter` array (buildFilters returns [] rather than undefined when there are no
    // facets), so an `Array.isArray(arm.bool.filter)` test placed first matched the kNN arm too
    // and scoped it the one way it must not be scoped — a sibling filter runs kNN against the
    // whole index first, so this author's papers get no kNN recall unless they happen to land in
    // the corpus-wide top-k.
    const { service } = makeService();
    const knnArm = { bool: { must: [{ knn: { embedding: { vector: EMBED, k: 5 } } }], filter: [] } };
    const body = { query: { hybrid: { queries: [knnArm] } } };

    service._scopeHybridQueryToAuthor(body, AUTHOR_FILTER);

    assert.deepEqual(knnArm.bool.must[0].knn.embedding.filter.bool.filter, [AUTHOR_FILTER]);
    assert.deepEqual(knnArm.bool.filter, [], 'the author filter must not also land on the sibling filter');
});

test('the author filter appends to an existing kNN pre-filter rather than replacing it', () => {
    const { service } = makeService();
    const existing = { term: { publication_year: 2020 } };
    const knnArm = {
        bool: {
            must: [{ knn: { embedding: { vector: EMBED, k: 5, filter: { bool: { filter: [existing] } } } } }],
            filter: []
        }
    };
    service._scopeHybridQueryToAuthor({ query: { hybrid: { queries: [knnArm] } } }, AUTHOR_FILTER);
    assert.deepEqual(knnArm.bool.must[0].knn.embedding.filter.bool.filter, [existing, AUTHOR_FILTER]);
});

test('the author filter goes on the sibling filter of a lexical arm', () => {
    const { service } = makeService();
    const bm25Arm = { bool: { must: [{ match: { title: 'grid' } }], should: [], filter: [] } };
    service._scopeHybridQueryToAuthor({ query: { hybrid: { queries: [bm25Arm] } } }, AUTHOR_FILTER);
    assert.deepEqual(bm25Arm.bool.filter, [AUTHOR_FILTER]);
});

// ── Semantic-recall arm shape ──

/**
 * Runs a query whose lexical recall is degenerate but grounded, so widening fires, and returns
 * the kNN arm of the widened retry. The arm comes from QueryBuilder (opted into per request), so
 * these assertions are what pins the shape this service depends on getting back.
 */
async function widenedKnnArm({ search_in = null, filters = null } = {}) {
    const { service, calls } = makeService({ ranking: (body) => (hasKnnArm(body) ? 15 : 1), grounding: 45 });
    await service.search({ query: 'photovoltaic', author_id: '60793', per_page: 20, search_in, filters });
    const ranked = rankingQueries(calls);
    assert.equal(ranked.length, 2, 'expected a lexical query followed by a widened retry');
    const arm = armsOf(ranked[1].body).find(a => a?.bool?.must?.[0]?.knn?.embedding);
    assert.ok(arm, 'the widened retry must carry a kNN arm');
    return arm;
}

test('the semantic-recall arm uses a small k and keeps facet filters out of the ANN pre-filter', async () => {
    // k is deliberately far below the corpus-wide default of 100: a single author's pool is often
    // smaller than k, at which point "top k nearest neighbours" is just the whole pool.
    const arm = await widenedKnnArm({ filters: { document_type: 'Book Chapter' } });
    const knn = arm.bool.must[0].knn.embedding;

    assert.ok(knn.k > 0 && knn.k <= 10, `expected a small k, got ${knn.k}`);
    assert.ok(!JSON.stringify(knn.filter).includes('Book Chapter'), 'a facet must not re-target the ANN search');
    assert.ok(JSON.stringify(arm.bool.filter).includes('Book Chapter'), 'the facet is applied as a sibling filter');
});

test('the semantic-recall arm is pre-filtered to this author from the inside', async () => {
    // A sibling filter would run kNN against the whole index first, so this author's papers would
    // only earn recall if they happened to land in the corpus-wide top-k.
    const arm = await widenedKnnArm();
    const preFilter = arm.bool.must[0].knn.embedding.filter.bool.filter;
    assert.ok(JSON.stringify(preFilter).includes('authors.author_id'), 'the author scope must pre-filter kNN');
});

test('the semantic-recall arm gates on search_in', async () => {
    // search_in asserts the term actually OCCURS in the selected field, so the ANN arm is gated on
    // the lexical arm's own admission clause: it may reorder in-scope documents but never admit an
    // off-scope one on overall topical similarity alone.
    const arm = await widenedKnnArm({ search_in: ['title'] });
    const gate = JSON.stringify(arm.bool.must[0].knn.embedding.filter);
    assert.ok(gate.includes('photovoltaic'), 'the query term must be required');
    assert.ok(gate.includes('title'), 'the selected field must be required');
    assert.ok(!gate.includes('abstract'), 'an abstract-only match is off-scope');
});

test('the semantic-recall arm is not gated when no search_in is set', async () => {
    const arm = await widenedKnnArm();
    assert.ok(!JSON.stringify(arm).includes('photovoltaic'), 'an unscoped query must not gate kNN on the lexical clause');
});

test('widening is requested from the builder, never assembled here', async () => {
    // The builder rejects a recall option it would have to discard, so a request that reaches
    // OpenSearch at all is a request whose recall options were honoured. Assembling an arm here
    // instead would be accepted silently and then drift out of sync with the builder's own arm
    // (scope filters inside the knn filter, facets as a sibling, k sized for one author's pool).
    const { service, calls } = makeService({ ranking: (body) => (hasKnnArm(body) ? 15 : 1), grounding: 45 });
    const optionsSeen = [];
    service.queryBuilder = Object.assign(Object.create(queryBuilder), {
        buildNormalizedHybridQuery(...args) {
            optionsSeen.push(args.at(-1));
            return queryBuilder.buildNormalizedHybridQuery(...args);
        }
    });

    await service.search({ query: 'photovoltaic', author_id: '60793', per_page: 20 });

    assert.equal(rankingQueries(calls).length, 2);
    assert.equal(optionsSeen.length, 2, 'both the lexical query and the retry come from the builder');
    assert.ok(!optionsSeen[0].allowKnnRecall, 'the first query must not ask for semantic recall');
    assert.equal(optionsSeen[1].allowKnnRecall, true, 'the retry asks for it through the documented opt-in');
});

// ── Lexical-grounding probe ──

test('the grounding probe is an any-term OR scoped to the author', () => {
    // Deliberately looser than the ranking arm's AND-of-all-terms conjunction: the question is
    // "does this author write about ANY of these words", not "does one paper contain all of them".
    const { service, calls } = makeService({ grounding: 45 });
    return service._countAuthorLexicalGrounding('grid stability', null, AUTHOR_FILTER, {}).then((count) => {
        assert.equal(count, 45);
        const probe = calls.find(c => c.kind === 'grounding');
        assert.ok(probe, 'expected a grounding probe');
        assert.equal(probe.body.query.bool.must[0].multi_match.minimum_should_match, '1');
        assert.deepEqual(probe.body.query.bool.filter[0], AUTHOR_FILTER);
        assert.equal(probe.body.size, 0, 'the probe only needs a count');
    });
});

test('the grounding probe is skipped for an author-only search_in', async () => {
    // getSearchFields(['author']) is deliberately empty: an identity lookup has no topical
    // neighbourhood to widen into, and a multi_match over zero fields is not a valid query.
    const { service, calls } = makeService();
    const count = await service._countAuthorLexicalGrounding('Abhyankar', ['author'], AUTHOR_FILTER, {});
    assert.equal(count, 0);
    assert.equal(calls.filter(c => c.kind === 'grounding').length, 0);
});

// ── Widening policy ──

test('a degenerate lexical result set is widened with a semantic arm', async () => {
    // Inside one author's portfolio the lexical arm is an AND-of-all-terms conjunction over ~10^2
    // papers, so "grid stability" matched 1 of Prof Abhyankar's 144 papers while 34 mention grid
    // and 12 mention stability. Widening recovers those without touching the lexical ranking.
    const { service, calls } = makeService({
        ranking: (body) => (hasKnnArm(body) ? 16 : 1),
        grounding: 45
    });

    const res = await service.search({ query: 'grid stability', author_id: '60793', per_page: 20 });

    assert.equal(res.pagination.total, 16);
    const ranked = rankingQueries(calls);
    assert.equal(ranked.length, 2, 'expected a lexical query followed by a widened retry');
    assert.equal(armsOf(ranked[0].body).length, 1, 'the first query must stay lexical-only');
    assert.equal(armsOf(ranked[1].body).length, 2, 'the retry adds exactly one arm');
    assert.ok(hasKnnArm(ranked[1].body), 'the added arm is the kNN arm');
});

test('widening only ever adds an arm, so the lexical arm still ranks unchanged', async () => {
    const { service, calls } = makeService({ ranking: (body) => (hasKnnArm(body) ? 15 : 1), grounding: 1 });
    await service.search({ query: 'photovoltaic', author_id: '60793', per_page: 20 });

    const ranked = rankingQueries(calls);
    const lexicalArmBefore = JSON.stringify(armsOf(ranked[0].body)[0]);
    const lexicalArmAfter = JSON.stringify(armsOf(ranked[1].body)[0]);
    assert.equal(lexicalArmAfter, lexicalArmBefore, 'the lexical arm must be byte-identical after widening');
});

test('an ungrounded query is NOT widened, so gibberish stays at zero results', async () => {
    // The precision guard. A kNN arm returns nearest neighbours for ANY vector, so widening on an
    // empty result set alone would answer "qwxzjkvbnm" with a page of this author's papers.
    const { service, calls } = makeService({ ranking: 0, grounding: 0 });

    const res = await service.search({ query: 'qwxzjkvbnm', author_id: '60793', per_page: 20 });

    assert.equal(res.pagination.total, 0);
    assert.equal(res.results.length, 0);
    assert.equal(rankingQueries(calls).length, 1, 'no widened retry may be issued');
    assert.ok(calls.some(c => c.kind === 'grounding'), 'the grounding probe should have run and vetoed widening');
});

test('a healthy lexical result set is left alone — no probe, no widening', async () => {
    const { service, calls } = makeService({ ranking: 109, grounding: 109 });

    const res = await service.search({ query: 'power', author_id: '60793', per_page: 10 });

    assert.equal(res.pagination.total, 109);
    assert.equal(rankingQueries(calls).length, 1);
    assert.equal(calls.filter(c => c.kind === 'grounding').length, 0, 'a healthy result set must not cost an extra probe');
});

test('basic mode is never widened', async () => {
    const { service, calls } = makeService({ ranking: 1, grounding: 45 });

    await service.search({ query: 'grid stability', author_id: '60793', per_page: 20, mode: 'basic' });

    assert.equal(calls.filter(c => c.kind === 'grounding').length, 0);
    assert.ok(!calls.some(c => c.kind === 'ranking'), 'basic mode issues a plain bool query, not a hybrid one');
});

test('a refine chain is never widened: kNN is already admitted there', async () => {
    // buildNormalizedHybridQuery admits kNN itself once a chain is active, so the body already has
    // two arms and there is nothing to widen. Widening it would also break monotonic narrowing.
    const { service, calls } = makeService({ ranking: 1, grounding: 45 });

    await service.search({ query: 'solar', author_id: '60793', per_page: 20, refine_chain: ['energy'] });

    const ranked = rankingQueries(calls);
    assert.equal(ranked.length, 1, 'no widened retry for a refine-chain query');
    assert.equal(armsOf(ranked[0].body).length, 2, 'the chain already admitted the kNN arm');
    assert.deepEqual(
        groundedTerms(calls), ['energy'],
        'the only probe is the anchor gate for the chain term; the main query is never probed for widening here'
    );
});

// ── Refine-chain anchor gate ──

test('an anchor term absent from this author collapses to match_none instead of widening', async () => {
    // The anchor lookup falls back to a kNN-inclusive rerun when BM25 finds nothing, and kNN
    // returns nearest neighbours for ANY vector — so without this gate a gibberish refine term
    // invents a membership set and the refinement BROADENS. Measured against the live index:
    // refining "energy" by "qwxzjkvbnm" returned 152 of the author's papers instead of none.
    // The fake index honours an unsatisfiable filter here so the collapse is observable end to
    // end, rather than only as a clause in the request body.
    const { service, calls } = makeService({
        ranking: (body) => (JSON.stringify(body).includes('match_none') ? 0 : 20),
        grounding: 0,
        anchor: 3
    });

    const res = await service.search({ query: 'energy', author_id: '60793', per_page: 20, refine_chain: ['qwxzjkvbnm'] });

    assert.deepEqual(groundedTerms(calls), ['qwxzjkvbnm'], 'the gate probes the anchor term');
    assert.equal(calls.filter(c => c.kind === 'anchor').length, 0, 'a gated-out anchor never runs the widening-capable lookup');
    const filters = JSON.stringify(rankingQueries(calls)[0].body);
    assert.ok(filters.includes('match_none'), 'the anchor must contribute an unsatisfiable filter');
    assert.equal(res.pagination.total, 0, 'refining by a term this author never used yields nothing');
});

test('a grounded anchor keeps its id membership and ORs the term back in', async () => {
    // The id list is capped by the anchor query's result window, so filtering on that truncated
    // slice ALONE drops documents basic mode keeps; the literal clause restores exactly those.
    const { service, calls } = makeService({ ranking: 20, grounding: 45, anchor: 3 });

    await service.search({ query: 'energy', author_id: '60793', per_page: 20, refine_chain: ['solar'] });

    assert.equal(calls.filter(c => c.kind === 'anchor').length, 1, 'a grounded anchor still runs its ranking-aware lookup');
    const body = JSON.stringify(rankingQueries(calls)[0].body);
    assert.ok(body.includes('doc0'), 'the matched ids are used as a membership filter');
    assert.ok(!body.includes('match_none'), 'a grounded anchor is never collapsed');
});
