import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { slugify, slugifyUnique } from '../../scripts/taxonomy/lib/slugify.js';
import { selectClassification } from '../../scripts/taxonomy/lib/classificationSelector.js';
import DepartmentResolver from '../../scripts/taxonomy/lib/departmentResolver.js';
import FacultyResolver from '../../scripts/taxonomy/lib/facultyResolver.js';
import IitdAuthorsBuilder from '../../scripts/taxonomy/lib/iitdAuthorsBuilder.js';
import TaxonomyBootstrapper from '../../scripts/taxonomy/lib/taxonomyBootstrapper.js';

describe('slugify', () => {
    it('converts theme names to url-safe slugs', () => {
        assert.equal(
            slugify('AI/ML, Supercomputing & Quantum Computing'),
            'ai-ml-supercomputing-and-quantum-computing'
        );
        assert.equal(slugify('Energy, Sustainability & Climate'), 'energy-sustainability-and-climate');
    });

    it('deduplicates colliding slugs with numeric suffixes', () => {
        const slugs = slugifyUnique(['Smart Grids', 'Smart-Grids']);
        assert.deepEqual([...slugs.values()].sort(), ['smart-grids', 'smart-grids-2']);
    });
});

describe('selectClassification', () => {
    const row = (over) => ({
        Broad_Theme: 'Theme A', L1_Confidence: 'LOW', L1_Score: '0.1',
        Domain: 'Dom X', Sub_Domain: 'Sub X', L3_Confidence: 'LOW', L3_Score: '0.1',
        IITD_Department: 'Dept X', Topic: 'topic', ...over
    });

    it('picks theme and subdomain winners independently by confidence then score', () => {
        const rows = [
            row({ Broad_Theme: 'Theme A', L1_Confidence: 'HIGH', L1_Score: '0.2', L3_Confidence: 'LOW', L3_Score: '0.9' }),
            row({ Broad_Theme: 'Theme B', L1_Confidence: 'LOW', L1_Score: '0.9', Domain: 'Dom Y', Sub_Domain: 'Sub Y', L3_Confidence: 'MEDIUM', L3_Score: '0.2', IITD_Department: 'Dept Y' })
        ];
        const result = selectClassification(rows);
        assert.equal(result.themeName, 'Theme A');       // HIGH beats LOW despite lower score
        assert.equal(result.subdomainName, 'Sub Y');     // MEDIUM beats LOW despite lower score
        assert.equal(result.domainName, 'Dom Y');        // domain always follows the subdomain winner
        assert.equal(result.fallbackDepartmentName, 'Dept Y'); // department also follows the subdomain winner
    });

    it('breaks confidence ties by score, then keeps CSV order deterministically', () => {
        const rows = [
            row({ Broad_Theme: 'First', L1_Score: '0.5' }),
            row({ Broad_Theme: 'Second', L1_Score: '0.5' }),
            row({ Broad_Theme: 'Third', L1_Score: '0.7' })
        ];
        assert.equal(selectClassification(rows).themeName, 'Third');
        assert.equal(selectClassification(rows.slice(0, 2)).themeName, 'First');
    });

    it('unions topics across rows, deduped case-insensitively', () => {
        const rows = [
            row({ Topic: 'Graph Networks' }),
            row({ Topic: 'graph networks' }),
            row({ Topic: 'Transformers' })
        ];
        assert.deepEqual(selectClassification(rows).topics, ['Graph Networks', 'Transformers']);
    });
});

describe('DepartmentResolver', () => {
    const resolver = new DepartmentResolver([
        { _id: 'd1', name: 'Department of Energy Science & Engineering', code: 'dese' },
        { _id: 'd2', name: 'Computer Science & Engineering', code: 'cse' }
    ]);

    it('resolves by exact name (case-insensitive)', () => {
        assert.equal(resolver.resolveByName('computer science & engineering')._id, 'd2');
    });

    it('resolves known CSV naming variants through the alias table', () => {
        assert.equal(resolver.resolveByName('Energy Science and Engineering')._id, 'd1');
    });

    it('reports unresolved names instead of guessing', () => {
        assert.equal(resolver.resolveByName('School of AI'), null);
        assert.deepEqual(resolver.unresolvedReport(), [{ name: 'School of AI', rows: 1 }]);
    });
});

describe('IitdAuthorsBuilder', () => {
    const facultyResolver = new FacultyResolver([
        { _id: 'f1', email: 'alice@iitd.ac.in', department: 'd1', scopus_id: ['111'] },
        { _id: 'f2', email: 'bob@iitd.ac.in', department: 'd2', scopus_id: ['222'] }
    ]);
    const departmentResolver = new DepartmentResolver([
        { _id: 'd9', name: 'Some Department', code: 'sd' }
    ]);

    it('unions the document kerberos and scopus matches, marking dual matches as both', () => {
        const builder = new IitdAuthorsBuilder({ facultyResolver, departmentResolver });
        const authors = builder.build('alice', ['111', '222', '999'], 'Some Department');

        const alice = authors.find(a => a.kerberos === 'alice');
        const bob = authors.find(a => a.kerberos === 'bob');
        assert.equal(authors.length, 2);
        assert.equal(alice.matched_via, 'both');
        assert.equal(bob.matched_via, 'scopus_id');
        assert.equal(bob.department_ref, 'd2');
    });

    it('keeps an unresolvable document kerberos as csv_fallback with department from the CSV', () => {
        const builder = new IitdAuthorsBuilder({ facultyResolver, departmentResolver });
        const authors = builder.build('ghost', [], 'Some Department');
        assert.equal(authors.length, 1);
        assert.equal(authors[0].faculty_ref, null);
        assert.equal(authors[0].department_ref, 'd9');
        assert.equal(authors[0].department_source, 'csv_fallback');
    });

    it('returns no entries when the document has neither a resolvable kerberos nor scopus authors', () => {
        const builder = new IitdAuthorsBuilder({ facultyResolver, departmentResolver });
        assert.deepEqual(builder.build('', [], ''), []);
    });
});

describe('TaxonomyBootstrapper', () => {
    it('collects distinct nodes and verifies Sub_Domain -> Domain is 1:1', () => {
        const bootstrapper = new TaxonomyBootstrapper({});
        const counts = bootstrapper.collect([
            { Broad_Theme: 'T1', Domain: 'D1', Sub_Domain: 'S1' },
            { Broad_Theme: 'T2', Domain: 'D1', Sub_Domain: 'S2' },
            { Broad_Theme: 'T1', Domain: 'D2', Sub_Domain: 'S3' }
        ]);
        assert.deepEqual(counts, { themes: 2, domains: 2, subdomains: 3 });
    });

    it('throws when a subdomain maps to two domains', () => {
        const bootstrapper = new TaxonomyBootstrapper({});
        assert.throws(() => bootstrapper.collect([
            { Broad_Theme: 'T', Domain: 'D1', Sub_Domain: 'S1' },
            { Broad_Theme: 'T', Domain: 'D2', Sub_Domain: 'S1' }
        ]), /not 1:1/);
    });
});
