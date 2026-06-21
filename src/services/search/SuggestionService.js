/**
 * "Did you mean?" suggestions via OpenSearch term suggesters over title and author names.
 * Returns up to five candidate corrections; empty on any failure.
 */
export default class SuggestionService {
    constructor({ opensearch, indexName, logger }) {
        this.opensearch = opensearch;
        this.indexName = indexName;
        this.logger = logger;
    }

    async getSuggestions(query) {
        try {
            const termSuggester = (field) => ({
                text: query,
                term: {
                    field,
                    suggest_mode: 'popular',
                    sort: 'frequency',
                    size: 3,
                    max_edits: 2,
                    prefix_length: 1,
                    min_word_length: 3
                }
            });

            const suggestResponse = await this.opensearch.search({
                index: this.indexName,
                body: {
                    size: 0,
                    suggest: {
                        title_suggest: termSuggester('title'),
                        author_suggest: termSuggester('author_names')
                    }
                }
            });

            const suggestions = new Set();
            const suggestData = suggestResponse.body.suggest;

            for (const group of ['title_suggest', 'author_suggest']) {
                for (const entry of suggestData?.[group] || []) {
                    for (const option of entry.options) suggestions.add(option.text);
                }
            }

            if (suggestions.size > 0) {
                const words = query.trim().split(/\s+/);
                const correctedWords = words.map(word => {
                    const titleSuggest = suggestData?.title_suggest?.find(s => s.text === word);
                    if (titleSuggest?.options?.length > 0) return titleSuggest.options[0].text;
                    return word;
                });
                const correctedQuery = correctedWords.join(' ');
                if (correctedQuery !== query) {
                    return [correctedQuery, ...Array.from(suggestions).slice(0, 4)];
                }
            }

            return Array.from(suggestions).slice(0, 5);
        } catch (err) {
            this.logger.warn({ err }, 'Suggestion query failed');
            return [];
        }
    }
}
