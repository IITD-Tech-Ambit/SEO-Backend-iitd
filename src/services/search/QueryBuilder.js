import { getSpellingVariant } from './SpellingVariants.js';
import { buildHighlightQuery, buildHighlightBlock, HIGHLIGHT_FIELDS } from '../../utils/highlight.js';

// Bounds fuzzy per-term candidate fan-out: with several fields x several overlapping
// recall arms x many query terms, uncapped fuzzy matching (default max_expansions: 50)
// can exceed OpenSearch's maxClauseCount (1024) on long, common-word queries.
const FUZZY_MAX_EXPANSIONS = 10;
// Beyond this many terms, a query is a natural-language sentence, not "name + topic" —
// skip the identity-matching arms (which redo fuzzy matching per term again) rather than
// let them compound the clause count for no real recall benefit.
const MAX_TERMS_FOR_IDENTITY_ARMS = 6;

function withExpansionCap(fuzz) {
    return (fuzz && fuzz.fuzziness != null) ? { ...fuzz, max_expansions: FUZZY_MAX_EXPANSIONS } : fuzz;
}

/**
 * Coerce a refinement chain (array, single string, or null) into a clean ordered list of
 * trimmed, non-empty, de-duplicated terms.
 */
export function normalizeChain(refineChain) {
    const arr = Array.isArray(refineChain)
        ? refineChain
        : (refineChain != null && String(refineChain).trim() ? [refineChain] : []);
    const seen = new Set();
    const out = [];
    for (const raw of arr) {
        const term = (raw == null ? '' : String(raw)).trim();
        if (!term || seen.has(term.toLowerCase())) continue;
        seen.add(term.toLowerCase());
        out.push(term);
    }
    return out;
}

/**
 * Constructs every OpenSearch query body and clause used by search: basic BM25,
 * hybrid (BM25 + kNN), impact-weighted, and normalized-hybrid, plus the shared
 * author/field clause builders.
 *
 * Ranking intent shared across modes: an exact whole-phrase match outranks a
 * near-phrase match, which outranks scattered individual-word matches, which
 * outrank purely-semantic (kNN-only) matches.
 */
export default class QueryBuilder {
    constructor({ searchConfig, filterBuilder, rosterService }) {
        this.searchConfig = searchConfig;
        this.filters = filterBuilder;
        this.roster = rosterService;
    }

    /**
     * Highlight config for the current query + every still-filtering refine-chain term, against
     * title/abstract only (see src/utils/highlight.js). Grounds highlighting in what OpenSearch
     * actually matched (stemmed forms, fuzzy corrections) instead of a frontend literal-substring
     * guess. Returns undefined (no highlight requested) when there's no text query.
     */
    _buildHighlightBlock(query, refineChain = []) {
        const terms = [query, ...normalizeChain(refineChain)];
        const fields = [HIGHLIGHT_FIELDS.title, HIGHLIGHT_FIELDS.abstract];
        return buildHighlightBlock(buildHighlightQuery(terms, fields));
    }

    /**
     * Nested author match WITHOUT the IITD roster filter. Only valid for author-scoped
     * search where an anchor filter already restricts results to one IITD faculty's papers.
     */
    _buildNonGatedAuthorMatchClause(query, { fuzziness } = {}) {
        const terms = (query || '').trim().split(/\s+/).filter(Boolean);
        if (!terms.length) return null;
        const b = this.searchConfig.fieldBoosts;
        // A fixed numeric fuzziness (unlike 'AUTO') lets a short term fuzzy-match almost any
        // short fragment (e.g. an initial). Terms of length <=2 always match exactly, mirroring
        // the length band 'AUTO' itself already uses.
        const fuzzFor = (term) => withExpansionCap((fuzziness != null && term.length > 2) ? { fuzziness } : {});
        return {
            nested: {
                path: 'authors',
                score_mode: 'max',
                query: {
                    bool: {
                        must: terms.map((term) => ({
                            bool: {
                                should: [
                                    { match: { 'authors.author_name': { query: term, boost: b.authorName * 1.5, ...fuzzFor(term) } } },
                                    { match: { 'authors.author_name_variants': { query: term, boost: b.authorVariants, ...fuzzFor(term) } } }
                                ],
                                minimum_should_match: 1
                            }
                        }))
                    }
                }
            }
        };
    }

    /**
     * Nested author match constrained to the IITD Faculty roster (plus any
     * extraAuthorScopusIds, e.g. an anchor author). Co-authors off the roster cannot match.
     */
    buildIITDAuthorMatchClause(query, { fuzziness, boost, extraAuthorScopusIds = [], iitdScopusIds = null } = {}) {
        const terms = (query || '').trim().split(/\s+/).filter(Boolean);
        const roster = iitdScopusIds || this.roster.current();
        if (!terms.length || !roster || roster.length === 0) return null;
        const allowed = extraAuthorScopusIds?.length
            ? [...new Set([...roster, ...extraAuthorScopusIds.map(String)])]
            : roster;
        const b = this.searchConfig.fieldBoosts;
        const fuzzFor = (term) => withExpansionCap((fuzziness != null && term.length > 2) ? { fuzziness } : {});
        const termShould = (term) => ({
            bool: {
                should: [
                    { match: { 'authors.author_name': { query: term, boost: b.authorName * 1.5, ...fuzzFor(term) } } },
                    { match: { 'authors.author_name_variants': { query: term, boost: b.authorVariants, ...fuzzFor(term) } } }
                ],
                minimum_should_match: 1
            }
        });
        const nested = {
            nested: {
                path: 'authors',
                score_mode: 'max',
                query: {
                    bool: {
                        must: terms.map(termShould),
                        filter: [{ terms: { 'authors.author_id': allowed } }]
                    }
                }
            }
        };
        if (boost != null) nested.nested.boost = boost;
        return nested;
    }

    /**
     * Per-term OR across text fields ∪ nested author name, AND across terms — so a query mixing
     * a person's name with topic words (e.g. "Ilavarasan executing") can match even though
     * neither an all-terms-in-text clause nor an all-terms-in-author-name clause ever could.
     * No-op below 2 terms: single-term queries are already covered by the plain text/author arms.
     */
    _buildMixedAuthorTextClause(query, searchFields, fuzz, authorScoped) {
        const terms = query.trim().split(/\s+/).filter(Boolean);
        if (terms.length < 2) return null;
        const roster = authorScoped ? null : this.roster.current();
        if (!authorScoped && (!roster || roster.length === 0)) return null;
        const b = this.searchConfig.fieldBoosts;
        // A fixed numeric fuzziness (unlike 'AUTO') lets a short term fuzzy-match almost anything
        // short — terms of length <=2 always match exactly, mirroring 'AUTO's own length band.
        const fuzzFor = (term) => withExpansionCap((fuzz?.fuzziness != null && fuzz.fuzziness !== 'AUTO' && term.length <= 2) ? {} : fuzz);

        const authorNameShould = (term) => ({
            bool: {
                should: [
                    { match: { 'authors.author_name': { query: term, boost: b.authorName * 1.5, ...fuzzFor(term) } } },
                    { match: { 'authors.author_name_variants': { query: term, boost: b.authorVariants, ...fuzzFor(term) } } }
                ],
                minimum_should_match: 1
            }
        });

        const termClause = (term) => ({
            bool: {
                should: [
                    { multi_match: { query: term, fields: searchFields, type: 'best_fields', tie_breaker: 0.3, ...fuzzFor(term) } },
                    {
                        nested: {
                            path: 'authors',
                            score_mode: 'max',
                            query: authorScoped
                                ? { bool: { must: [authorNameShould(term)] } }
                                : { bool: { must: [authorNameShould(term)], filter: [{ terms: { 'authors.author_id': roster } }] } }
                        }
                    }
                ],
                minimum_should_match: 1
            }
        });

        return { bool: { must: terms.map(termClause) } };
    }

    /** OR of text-BM25, author-name, and mixed author+text arms — the default (no search_in) match. */
    _buildDefaultBm25Clause(query, searchFields, fuzz, authorScoped) {
        const textBm25 = this.buildStrictBm25Must(query, searchFields, fuzz);
        const termCount = query.trim().split(/\s+/).filter(Boolean).length;
        // Long queries are natural-language sentences, not "name + topic" — the identity arms
        // below redo fuzzy per-term matching across every field again, which is what pushes
        // long/common-word queries past OpenSearch's maxClauseCount. Skip them past this length.
        if (termCount > MAX_TERMS_FOR_IDENTITY_ARMS) return textBm25;
        const authorClause = authorScoped
            ? this._buildNonGatedAuthorMatchClause(query, fuzz)
            : this.buildIITDAuthorMatchClause(query, fuzz);
        const mixedClause = this._buildMixedAuthorTextClause(query, searchFields, fuzz, authorScoped);
        const arms = [textBm25, authorClause, mixedClause].filter(Boolean);
        return arms.length > 1 ? { bool: { should: arms, minimum_should_match: 1 } } : arms[0];
    }

    /**
     * Field-scoped clause when search_in is set.
     * - Author-only: Mongo-resolved Faculty Scopus ids + kerberos -> terms; else nested
     *   authors restricted to the IITD roster (unless authorScoped).
     * - Mixed fields: each token must match at least one selected field group.
     *
     * `literalMatch` (basic) matches only the un-stemmed `.standard` sub-fields.
     */
    buildConstrainedSearchInClause(query, searchIn, matchOpts = {}, facultyAuthorIds = null, facultyKerberosIds = null) {
        const terms = query.trim().split(/\s+/).filter((t) => t.length > 0);
        if (!terms.length) return { match_all: {} };
        // A fixed numeric fuzziness (unlike 'AUTO') lets a short term fuzzy-match almost anything
        // short — terms of length <=2 always match exactly, mirroring 'AUTO's own length band.
        const fuzzFor = (term) => withExpansionCap((matchOpts.fuzziness != null && term.length > 2) ? { fuzziness: matchOpts.fuzziness } : {});
        const b = this.searchConfig.fieldBoosts;
        const iitdScopusIds = this.roster.current();
        const authorScoped = !!matchOpts.authorScoped;
        const literalMatch = !!matchOpts.literalMatch;

        if (searchIn.length === 1 && searchIn[0] === 'author') {
            if ((facultyAuthorIds && facultyAuthorIds.length > 0) || (facultyKerberosIds && facultyKerberosIds.length > 0)) {
                const should = [];
                if (facultyAuthorIds?.length > 0) {
                    should.push(
                        { terms: { author_ids: facultyAuthorIds } },
                        { nested: { path: 'authors', query: { terms: { 'authors.author_id': facultyAuthorIds } } } }
                    );
                }
                if (facultyKerberosIds?.length > 0) {
                    should.push({ terms: { kerberos: facultyKerberosIds } });
                }
                return { bool: { should, minimum_should_match: 1 } };
            }
            // Faculty resolver found nothing — fall back to a fuzzy nested author-name match.
            // Outside author-scoped context, HARD-FILTER to the IITD roster so non-affiliated
            // co-authors cannot cause matches.
            const nestedBool = {
                must: terms.map((term) => ({
                    bool: {
                        should: [
                            { match: { 'authors.author_name': { query: term, boost: b.authorName * 1.5, ...fuzzFor(term) } } },
                            { match: { 'authors.author_name_variants': { query: term, boost: b.authorVariants, ...fuzzFor(term) } } }
                        ],
                        minimum_should_match: 1
                    }
                }))
            };
            if (!authorScoped) {
                if (!iitdScopusIds || iitdScopusIds.length === 0) return { match_none: {} };
                nestedBool.filter = [{ terms: { 'authors.author_id': iitdScopusIds } }];
            }
            return { nested: { path: 'authors', score_mode: 'max', query: { bool: nestedBool } } };
        }

        const titleTerm = (term) => {
            const fuzz = fuzzFor(term);
            if (literalMatch) {
                return { match: { 'title.standard': { query: term, boost: b.title * 1.5, ...fuzz } } };
            }
            return {
                bool: {
                    should: [
                        { match: { title: { query: term, boost: b.title, ...fuzz } } },
                        { match: { 'title.standard': { query: term, boost: b.title * 0.8, ...fuzz } } }
                    ],
                    minimum_should_match: 1
                }
            };
        };

        const abstractTerm = (term) => {
            const fuzz = fuzzFor(term);
            if (literalMatch) {
                return { match: { 'abstract.standard': { query: term, boost: b.abstract * 1.5, ...fuzz } } };
            }
            return {
                bool: {
                    should: [
                        { match: { abstract: { query: term, boost: b.abstract * 1.2, ...fuzz } } },
                        { match: { 'abstract.standard': { query: term, boost: b.abstract, ...fuzz } } }
                    ],
                    minimum_should_match: 1
                }
            };
        };

        const authorTerm = (term) => {
            const fuzz = fuzzFor(term);
            const nestedBool = {
                must: [{
                    bool: {
                        should: [
                            { match: { 'authors.author_name': { query: term, boost: b.authorName * 1.5, ...fuzz } } },
                            { match: { 'authors.author_name_variants': { query: term, boost: b.authorVariants, ...fuzz } } }
                        ],
                        minimum_should_match: 1
                    }
                }]
            };
            if (!authorScoped) {
                if (!iitdScopusIds || iitdScopusIds.length === 0) return { match_none: {} };
                nestedBool.filter = [{ terms: { 'authors.author_id': iitdScopusIds } }];
            }
            return { nested: { path: 'authors', score_mode: 'max', query: { bool: nestedBool } } };
        };

        const subjectTerm = (term) => ({
            match: { subject_area: { query: term, boost: b.subjectArea * 1.2, ...fuzzFor(term) } }
        });

        const fieldTerm = (term) => ({
            match: { field_associated: { query: term, boost: b.fieldAssociated * 1.2, ...fuzz } }
        });

        const oneTermAcrossSelectedFields = (term) => {
            const should = [];
            if (searchIn.includes('title')) should.push(titleTerm(term));
            if (searchIn.includes('abstract')) should.push(abstractTerm(term));
            if (searchIn.includes('author')) should.push(authorTerm(term));
            if (searchIn.includes('subject_area')) should.push(subjectTerm(term));
            if (searchIn.includes('field')) should.push(fieldTerm(term));
            return { bool: { should, minimum_should_match: should.length ? 1 : 0 } };
        };

        return { bool: { must: terms.map(oneTermAcrossSelectedFields) } };
    }

    /**
     * Author-only search-on-search: `anchorText` pins the person; `queryNarrow` (plus any
     * `extraNarrowTerms` from earlier refinement steps) matches title + abstract inside that
     * person's papers. Each narrow term is its own MUST so the person's corpus narrows step by step.
     */
    buildAuthorRefineNarrowMust(queryNarrow, anchorText, anchorFacultyIds, matchOpts = {}, anchorKerberosIds = null, extraNarrowTerms = []) {
        const narrowTerms = [...extraNarrowTerms, queryNarrow].filter(t => t && t.trim());
        return {
            bool: {
                must: [
                    this.buildConstrainedSearchInClause(anchorText, ['author'], matchOpts, anchorFacultyIds, anchorKerberosIds),
                    ...narrowTerms.map(t => this.buildConstrainedSearchInClause(t, ['title', 'abstract'], matchOpts))
                ]
            }
        };
    }

    /**
     * Strict lexical clauses (no fuzziness, no kNN) for each prior refinement term, intended for
     * OpenSearch FILTER context. In filter context a term can only remove candidates from the
     * intersection, never add, so the result set narrows monotonically as the chain grows.
     */
    buildRefineFilterClauses(refineChain = [], searchIn = null, { authorScoped = false } = {}) {
        if (!Array.isArray(refineChain) || refineChain.length === 0) return [];
        return refineChain
            .filter(term => term && term.trim())
            .map(term => this.buildLiteralPrimaryClause(term, searchIn, { authorScoped }));
    }

    /**
     * Tiered phrase-priority SHOULD boosts. SHOULD-only: they reorder results
     * (exact phrase > near phrase > scattered words) without changing recall.
     * `literal` uses the un-stemmed `.standard` sub-fields (basic mode).
     */
    _buildPhraseBoostTiers(query, { literal = false } = {}) {
        const words = query.trim().split(/\s+/).filter(Boolean);
        if (words.length < 2) return [];
        const titleField = literal ? 'title.standard' : 'title';
        const abstractField = literal ? 'abstract.standard' : 'abstract';
        const tiers = [
            { match_phrase: { [titleField]: { query, slop: 0, boost: 20 } } },
            { match_phrase: { [titleField]: { query, slop: 2, boost: 10 } } },
            { match_phrase: { [abstractField]: { query, slop: 0, boost: 6 } } },
            { match_phrase: { [abstractField]: { query, slop: 4, boost: 3 } } }
        ];
        // Advanced (stemmed) mode lacks basic mode's literal precision. Add a top-priority
        // un-stemmed exact-title tier so an exact title snippet outranks stemmed/partial matches.
        if (!literal) {
            tiers.unshift({ match_phrase: { 'title.standard': { query, slop: 0, boost: 25 } } });
        }
        return tiers;
    }

    /**
     * Per-term BM25 clause for advanced mode.
     * <=3 terms: all terms required (strict). 4+: should with ~75% minimum_should_match.
     */
    buildStrictBm25Must(query, searchFields, fuzz = { fuzziness: 'AUTO' }, { strict = false } = {}) {
        const terms = query.trim().split(/\s+/).filter(t => t.length > 0);

        if (terms.length <= 1) {
            const variant = getSpellingVariant(terms[0] || query);
            if (variant) {
                return {
                    bool: {
                        should: [
                            { multi_match: { query: query, fields: searchFields, type: 'best_fields', tie_breaker: 0.3, ...fuzz } },
                            { multi_match: { query: variant, fields: searchFields, type: 'best_fields', tie_breaker: 0.3, ...fuzz } }
                        ],
                        minimum_should_match: 1
                    }
                };
            }
            return {
                multi_match: { query: query, fields: searchFields, type: 'best_fields', tie_breaker: 0.3, ...fuzz }
            };
        }

        // Per-term admission relies on stopword-aware analysis: `title`/`abstract` (unsuffixed)
        // use OpenSearch's built-in `english` analyzer, which strips stopwords via its own
        // english_stop filter. `.standard`/`.exact` are literal/un-stemmed fields for phrase-level
        // precision elsewhere (see _buildPhraseBoostTiers) — including them here lets a single
        // common word like "at" satisfy a whole term slot in the N-of-M admission count.
        const perTermFields = searchFields.filter(f => !/\.(standard|exact)(\^|$)/.test(f));
        const matchFields = perTermFields.length ? perTermFields : searchFields;
        // A fixed numeric fuzziness (unlike 'AUTO') lets a short term fuzzy-match almost anything
        // short — terms of length <=2 always match exactly, mirroring 'AUTO's own length band.
        const fuzzFor = (term) => withExpansionCap((fuzz?.fuzziness != null && fuzz.fuzziness !== 'AUTO' && term.length <= 2) ? {} : fuzz);

        const clauses = terms.map(term => {
            const termFuzz = fuzzFor(term);
            const variant = getSpellingVariant(term);
            if (variant) {
                return {
                    bool: {
                        should: [
                            { multi_match: { query: term, fields: matchFields, type: 'best_fields', tie_breaker: 0.3, ...termFuzz } },
                            { multi_match: { query: variant, fields: matchFields, type: 'best_fields', tie_breaker: 0.3, ...termFuzz } }
                        ],
                        minimum_should_match: 1
                    }
                };
            }
            return {
                multi_match: { query: term, fields: matchFields, type: 'best_fields', tie_breaker: 0.3, ...termFuzz }
            };
        });

        if (terms.length <= 3 || strict) {
            return { bool: { must: clauses } };
        }

        const minRequired = Math.max(3, Math.ceil(terms.length * 0.75));
        return { bool: { should: clauses, minimum_should_match: minRequired } };
    }

    /**
     * The strict, un-fuzzy, all-terms literal clause that basic mode uses to RECALL a document
     * for the primary query. This is exactly the set of documents basic mode returns, so it is
     * reused as the advanced lexical-floor filter to guarantee basic results are a subset of
     * advanced — without flooring the looser fuzzy/partial matches that advanced additionally
     * recalls (which would let near-gibberish fuzzy matches clear the relevance bar).
     */
    buildLiteralPrimaryClause(query, searchIn = null, { authorScoped = false, facultyAuthorIds = null, facultyKerberosIds = null, authorRefineNarrow = false, refineWithinAnchor = null, refineNarrowExtra = [] } = {}) {
        const literalFields = this.filters.getSearchFields(searchIn, { literalMatch: true });
        const authorOnly = searchIn?.length === 1 && searchIn[0] === 'author';
        const csiOpts = { authorScoped, literalMatch: true };

        if (searchIn && searchIn.length > 0) {
            if (authorRefineNarrow && authorOnly && refineWithinAnchor?.trim()) {
                return this.buildAuthorRefineNarrowMust(query, refineWithinAnchor, facultyAuthorIds, csiOpts, facultyKerberosIds, refineNarrowExtra);
            }
            return this.buildConstrainedSearchInClause(query, searchIn, csiOpts, facultyAuthorIds, facultyKerberosIds);
        }

        const base = this._buildCrossFieldsWithVariants(query, literalFields);
        const authorClause = authorScoped
            ? this._buildNonGatedAuthorMatchClause(query)
            : this.buildIITDAuthorMatchClause(query);
        const mixedClause = this._buildMixedAuthorTextClause(query, literalFields, {}, authorScoped);
        const arms = [base, authorClause, mixedClause].filter(Boolean);
        return arms.length > 1 ? { bool: { should: arms, minimum_should_match: 1 } } : arms[0];
    }

    /**
     * cross_fields query (basic mode) honoring British/American spelling variants.
     */
    _buildCrossFieldsWithVariants(query, searchFields) {
        const words = query.trim().split(/\s+/);
        const hasVariant = words.some(w => getSpellingVariant(w) !== null);
        if (!hasVariant) {
            return { multi_match: { query, fields: searchFields, type: 'cross_fields', operator: 'and' } };
        }
        const variantWords = words.map(w => getSpellingVariant(w) || w);
        const variantQuery = variantWords.join(' ');
        return {
            bool: {
                should: [
                    { multi_match: { query, fields: searchFields, type: 'cross_fields', operator: 'and' } },
                    { multi_match: { query: variantQuery, fields: searchFields, type: 'cross_fields', operator: 'and' } }
                ],
                minimum_should_match: 1
            }
        };
    }

    /**
     * Basic mode: strict BM25 only (no embeddings, no fuzziness on the primary match).
     * cross_fields + operator:and for precise multi-word matching. Supports refine_within.
     */
    buildBasicQuery(query, filters, page, perPage, sort, searchIn = null, refineChain = [], facultyAuthorIds = null, authorRefineNarrow = false, facultyKerberosIds = null, { authorScoped = false } = {}) {
        const from = (page - 1) * perPage;
        const filterClauses = this.filters.buildFilters(filters);
        const chain = normalizeChain(refineChain);

        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;
        const searchAllFields = !searchIn || searchIn.length === 0;
        const authorOnly = searchIn?.length === 1 && searchIn[0] === 'author';
        const isAuthorNarrow = authorRefineNarrow && authorOnly;

        const primaryOpts = {
            authorScoped, facultyAuthorIds, facultyKerberosIds, authorRefineNarrow,
            refineWithinAnchor: isAuthorNarrow ? chain[0] : null,
            refineNarrowExtra: isAuthorNarrow ? chain.slice(1) : []
        };
        const mustClauses = [this.buildLiteralPrimaryClause(query, searchIn, primaryOpts)];

        // Standard (non-author-narrow) prior terms become strict lexical FILTERS so the
        // result set narrows monotonically without affecting scoring of the newest query.
        if (!isAuthorNarrow) {
            filterClauses.push(...this.buildRefineFilterClauses(chain, searchIn, { authorScoped }));
        }

        const boostClauses = [];

        const phraseOnTitleAbstract = searchAllFields || searchIn.includes('title') || searchIn.includes('abstract')
            || authorRefineNarrow;
        if (isMultiWord && phraseOnTitleAbstract) {
            boostClauses.push(...this._buildPhraseBoostTiers(query, { literal: true }));
        }

        // Soft morphology boost: a low-weight nudge on the stemmed root fields so e.g.
        // "communication" ranking benefits from "communications" papers, while a
        // stemmed-only match (like "community") can never beat a literal match.
        if (phraseOnTitleAbstract) {
            boostClauses.push({
                multi_match: {
                    query: query,
                    fields: ['title^1', 'abstract^0.5'],
                    type: 'best_fields',
                    tie_breaker: 0.3,
                    boost: 0.3
                }
            });
        }

        if (searchAllFields || searchIn.includes('subject_area')) {
            boostClauses.push({ match: { subject_area: { query: query, boost: 2.0 } } });
        }

        if (searchAllFields || searchIn.includes('field')) {
            boostClauses.push({ match: { field_associated: { query: query, boost: 1.5 } } });
        }

        let sortClause = ['_score'];
        if (sort === 'date') {
            sortClause = [{ publication_year: 'desc' }, '_score'];
        } else if (sort === 'citations') {
            sortClause = [{ citation_count: 'desc' }, '_score'];
        }

        return {
            size: perPage,
            from,
            track_total_hits: true,
            _source: ['mongo_id', 'title', 'abstract'],
            query: {
                bool: { must: mustClauses, should: boostClauses, filter: filterClauses }
            },
            sort: sortClause,
            aggs: this.filters.getAggregations(),
            highlight: this._buildHighlightBlock(query, chain)
        };
    }

    /**
     * Advanced hybrid (BM25 + kNN) for date/citations sort, where primary ordering is by
     * field rather than score. Either BM25 or kNN can recall a candidate.
     */
    buildHybridQuery(query, embedding, filters, page, perPage, sort, searchIn = null, facultyAuthorIds = null, authorRefineNarrow = false, refineWithinAnchor = null, facultyKerberosIds = null, { authorScoped = false, refineChain = [] } = {}) {
        const from = (page - 1) * perPage;
        const filterClauses = this.filters.buildFilters(filters);
        const searchFields = this.filters.getHybridSearchFields(searchIn);
        const refineNarrowExtra = normalizeChain(refineChain).slice(1);

        const searchAllFields = !searchIn || searchIn.length === 0;
        const authorOnly = searchIn?.length === 1 && searchIn[0] === 'author';

        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;

        const boostClauses = [];

        if (isMultiWord && (searchAllFields || searchIn.includes('title') || searchIn.includes('abstract') || (authorRefineNarrow && authorOnly))) {
            boostClauses.push(...this._buildPhraseBoostTiers(query));
        }

        if (searchAllFields || searchIn.includes('subject_area')) {
            boostClauses.push({ match: { subject_area: { query: query, boost: 2.0 } } });
        }

        if (searchAllFields || searchIn.includes('field')) {
            boostClauses.push({ match: { field_associated: { query: query, boost: 1.5 } } });
        }

        const csiOpts = { fuzziness: 'AUTO', authorScoped };
        let bm25Clause;
        if (authorRefineNarrow && authorOnly && refineWithinAnchor?.trim()) {
            bm25Clause = this.buildAuthorRefineNarrowMust(query, refineWithinAnchor, facultyAuthorIds, csiOpts, facultyKerberosIds, refineNarrowExtra);
        } else if (searchIn && searchIn.length > 0) {
            bm25Clause = this.buildConstrainedSearchInClause(query, searchIn, csiOpts, facultyAuthorIds, facultyKerberosIds);
        } else {
            bm25Clause = this._buildDefaultBm25Clause(query, searchFields, { fuzziness: 'AUTO' }, authorScoped);
        }

        const knnRecall = { knn: { embedding: { vector: embedding, k: 100 } } };
        // Pure-kNN recall is excluded when scoped to one author (authorScoped): within a small
        // single-person candidate pool, embedding similarity across the corpus is often nearly
        // flat, so min_score stops discriminating and admits unrelated papers. kNN still ranks
        // via the score functions elsewhere; it just can't admit a doc on its own here.
        const recallArms = authorScoped ? [bm25Clause] : [bm25Clause, knnRecall];
        const recallGate = { bool: { should: recallArms, minimum_should_match: 1 } };

        let sortClause = ['_score'];
        if (sort === 'date') {
            sortClause = [{ publication_year: 'desc' }, '_score'];
        } else if (sort === 'citations') {
            sortClause = [{ citation_count: 'desc' }, '_score'];
        }

        return {
            size: perPage,
            from,
            track_total_hits: true,
            _source: ['mongo_id', 'title', 'abstract'],
            query: {
                bool: { must: [recallGate], should: boostClauses, filter: filterClauses }
            },
            sort: sortClause,
            aggs: this.filters.getAggregations(),
            highlight: this._buildHighlightBlock(query, refineChain)
        };
    }

    /**
     * Impact-weighted hybrid: combines relevance with log-scale citation count and recency.
     */
    buildImpactQuery(query, embedding, filters, page, perPage, searchIn = null, facultyAuthorIds = null, authorRefineNarrow = false, refineWithinAnchor = null, facultyKerberosIds = null, { authorScoped = false, refineChain = [] } = {}) {
        const from = (page - 1) * perPage;
        const filterClauses = this.filters.buildFilters(filters);
        const searchFields = this.filters.getHybridSearchFields(searchIn);
        const refineNarrowExtra = normalizeChain(refineChain).slice(1);
        const currentYear = new Date().getFullYear();
        const searchAllFields = !searchIn || searchIn.length === 0;
        const authorOnly = searchIn?.length === 1 && searchIn[0] === 'author';

        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;

        const boostClauses = [];
        if (searchAllFields || searchIn.includes('subject_area')) {
            boostClauses.push({ match: { subject_area: { query: query, boost: 2.0 } } });
        }

        if (isMultiWord && (searchAllFields || searchIn.includes('title') || searchIn.includes('abstract') || (authorRefineNarrow && authorOnly))) {
            boostClauses.push(...this._buildPhraseBoostTiers(query));
        }

        const csiOpts = { fuzziness: 'AUTO', authorScoped };
        let bm25Clause;
        if (authorRefineNarrow && authorOnly && refineWithinAnchor?.trim()) {
            bm25Clause = this.buildAuthorRefineNarrowMust(query, refineWithinAnchor, facultyAuthorIds, csiOpts, facultyKerberosIds, refineNarrowExtra);
        } else if (searchIn && searchIn.length > 0) {
            bm25Clause = this.buildConstrainedSearchInClause(query, searchIn, csiOpts, facultyAuthorIds, facultyKerberosIds);
        } else {
            bm25Clause = this._buildDefaultBm25Clause(query, searchFields, { fuzziness: 'AUTO' }, authorScoped);
        }

        const knnRecall = { knn: { embedding: { vector: embedding, k: 100 } } };
        const recallArms = authorScoped ? [bm25Clause] : [bm25Clause, knnRecall];
        const recallGate = { bool: { should: recallArms, minimum_should_match: 1 } };

        return {
            size: perPage,
            from,
            track_total_hits: true,
            min_score: this.searchConfig.minScore.impact,
            _source: ['mongo_id', 'title', 'abstract'],
            highlight: this._buildHighlightBlock(query, refineChain),
            query: {
                function_score: {
                    query: {
                        bool: { must: [recallGate], should: boostClauses, filter: filterClauses }
                    },
                    functions: [
                        {
                            field_value_factor: {
                                field: 'citation_count',
                                factor: this.searchConfig.citationFactor,
                                modifier: 'log1p',
                                missing: 0
                            },
                            weight: 1.2
                        },
                        {
                            gauss: {
                                publication_year: {
                                    origin: currentYear,
                                    scale: this.searchConfig.recencyScale,
                                    decay: 0.5
                                }
                            },
                            weight: 0.8
                        }
                    ],
                    score_mode: 'sum',
                    boost_mode: 'multiply'
                }
            },
            aggs: this.filters.getAggregations()
        };
    }

    /**
     * Full title-term coverage SHOULD clause. Docs whose title contains ALL query terms
     * (un-stemmed) rank above partial-coverage docs — a lightweight grade signal for broad
     * topic clusters where flat relevance alone ranks poorly.
     */
    _buildTitleCoverageClause(query, boost = 5) {
        const words = query.trim().split(/\s+/).filter(Boolean);
        if (words.length < 2) return null;
        return { match: { 'title.standard': { query, operator: 'and', boost } } };
    }

    /**
     * Normalized hybrid (relevance sort): OpenSearch-native `hybrid` query, one arm per
     * recall signal (BM25, kNN), combined by Reciprocal Rank Fusion (`search_pipeline` query
     * param — see SearchService). RRF fuses by RANK, not raw score, so there's no BM25-vs-
     * cosine scale mismatch to hand-tune and no min_score cliff: a real but weak match ranks
     * low instead of vanishing when its raw score can't clear an arbitrary threshold. Each arm
     * carries its own filter so filtering happens pre-fusion (OpenSearch 2.19's `hybrid` query
     * has no top-level `filter` field yet).
     *
     * No separate "refine-chain anchor preference" arm: RRF fuses by UNION, so an arm whose
     * query is unconditionally true within the anchor filter (as a pure re-rank booster would
     * need to be) becomes an unconditional ADMISSION arm instead — it would re-admit the
     * anchor's entire filtered candidate set regardless of the current query term, silently
     * defeating refine-chain narrowing. The id-membership filter already applied to the real
     * bm25/kNN arms is what actually narrows; ranking loses the old score-carry-forward nicety,
     * but correctness matters far more than that ordering refinement.
     */
    buildNormalizedHybridQuery(query, embedding, filters, page, perPage, searchIn = null, facultyAuthorIds = null, authorRefineNarrow = false, refineWithinAnchor = null, facultyKerberosIds = null, { authorScoped = false, refineChain = [], refineFilterClauses = null, bm25AdmitsNothing = false, restrictKnn = false } = {}) {
        const from = (page - 1) * perPage;
        const filterClauses = this.filters.buildFilters(filters);
        const searchFields = this.filters.getHybridSearchFields(searchIn);
        const chain = normalizeChain(refineChain);
        const refineNarrowExtra = chain.slice(1);
        const searchAllFields = !searchIn || searchIn.length === 0;
        const authorOnly = searchIn?.length === 1 && searchIn[0] === 'author';

        const words = query.trim().split(/\s+/);
        const isMultiWord = words.length >= 2;

        const fuzzSetting = { fuzziness: 'AUTO' };
        const csiOpts = { ...fuzzSetting, authorScoped };
        let bm25Clause;
        if (authorRefineNarrow && authorOnly && refineWithinAnchor?.trim()) {
            bm25Clause = this.buildAuthorRefineNarrowMust(query, refineWithinAnchor, facultyAuthorIds, csiOpts, facultyKerberosIds, refineNarrowExtra);
        } else if (searchIn && searchIn.length > 0) {
            bm25Clause = this.buildConstrainedSearchInClause(query, searchIn, csiOpts, facultyAuthorIds, facultyKerberosIds);
        } else {
            bm25Clause = this._buildDefaultBm25Clause(query, searchFields, fuzzSetting, authorScoped);
        }

        const boostClauses = [];
        if (searchAllFields || searchIn.includes('subject_area')) {
            boostClauses.push({ match: { subject_area: { query: query, boost: 2.0 } } });
        }

        if (isMultiWord && (searchAllFields || searchIn.includes('title') || searchIn.includes('abstract') || (authorRefineNarrow && authorOnly))) {
            boostClauses.push(...this._buildPhraseBoostTiers(query));
        }

        if (isMultiWord && (searchAllFields || searchIn.includes('title'))) {
            const coverageClause = this._buildTitleCoverageClause(query);
            if (coverageClause) boostClauses.push(coverageClause);
        }

        if (!authorRefineNarrow) {
            filterClauses.push(...(refineFilterClauses || this.buildRefineFilterClauses(chain, searchIn, { authorScoped })));
        }

        const bm25Arm = { bool: { must: [bm25Clause], should: boostClauses, filter: filterClauses } };
        const knnArm = { bool: { must: [{ knn: { embedding: { vector: embedding, k: 100 } } }], filter: filterClauses } };
        // Pure-kNN recall is excluded when scoped to one author by default: within a small
        // single-person candidate pool, embedding similarity is often nearly flat, so its "top"
        // neighbor can be little more than the least-bad of an unrelated bunch. But BM25's N-of-M
        // admission bar can be mathematically unreachable for a paraphrased query with several
        // stopwords (each stopword can never satisfy a term slot, yet still counts toward the
        // required total) — with kNN excluded there's no fallback, so a genuinely matching paper
        // becomes permanently unfindable within that author's scope. bm25AdmitsNothing (the
        // caller's own BM25-only precheck) allows kNN back in only as a last resort, not a
        // co-equal arm, keeping the noise-reduction intent while removing the hard cliff.
        //
        // `restrictKnn` applies this same BM25-preferred admission rule to the People sidebar's
        // full-corpus aggregation query (FacultyForQueryService), which has no per-author filter
        // to key off `authorScoped`. Without it, the aggregation's kNN arm can admit a paper into
        // a faculty member's bucket purely on semantic similarity even though that faculty
        // member's OWN scoped search (AuthorScopedSearch, BM25-only by default) would never
        // surface it — the sidebar count then overcounts relative to the drill-down.
        const excludeKnn = (authorScoped || restrictKnn) && !bm25AdmitsNothing;
        const arms = excludeKnn ? [bm25Arm] : [bm25Arm, knnArm];

        return {
            size: perPage,
            from,
            track_total_hits: true,
            query: { hybrid: { queries: arms } },
            _source: ['mongo_id', 'title', 'abstract'],
            aggs: this.filters.getAggregations(),
            highlight: this._buildHighlightBlock(query, refineChain)
        };
    }
}
