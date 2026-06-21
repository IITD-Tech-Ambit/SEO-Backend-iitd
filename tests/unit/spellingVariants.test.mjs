import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSpellingVariant } from '../../src/services/search/SpellingVariants.js';

test('maps American -> British', () => {
    assert.equal(getSpellingVariant('color'), 'colour');
    assert.equal(getSpellingVariant('optimize'), 'optimise');
    assert.equal(getSpellingVariant('fiber'), 'fibre');
});

test('maps British -> American', () => {
    assert.equal(getSpellingVariant('colour'), 'color');
    assert.equal(getSpellingVariant('analyse'), 'analyze');
});

test('handles derived/prefix forms', () => {
    assert.equal(getSpellingVariant('colorful'), 'colourful');
    assert.equal(getSpellingVariant('neighborhood'), 'neighbourhood');
});

test('is case-insensitive', () => {
    assert.equal(getSpellingVariant('Color'), 'colour');
    assert.equal(getSpellingVariant('COLOUR'), 'color');
});

test('returns null when no variant exists', () => {
    assert.equal(getSpellingVariant('quantum'), null);
    assert.equal(getSpellingVariant(''), null);
    assert.equal(getSpellingVariant(undefined), null);
});
