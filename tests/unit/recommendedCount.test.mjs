import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeRecommendedCount } from '../../scripts/taxonomy/lib/recommendedCount.js';

const members = (counts) => counts.map((paper_count, i) => ({ kerberos: `f${i}`, paper_count }));

describe('computeRecommendedCount', () => {
    it('returns everyone when the area has at most `min` members', () => {
        const sorted = members([9, 5, 3, 2, 1]);
        assert.equal(computeRecommendedCount(sorted, { min: 6, max: 12 }), 5);
    });

    it('reaches 80% coverage quickly when a few members dominate', () => {
        // Two members carry the vast majority of papers; coverage hits well
        // before the domain ceiling.
        const sorted = members([50, 40, 2, 2, 2, 2, 2, 2, 2, 2]);
        const k = computeRecommendedCount(sorted, { min: 6, max: 12 });
        assert.ok(k < 12, `expected a cutoff below the ceiling, got ${k}`);
        assert.ok(k >= 6, `expected the floor to still apply, got ${k}`);
    });

    it('clamps to the domain ceiling (12) for a near-flat, tie-free distribution', () => {
        // Distinct (no ties at the boundary) but nearly uniform, so coverage
        // is only reached deep into the list — the ceiling is what bites.
        const sorted = members(Array.from({ length: 100 }, (_, i) => 1000 - i));
        assert.equal(computeRecommendedCount(sorted, { min: 6, max: 12 }), 12);
    });

    it('clamps to the theme ceiling (48) for a near-flat, tie-free distribution', () => {
        const sorted = members(Array.from({ length: 300 }, (_, i) => 1000 - i));
        assert.equal(computeRecommendedCount(sorted, { min: 6, max: 48 }), 48);
    });

    it('extends past the natural cutoff to include ties at the boundary', () => {
        // Coverage lands mid-tie-block; every member sharing the boundary
        // paper_count should be included, not just the first one reached.
        const sorted = members([20, 20, 20, 5, 5, 5, 5, 5, 5, 5, 5]);
        const k = computeRecommendedCount(sorted, { coverage: 0.5, min: 2, max: 20 });
        const boundary = sorted[k - 1].paper_count;
        const tieCount = sorted.filter((m) => m.paper_count === boundary).length;
        const includedTies = sorted.slice(0, k).filter((m) => m.paper_count === boundary).length;
        assert.equal(includedTies, tieCount, 'all members tied with the boundary value must be included');
    });

    it('caps runaway tie extension on a fully flat distribution', () => {
        // Everyone ties at the same paper_count — without a tie ceiling this
        // would extend all the way to `total`.
        const sorted = members(Array.from({ length: 200 }, () => 1));
        const k = computeRecommendedCount(sorted, { min: 6, max: 12 });
        assert.equal(k, Math.round(12 * 1.5));
    });
});
