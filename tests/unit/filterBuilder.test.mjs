import { test } from 'node:test';
import assert from 'node:assert/strict';
import FilterBuilder from '../../src/services/search/FilterBuilder.js';
import { buildSearchConfig } from '../../src/services/search/constants.js';

const fb = new FilterBuilder(buildSearchConfig({}));

test('normalizeSearchIn dedupes, filters unknown, and sorts', () => {
    assert.deepEqual(fb.normalizeSearchIn(['title', 'title', 'author']), ['author', 'title']);
    assert.deepEqual(fb.normalizeSearchIn(['bogus', 'abstract']), ['abstract']);
    assert.equal(fb.normalizeSearchIn([]), null);
    assert.equal(fb.normalizeSearchIn(null), null);
});

test('buildFilters emits a publication_year range', () => {
    const clauses = fb.buildFilters({ year_from: 2010, year_to: 2020 });
    const range = clauses.find(c => c.range?.publication_year);
    assert.ok(range);
    assert.equal(range.range.publication_year.gte, 2010);
    assert.equal(range.range.publication_year.lte, 2020);
});

test('buildFilters author_id with kerberos yields a union clause', () => {
    const clauses = fb.buildFilters({ author_id: '123', _authorKerberos: 'jdoe' });
    const union = clauses.find(c => c.bool?.should);
    assert.ok(union);
    assert.equal(union.bool.minimum_should_match, 1);
    assert.equal(union.bool.should.length, 2);
});

test('getSearchFields literal mode uses only un-stemmed .standard for title/abstract', () => {
    const fields = fb.getSearchFields(null, { literalMatch: true });
    assert.ok(fields.some(f => f.startsWith('title.standard')));
    assert.ok(!fields.some(f => /^title\^/.test(f)));
    assert.ok(!fields.some(f => f.includes('.ngram')));
});

test('getHybridSearchFields drops ngram and autocomplete sub-fields', () => {
    const fields = fb.getHybridSearchFields(null);
    assert.ok(!fields.some(f => f.includes('.ngram')));
    assert.ok(!fields.some(f => f.includes('.autocomplete')));
});

test('author search_in maps to empty field list (routed via nested authors)', () => {
    assert.deepEqual(fb.getSearchFields(['author']), []);
});

test('field_associated selects exactly the facet bucket it was clicked from', () => {
    // The `fields` facet buckets on field_associated.keyword, so the filter has to match that
    // same keyword exactly. An analyzed/fuzzy match let "Computer Science" also pull in
    // Environmental Science, Social Sciences and Materials Science via the shared "Science" token.
    const clauses = fb.buildFilters({ field_associated: 'Computer Science' });
    const aggField = fb.getAggregations().fields.terms.field;
    const clause = clauses.find(c => c.term?.[aggField]);
    assert.ok(clause, `expected an exact term filter on ${aggField}`);
    assert.equal(clause.term[aggField], 'Computer Science');
    assert.ok(!JSON.stringify(clauses).includes('fuzziness'), 'field filter must not be fuzzy');
});

test('buildScopeFilters keeps identity scoping and drops facet filters', () => {
    const filters = {
        author_id: '123',
        kerberos: 'jdoe',
        document_type: 'Article',
        field_associated: 'Computer Science',
        year_from: 2010,
        subject_area: ['Physics'],
        interdisciplinary: true
    };
    const scope = fb.buildScopeFilters(filters);
    const scopeJson = JSON.stringify(scope);
    assert.ok(scopeJson.includes('authors.author_id'), 'author scoping belongs in the kNN pre-filter');
    assert.ok(scopeJson.includes('kerberos'), 'kerberos scoping belongs in the kNN pre-filter');
    for (const facetSignal of ['document_type', 'field_associated', 'publication_year', 'subject_area', 'subject_area_count']) {
        assert.ok(!scopeJson.includes(facetSignal), `${facetSignal} must not pre-filter the ANN search`);
    }
    // Scope filters are still enforced overall — they are a subset of the full filter list.
    assert.ok(JSON.stringify(fb.buildFilters(filters)).includes('authors.author_id'));
});

test('first_author_only is correlated with the author being filtered on', () => {
    // Sibling nested queries match independently, so an uncorrelated position clause let through
    // every paper where the author appears anywhere and somebody else led it.
    const clauses = fb.buildFilters({ author_id: '57206367009', first_author_only: true });
    const correlated = clauses.find(c =>
        c.nested?.path === 'authors' && c.nested.query?.bool?.must?.length === 2);
    assert.ok(correlated, 'expected one nested query asserting both id and position');
    const terms = correlated.nested.query.bool.must;
    assert.ok(terms.some(t => t.term?.['authors.author_id'] === '57206367009'));
    assert.ok(terms.some(t => t.term?.['authors.author_position'] === 1));

    // No bare position-only nested clause should remain alongside it.
    const bare = clauses.filter(c => c.nested?.query?.term?.['authors.author_position'] === 1);
    assert.equal(bare.length, 0, 'uncorrelated position clause must not be emitted too');
});

test('first_author_only without an author still asserts a first author exists', () => {
    const clauses = fb.buildFilters({ first_author_only: true });
    assert.ok(clauses.some(c => c.nested?.query?.term?.['authors.author_position'] === 1));
});

test('getAggregations exposes the expected facets', () => {
    const aggs = fb.getAggregations();
    for (const key of ['years', 'year_ranges', 'document_types', 'fields', 'subject_areas']) {
        assert.ok(aggs[key], `missing agg ${key}`);
    }
});

test('facultyForQueryAggregations covers flat, nested and kerberos sources', () => {
    const aggs = fb.facultyForQueryAggregations();
    assert.ok(aggs.from_author_ids);
    assert.ok(aggs.from_nested_authors);
    assert.ok(aggs.from_kerberos);
});
