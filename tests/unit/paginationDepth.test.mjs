import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePaginationDepth, withPaginationDepth, DEFAULT_STABLE_DEPTH } from '../../src/services/search/paginationDepth.js';

const hybridBody = (from, size) => ({ from, size, query: { hybrid: { queries: [{ match_all: {} }] } } });
const depthOf = (body) => body.query.hybrid.pagination_depth;

test('every page of a query fuses at the same depth', () => {
    // RRF ranks depend on how deep each arm goes, so a depth that moved with the page
    // reordered results between pages and showed the same paper twice.
    const depths = new Set();
    for (let page = 1; page <= 25; page++) {
        depths.add(depthOf(withPaginationDepth(hybridBody((page - 1) * 20, 20))));
    }
    assert.equal(depths.size, 1, `depth varied across pages: ${[...depths].join(', ')}`);
    assert.equal([...depths][0], DEFAULT_STABLE_DEPTH);
});

test('the reranked-window fetch and its straddle fetch agree on depth', () => {
    // A page that spans the reranked window issues a second raw fetch; if the two bodies
    // fused different pools the straddle could re-serve rows already in the window.
    const windowFetch = withPaginationDepth(hybridBody(0, 50));
    const straddleFetch = withPaginationDepth(hybridBody(50, 10));
    assert.equal(depthOf(windowFetch), depthOf(straddleFetch));
});

test('the count probe matches the page it reports on', () => {
    assert.equal(depthOf(withPaginationDepth(hybridBody(0, 0))), depthOf(withPaginationDepth(hybridBody(40, 20))));
});

test('pages past the stable floor still get a depth that covers them', () => {
    assert.equal(resolvePaginationDepth({ from: 900, size: 100 }), 1000);
});

test('depth never exceeds max_result_window', () => {
    assert.equal(resolvePaginationDepth({ from: 9990, size: 100, maxResultWindow: 10000 }), 10000);
});

test('candidateK larger than the floor still fits in the window', () => {
    assert.equal(resolvePaginationDepth({ from: 0, size: 20, candidateK: 800 }), 800);
});

test('non-hybrid bodies are returned untouched', () => {
    const body = { from: 0, size: 20, query: { match_all: {} } };
    assert.equal(withPaginationDepth(body), body);
});

test('the original body is not mutated, so sibling spreads stay independent', () => {
    const body = hybridBody(0, 20);
    const out = withPaginationDepth(body);
    assert.equal(body.query.hybrid.pagination_depth, undefined);
    assert.notEqual(out.query.hybrid, body.query.hybrid);
});
