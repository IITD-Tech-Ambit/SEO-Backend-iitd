/**
 * Non-scoring OpenSearch request pieces for the IP index: filters, weighted field lists,
 * facet aggregations, and search_in normalization. Stateless aside from injected search config.
 */
const ALLOWED_SEARCH_IN = new Set(['title', 'abstract', 'inventor', 'field_of_invention', 'classification']);

export default class FilterBuilder {
    constructor(searchConfig) {
        this.searchConfig = searchConfig;
    }

    /** Dedupe + sort search_in so cache keys are order-independent. */
    normalizeSearchIn(searchIn) {
        if (!searchIn || !Array.isArray(searchIn) || searchIn.length === 0) return null;
        const unique = [...new Set(searchIn.filter((f) => ALLOWED_SEARCH_IN.has(f)))];
        unique.sort();
        return unique.length ? unique : null;
    }

    buildFilters(filters) {
        const mustFilters = [];

        if (filters?.year_from || filters?.year_to) {
            mustFilters.push({
                range: {
                    publication_year: {
                        ...(filters.year_from && { gte: filters.year_from }),
                        ...(filters.year_to && { lte: filters.year_to })
                    }
                }
            });
        }

        if (filters?.type_of_ip) {
            mustFilters.push({ term: { type_of_ip: filters.type_of_ip } });
        }

        if (filters?.type_of_ip_list?.length) {
            mustFilters.push({ terms: { type_of_ip: filters.type_of_ip_list } });
        }

        if (filters?.field_of_invention) {
            mustFilters.push({ term: { 'field_of_invention.keyword': filters.field_of_invention } });
        }

        if (filters?.classification?.length) {
            mustFilters.push({ terms: { classification: filters.classification } });
        }

        if (filters?.department) {
            mustFilters.push({ term: { department_id: filters.department } });
        }

        if (filters?.country) {
            mustFilters.push({ term: { country: filters.country } });
        }

        if (filters?.kerberos) {
            mustFilters.push({
                nested: {
                    path: 'inventors',
                    query: { term: { 'inventors.kerberos': filters.kerberos } }
                }
            });
        }

        // inventor_position 0 == primary inventor (P.I.).
        if (filters?.primary_inventor_only === true) {
            mustFilters.push({
                nested: {
                    path: 'inventors',
                    query: { term: { 'inventors.inventor_position': 0 } }
                }
            });
        }

        return mustFilters;
    }

    /**
     * Weighted field list a query may match.
     *
     * `literalMatch` (basic mode) uses un-stemmed `.standard` sub-fields only; morphology
     * is reintroduced as a low-weight SHOULD boost by the query builder.
     *
     * `inventor` maps to [] here — inventor search_in is routed via nested `inventors.name`
     * + flat `inventor_names` in QueryBuilder.
     */
    getSearchFields(searchIn = null, { literalMatch = false } = {}) {
        const b = this.searchConfig.fieldBoosts;

        if (literalMatch) {
            const literalDefaultFields = [
                `title.standard^${b.title * 1.25}`,
                `abstract.standard^${b.abstract}`,
                `field_of_invention^${b.fieldOfInvention}`
            ];
            if (!searchIn || searchIn.length === 0) return literalDefaultFields;
            const literalMapping = {
                title: [`title.standard^${b.title * 1.5}`],
                abstract: [`abstract.standard^${b.abstract * 1.5}`],
                inventor: [],
                field_of_invention: [`field_of_invention^${b.fieldOfInvention * 1.5}`],
                classification: [`classification^${b.classification}`]
            };
            return searchIn.flatMap(f => literalMapping[f] || []).filter(Boolean);
        }

        const defaultFields = [
            `title^${b.title}`,
            `title.exact^${b.titleExact}`,
            `title.standard^${b.title * 0.8}`,
            `title.autocomplete^${b.title * 0.5}`,
            `abstract^${b.abstract}`,
            `abstract.standard^${b.abstract * 0.8}`,
            `field_of_invention^${b.fieldOfInvention}`,
            `field_of_invention.ngram^${b.fieldOfInventionNgram}`
        ];

        if (!searchIn || searchIn.length === 0) return defaultFields;

        const fieldMapping = {
            title: [
                `title^${b.title}`,
                `title.exact^${b.titleExact}`,
                `title.standard^${b.title * 0.8}`,
                `title.autocomplete^${b.title * 0.5}`
            ],
            abstract: [
                `abstract^${b.abstract * 1.5}`,
                `abstract.standard^${b.abstract}`
            ],
            inventor: [],
            field_of_invention: [
                `field_of_invention^${b.fieldOfInvention * 1.5}`,
                `field_of_invention.ngram^${b.fieldOfInventionNgram}`
            ],
            classification: [
                `classification^${b.classification}`
            ]
        };

        return searchIn.flatMap(f => fieldMapping[f] || []).filter(Boolean);
    }

    /** Hybrid field list: drop noisy ngram/autocomplete sub-fields. */
    getHybridSearchFields(searchIn = null) {
        return this.getSearchFields(searchIn)
            .filter(f => !f.includes('.ngram') && !f.includes('.autocomplete'));
    }

    getAggregations() {
        return {
            years: { terms: { field: 'publication_year', size: 30, order: { _key: 'desc' } } },
            type_of_ip: { terms: { field: 'type_of_ip', size: 20 } },
            field_of_invention: { terms: { field: 'field_of_invention.keyword', size: 30 } },
            country: { terms: { field: 'country', size: 30 } },
            classification: { terms: { field: 'classification', size: 30 } }
        };
    }
}
