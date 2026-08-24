/** True when OpenSearch failed a hybrid query because `from` is past the fused result set. */
const PAST_END_OF_RESULTS = 'Reached end of search result';

export function isPastEndOfResults(err) {
    const body = err?.meta?.body;
    return !!body && JSON.stringify(body).includes(PAST_END_OF_RESULTS);
}
