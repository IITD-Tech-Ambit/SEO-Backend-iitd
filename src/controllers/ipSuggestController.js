export async function ipSuggest(request, reply, ipSuggestService) {
    const { q, limit } = request.query;

    try {
        const result = await ipSuggestService.suggest(q, limit);

        return {
            intent: result.intent,
            confidence: result.confidence,
            groups: result.groups,
            meta: {
                took_ms: result.tookMs,
                cache_hit: result.cacheHit
            }
        };
    } catch (error) {
        request.log.error({ error, q }, 'IP suggest failed');
        // Degrade to empty groups so typeahead never breaks the search box.
        return reply.status(200).send({
            intent: 'mixed',
            confidence: 0,
            groups: { inventors: [], documents: [] },
            meta: { took_ms: 0, cache_hit: false }
        });
    }
}
