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
