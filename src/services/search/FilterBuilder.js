/**
 * Builds the non-scoring parts of an OpenSearch request: filter clauses, the
 * weighted field lists a query may match, facet aggregations, and request
 * normalization helpers. Stateless apart from the injected search tuning config.
 */
const ALLOWED_SEARCH_IN = new Set(['title', 'abstract', 'author', 'subject_area', 'field']);

export default class FilterBuilder {
    constructor(searchConfig) {
        this.searchConfig = searchConfig;
    }

    /**
     * Dedupe + sort search_in so cache keys match regardless of field order from the client.
     */
    normalizeSearchIn(searchIn) {
        if (!searchIn || !Array.isArray(searchIn) || searchIn.length === 0) return null;
        const unique = [...new Set(searchIn.filter((f) => ALLOWED_SEARCH_IN.has(f)))];
        unique.sort();
        return unique.length ? unique : null;
    }

    escapeRegexForMongo(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

        // Exact term on the same keyword sub-field the `fields` facet buckets on, so clicking a
        // bucket selects exactly that bucket. An analyzed (let alone fuzzy) match here matched any
        // shared token instead: "Computer Science" also returned Environmental/Social/Materials
        // Science, and the typo "Computer Sciencx" returned the identical set.
        if (filters?.field_associated) {
            mustFilters.push({ term: { 'field_associated.keyword': filters.field_associated } });
        }

        if (filters?.document_type) {
            mustFilters.push({ term: { document_type: filters.document_type } });
        }

        if (filters?.document_types?.length) {
            mustFilters.push({ terms: { document_type: filters.document_types } });
        }

        if (filters?.subject_area?.length) {
            mustFilters.push({ terms: { 'subject_area.keyword': filters.subject_area } });
        }

        mustFilters.push(...this.buildScopeFilters(filters));

        if (filters?.first_author_only === true) {
            mustFilters.push(this._firstAuthorClause(filters));
        }

        if (filters?.interdisciplinary === true) {
            mustFilters.push({ range: { subject_area_count: { gte: 3 } } });
        }

        return mustFilters;
    }

    /**
     * "First author" has to be asked of ONE author, inside a single nested query.
     *
     * Two sibling `nested` queries on the same path are evaluated independently, so pairing an
     * author filter with a bare position clause asks "does some author have this id, and does
     * some author sit at position 1" — satisfied whenever the person appears anywhere and
     * somebody else leads. Measured on one author: 93 papers returned where they led only 11.
     *
     * Without an author to correlate against there is nothing to pin the position to, so the
     * clause can only assert that a first author exists (true of nearly every document).
     */
    _firstAuthorClause(filters) {
        const isFirst = { term: { 'authors.author_position': 1 } };
        if (!filters?.author_id) {
            return { nested: { path: 'authors', query: isFirst } };
        }
        return {
            nested: {
                path: 'authors',
                query: { bool: { must: [{ term: { 'authors.author_id': filters.author_id } }, isFirst] } }
            }
        };
    }

    /**
     * The identity-scoping subset of `buildFilters`: which person's corpus is being searched,
     * as opposed to the facet filters a user toggles on top of a result set.
     *
     * Only these belong inside a kNN clause's own `filter`. Pre-filtering the ANN search is what
     * lets a scoped candidate earn kNN recall even when its matches don't rank in the global
     * top-k — but it also makes the recall pool depend on the filter, so pre-filtering a *facet*
     * made "top k nearest Book Chapters" a different, larger set than the Book Chapters inside
     * the unfiltered top k. That is why a facet advertising 56 papers returned 307 when clicked.
     * Facet filters are applied as ordinary post-filters instead, which can only narrow, so
     * every facet count equals the total you get after selecting it.
     */
    buildScopeFilters(filters) {
        const scopeFilters = [];

        // Union of nested authors.author_id and top-level kerberos when _authorKerberos has
        // been pre-resolved from Faculty.email.
        if (filters?.author_id) {
            const authorNestedClause = {
                nested: {
                    path: 'authors',
                    query: { term: { 'authors.author_id': filters.author_id } }
                }
            };
            if (filters._authorKerberos) {
                scopeFilters.push({
                    bool: {
                        should: [authorNestedClause, { term: { kerberos: filters._authorKerberos } }],
                        minimum_should_match: 1
                    }
                });
            } else {
                scopeFilters.push(authorNestedClause);
            }
        }

        if (filters?.kerberos) {
            scopeFilters.push({ term: { kerberos: filters.kerberos } });
        }

        return scopeFilters;
    }

    /**
     * Weighted field list a query may match.
     *
     * Flat `author_names` / `author_name_variants` are intentionally excluded: they
     * contain every co-author on a paper (including non-IITD authors), so matching on
     * them would leak non-affiliated authors. All author-name matching is routed through
     * the nested `authors` path restricted to the IITD Faculty roster by the query builders.
     *
     * `literalMatch` (basic mode) matches only the un-stemmed `.standard` sub-fields so
     * Porter-stem collisions (communication <-> community) cannot promote unrelated papers;
     * morphological recall is reintroduced as a low-weight SHOULD boost by the query builder.
     */
    getSearchFields(searchIn = null, { literalMatch = false } = {}) {
        const b = this.searchConfig.fieldBoosts;

        if (literalMatch) {
            const literalDefaultFields = [
                `title.standard^${b.title * 1.25}`,
                `abstract.standard^${b.abstract}`,
                `subject_area^${b.subjectArea}`,
                `field_associated^${b.fieldAssociated}`
            ];
            if (!searchIn || searchIn.length === 0) return literalDefaultFields;
            const literalMapping = {
                title: [`title.standard^${b.title * 1.5}`],
                abstract: [`abstract.standard^${b.abstract * 1.5}`],
                author: [],
                subject_area: [`subject_area^${b.subjectArea * 1.5}`],
                field: [`field_associated^${b.fieldAssociated * 1.5}`]
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
            `subject_area^${b.subjectArea}`,
            `subject_area.ngram^${b.subjectAreaNgram}`,
            `field_associated^${b.fieldAssociated}`,
            `field_associated.ngram^${b.fieldAssociatedNgram}`
        ];

        if (!searchIn || searchIn.length === 0) return defaultFields;

        // `author` maps to an empty list: author-only search_in is routed through the
        // nested authors path with an IITD Faculty scopus_id filter by the query builder.
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
            author: [],
            subject_area: [
                `subject_area^${b.subjectArea * 1.5}`,
                `subject_area.ngram^${b.subjectAreaNgram}`
            ],
            field: [
                `field_associated^${b.fieldAssociated * 1.5}`,
                `field_associated.ngram^${b.fieldAssociatedNgram}`
            ]
        };

        return searchIn.flatMap(f => fieldMapping[f] || []).filter(Boolean);
    }

    /**
     * Advanced/hybrid field list: drop the noisy character n-gram and autocomplete
     * sub-fields that generate too many spurious fuzzy matches.
     */
    getHybridSearchFields(searchIn = null) {
        return this.getSearchFields(searchIn)
            .filter(f => !f.includes('.ngram') && !f.includes('.autocomplete'));
    }

    getAggregations() {
        return {
            years: { terms: { field: 'publication_year', size: 30, order: { _key: 'desc' } } },
            year_ranges: {
                range: {
                    field: 'publication_year',
                    ranges: [
                        { key: '2020-Present', from: 2020 },
                        { key: '2010-2019', from: 2010, to: 2020 },
                        { key: '2000-2009', from: 2000, to: 2010 },
                        { key: 'Pre-2000', to: 2000 }
                    ]
                }
            },
            document_types: { terms: { field: 'document_type', size: 15 } },
            fields: { terms: { field: 'field_associated.keyword', size: 30 } },
            subject_areas: { terms: { field: 'subject_area.keyword', size: 50 } }
        };
    }

    /**
     * Scopus-author buckets (flat + nested + kerberos) with per-bucket score stats,
     * used by the People sidebar (GET /search/faculty-for-query).
     */
    facultyForQueryAggregations() {
        const scoreStats = {
            max_relevance: { max: { script: '_score' } },
            avg_relevance: { avg: { script: '_score' } },
            total_citations: { sum: { field: 'citation_count' } }
        };
        // Default shard_size (~310) can undercount a prolific author on a broad query across
        // research_documents' 3 shards; raised well above realistic per-shard author cardinality.
        const shardSize = 2000;
        return {
            from_author_ids: {
                filter: { exists: { field: 'author_ids' } },
                aggs: {
                    by_scopus_author: {
                        terms: { field: 'author_ids', size: 200, shard_size: shardSize, min_doc_count: 1 },
                        aggs: scoreStats
                    }
                }
            },
            // A nested terms bucket's own doc_count counts matching nested AUTHOR sub-documents,
            // not parent papers — a paper with the same author_id listed twice (a real data
            // artifact seen on the IP side; not implausible here) would count as 2 papers for
            // them instead of 1. reverse_nested joins back to the parent doc level so paper_count
            // stays a distinct-paper count, matching what AuthorScopedSearch shows on click.
            from_nested_authors: {
                nested: { path: 'authors' },
                aggs: {
                    by_scopus_author: {
                        terms: { field: 'authors.author_id', size: 200, shard_size: shardSize, min_doc_count: 1 },
                        aggs: { ...scoreStats, paper_count: { reverse_nested: {} } }
                    }
                }
            },
            from_kerberos: {
                terms: { field: 'kerberos', size: 200, shard_size: shardSize, min_doc_count: 1 },
                aggs: scoreStats
            }
        };
    }
}
