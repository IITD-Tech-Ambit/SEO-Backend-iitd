import test from 'node:test';
import assert from 'node:assert/strict';
import { isPastEndOfResults } from '../../src/services/search/hybridErrors.js';

const responseError = (rootCause) => ({
    name: 'ResponseError',
    meta: {
        statusCode: 400,
        body: {
            error: {
                type: 'search_phase_execution_exception',
                reason: 'all shards failed',
                root_cause: [rootCause],
                failed_shards: [{ shard: 0, index: 'ip_documents', reason: rootCause }]
            },
            status: 400
        }
    }
});

test('a page past the end of a hybrid result set is recognised', () => {
    // The distinguishing text is nested under a generic search_phase_execution_exception, so
    // the predicate has to reach past the outer type to find it.
    assert.equal(isPastEndOfResults(responseError({
        type: 'illegal_argument_exception',
        reason: 'Reached end of search result, increase pagination_depth value to see more results'
    })), true);
});

test('an unrelated illegal-argument failure is not swallowed', () => {
    // Same outer exception type as the past-end case, so matching on type alone would turn a
    // real query bug into a silent empty page.
    assert.equal(isPastEndOfResults(responseError({
        type: 'illegal_argument_exception',
        reason: 'Fielddata is disabled on text fields by default. Set fielddata=true on [title]'
    })), false);
});

test('an unrelated OpenSearch error keeps propagating', () => {
    assert.equal(isPastEndOfResults(responseError({
        type: 'index_not_found_exception',
        reason: 'no such index [ip_documents]'
    })), false);
});

test('errors carrying no response body are not treated as past-end', () => {
    assert.equal(isPastEndOfResults(new Error('connect ECONNREFUSED 127.0.0.1:9200')), false);
    assert.equal(isPastEndOfResults(undefined), false);
});
