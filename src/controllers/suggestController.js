export async function suggest(request, reply, suggestService) {
    const { q, limit } = request.query;

    try {
        const result = await suggestService.suggest(q, limit);

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
        request.log.error({ error, q }, 'Suggest failed');
        // Typeahead must never break the search box — degrade to empty groups.
        return reply.status(200).send({
            intent: 'mixed',
            confidence: 0,
            groups: { authors: [], papers: [] },
            meta: { took_ms: 0, cache_hit: false }
        });
    }
}
