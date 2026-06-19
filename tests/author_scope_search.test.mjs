import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Comprehensive tests for the author-scoped search endpoint.
 *
 * Requires a live search API at SEARCH_API_URL (default http://localhost:3000).
 * Run: node --test tests/author_scope_search.test.mjs
 *
 * Uses real author IDs from the 1000-doc test corpus:
 *   - 57188672005 (187 papers)  — top author by paper count
 *   - 36789930200 (144 papers)  — maps to expert_id 60793 (Prof Abhijit R Abhyankar)
 *   - 14824545400 (127 papers)
 */

const API_BASE = process.env.SEARCH_API_URL || `http://localhost:${process.env.PORT || 3000}/api/v1`;

async function post(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, body: await res.json() };
}

// Real IDs from the corpus — Scopus author_ids that exist on documents
const SCOPUS_AUTHOR_ID = '36789930200';   // 144 papers
const EXPERT_ID = '60793';                // maps to 36789930200 via Faculty MongoDB
const SECOND_AUTHOR_ID = '57188672005';   // 187 papers
const NONEXISTENT_ID = '99999999999';

// ── Prerequisites ──

describe('Author-scoped search prerequisites', () => {
    it('API is reachable', async () => {
        const rootBase = API_BASE.replace(/\/api\/v1$/, '');
        const res = await fetch(`${rootBase}/health`, { signal: AbortSignal.timeout(5000) });
        assert.equal(res.status, 200);
    });
});

// ── Basic author-scoped search ──

describe('Basic author-scoped search (query + author_id)', () => {
    it('returns results when querying with a Scopus author_id', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'power',
            author_id: SCOPUS_AUTHOR_ID,
            per_page: 10,
            mode: 'advanced',
        });
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.results), 'results should be an array');
        assert.ok(body.results.length > 0, 'should return at least one result');
        assert.ok(body.author, 'should include author metadata');
        assert.ok(body.pagination, 'should include pagination');
    });

    it('returns results when querying with an expert_id', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'power',
            author_id: EXPERT_ID,
            per_page: 10,
            mode: 'advanced',
        });
        assert.equal(status, 200);
        assert.ok(body.results.length > 0, 'expert_id should resolve and return results');
        assert.ok(body.author.name, 'author name should be resolved');
        assert.notEqual(body.author.name, 'Unknown', 'author name should not be Unknown for a valid faculty');
    });

    it('response has correct shape: results, author, pagination, meta', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'energy',
            author_id: EXPERT_ID,
            per_page: 5,
        });
        assert.equal(status, 200);

        // Results shape
        assert.ok(Array.isArray(body.results));
        if (body.results.length > 0) {
            const r = body.results[0];
            assert.ok(r._id, 'result should have _id');
            assert.ok(r.title, 'result should have title');
            assert.ok(typeof r.similarity_score === 'number', 'result should have numeric similarity_score');
        }

        // Author shape
        assert.ok(body.author);
        assert.ok(body.author.author_id);
        assert.ok(typeof body.author.total_papers === 'number');

        // Pagination shape
        assert.ok(body.pagination);
        assert.equal(typeof body.pagination.page, 'number');
        assert.equal(typeof body.pagination.per_page, 'number');
        assert.equal(typeof body.pagination.total, 'number');
        assert.equal(typeof body.pagination.total_pages, 'number');

        // Meta shape
        assert.ok(body.meta);
        assert.equal(typeof body.meta.took_ms, 'number');
    });

    it('all results belong to the queried author', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'optimization',
            author_id: SCOPUS_AUTHOR_ID,
            per_page: 20,
            mode: 'advanced',
        });
        assert.equal(status, 200);

        for (const result of body.results) {
            const authorIds = (result.authors || []).map(a => a.author_id);
            assert.ok(
                authorIds.includes(SCOPUS_AUTHOR_ID),
                `Result "${result.title?.slice(0, 60)}" should include author ${SCOPUS_AUTHOR_ID}, got: ${authorIds.join(', ')}`
            );
        }
    });
});

// ── Mode comparison: basic vs advanced ──

describe('Author-scoped search: basic vs advanced mode', () => {
    let basicBody, advancedBody;

    before(async () => {
        const query = 'power system';
        const [basic, advanced] = await Promise.all([
            post('/search/author-scope', { query, author_id: EXPERT_ID, mode: 'basic', per_page: 20 }),
            post('/search/author-scope', { query, author_id: EXPERT_ID, mode: 'advanced', per_page: 20 }),
        ]);
        assert.equal(basic.status, 200);
        assert.equal(advanced.status, 200);
        basicBody = basic.body;
        advancedBody = advanced.body;
    });

    it('both modes return results', () => {
        assert.ok(basicBody.results.length > 0, 'basic should return results');
        assert.ok(advancedBody.results.length > 0, 'advanced should return results');
    });

    it('both modes report the same author info', () => {
        assert.equal(basicBody.author.author_id, advancedBody.author.author_id);
        assert.equal(basicBody.author.total_papers, advancedBody.author.total_papers);
    });

    it('advanced mode uses normalized scores (not raw BM25)', () => {
        // After the fix: normalized scores should be in a reasonable range (< 5)
        // rather than raw BM25 scores (which can be 10-50+).
        for (const r of advancedBody.results) {
            assert.ok(
                r.similarity_score < 10,
                `Advanced mode score ${r.similarity_score} looks like un-normalized BM25 (expected < 10)`
            );
        }
    });

    it('advanced mode may recall more results via semantic similarity', () => {
        // Advanced uses embeddings so it can find semantically related papers
        // that lack exact keyword matches. It should find at least as many as basic.
        assert.ok(
            advancedBody.pagination.total >= basicBody.pagination.total * 0.5,
            `Advanced total (${advancedBody.pagination.total}) should not be drastically fewer than basic (${basicBody.pagination.total})`
        );
    });
});

// ── Empty query ──

describe('Author-scoped search with empty/missing query', () => {
    it('rejects empty string query (schema validation)', async () => {
        const { status } = await post('/search/author-scope', {
            query: '',
            author_id: EXPERT_ID,
        });
        assert.equal(status, 400, 'empty query should be rejected by schema validation');
    });

    it('rejects request without query field', async () => {
        const { status } = await post('/search/author-scope', {
            author_id: EXPERT_ID,
        });
        assert.equal(status, 400, 'missing query should be rejected');
    });

    it('rejects request without author_id field', async () => {
        const { status } = await post('/search/author-scope', {
            query: 'test',
        });
        assert.equal(status, 400, 'missing author_id should be rejected');
    });
});

// ── Pagination ──

describe('Author-scoped search pagination', () => {
    it('respects per_page limit', async () => {
        const perPage = 3;
        const { status, body } = await post('/search/author-scope', {
            query: 'power',
            author_id: EXPERT_ID,
            per_page: perPage,
        });
        assert.equal(status, 200);
        assert.ok(body.results.length <= perPage, `Expected <= ${perPage} results, got ${body.results.length}`);
    });

    it('page 2 returns different results than page 1', async () => {
        const params = { query: 'power', author_id: EXPERT_ID, per_page: 5 };
        const [p1, p2] = await Promise.all([
            post('/search/author-scope', { ...params, page: 1 }),
            post('/search/author-scope', { ...params, page: 2 }),
        ]);
        assert.equal(p1.status, 200);
        assert.equal(p2.status, 200);

        if (p2.body.results.length > 0) {
            const ids1 = new Set(p1.body.results.map(r => r._id));
            const ids2 = new Set(p2.body.results.map(r => r._id));
            for (const id of ids2) {
                assert.ok(!ids1.has(id), `Duplicate id ${id} across page 1 and page 2`);
            }
        }
    });

    it('pagination metadata is consistent', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'power',
            author_id: EXPERT_ID,
            per_page: 5,
            page: 1,
        });
        assert.equal(status, 200);
        assert.equal(body.pagination.page, 1);
        assert.equal(body.pagination.per_page, 5);
        assert.equal(
            body.pagination.total_pages,
            Math.ceil(body.pagination.total / body.pagination.per_page),
            'total_pages should be ceil(total / per_page)'
        );
    });

    it('requesting beyond available pages returns empty results', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'power',
            author_id: EXPERT_ID,
            per_page: 5,
            page: 500,
        });
        assert.equal(status, 200);
        assert.equal(body.results.length, 0, 'page far beyond total should return empty results');
    });
});

// ── Non-existent author ──

describe('Author-scoped search with non-existent author_id', () => {
    it('returns empty results for unknown author', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'machine learning',
            author_id: NONEXISTENT_ID,
        });
        assert.equal(status, 200);
        assert.equal(body.results.length, 0, 'should return no results for unknown author');
        assert.equal(body.author.total_papers, 0);
        assert.equal(body.pagination.total, 0);
    });
});

// ── Edge cases ──

describe('Author-scoped search edge cases', () => {
    it('handles single-character query', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'a',
            author_id: EXPERT_ID,
            per_page: 5,
        });
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.results), 'should return an array (possibly empty)');
    });

    it('handles very short query (2 chars)', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'AI',
            author_id: EXPERT_ID,
            per_page: 5,
        });
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.results));
    });

    it('handles query with special characters gracefully', async () => {
        const { status } = await post('/search/author-scope', {
            query: 'power (AC/DC) & "distribution"',
            author_id: EXPERT_ID,
            per_page: 5,
        });
        // Should not crash — either 200 with results or 200 with empty
        assert.ok([200, 400].includes(status), `Expected 200 or 400, got ${status}`);
    });

    it('handles query with unicode characters', async () => {
        const { status } = await post('/search/author-scope', {
            query: 'réseau électrique',
            author_id: EXPERT_ID,
            per_page: 5,
        });
        assert.ok([200, 400].includes(status), `Expected 200 or 400, got ${status}`);
    });

    it('handles long query string', async () => {
        const longQuery = 'advanced power system optimization using machine learning techniques for renewable energy integration and grid stability analysis';
        const { status, body } = await post('/search/author-scope', {
            query: longQuery,
            author_id: EXPERT_ID,
            per_page: 5,
        });
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.results));
    });
});

// ── Score quality (normalized hybrid regression) ──

describe('Author-scoped search score normalization (Bug fix regression)', () => {
    it('advanced mode scores are in normalized range, not raw BM25', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'Carbon',
            author_id: EXPERT_ID,
            per_page: 10,
            mode: 'advanced',
        });
        assert.equal(status, 200);
        assert.ok(body.results.length > 0, 'should find Carbon-related papers');

        for (const r of body.results) {
            // Normalized hybrid scores: BM25 sigmoid [0, bm25Weight] + kNN [0, vectorWeight]
            // Typically sum is < 3. Raw BM25 would be 10-50+.
            assert.ok(
                r.similarity_score < 5,
                `Score ${r.similarity_score} for "${r.title?.slice(0, 50)}" appears un-normalized (raw BM25 leaking)`
            );
        }
    });

    it('scores are sorted descending (most relevant first)', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'distribution network',
            author_id: EXPERT_ID,
            per_page: 10,
            mode: 'advanced',
        });
        assert.equal(status, 200);

        const scores = body.results.map(r => r.similarity_score);
        for (let i = 1; i < scores.length; i++) {
            assert.ok(
                scores[i - 1] >= scores[i] - 0.001,
                `Scores should be descending: position ${i - 1} (${scores[i - 1]}) >= position ${i} (${scores[i]})`
            );
        }
    });
});

// ── Consistency between expert_id and scopus_id ──

describe('Author-scoped search: expert_id vs scopus_id consistency', () => {
    it('expert_id and scopus_id return the same author info', async () => {
        const [byExpert, byScopus] = await Promise.all([
            post('/search/author-scope', { query: 'power', author_id: EXPERT_ID, per_page: 5 }),
            post('/search/author-scope', { query: 'power', author_id: SCOPUS_AUTHOR_ID, per_page: 5 }),
        ]);

        assert.equal(byExpert.status, 200);
        assert.equal(byScopus.status, 200);

        assert.equal(
            byExpert.body.author.total_papers,
            byScopus.body.author.total_papers,
            'expert_id and scopus_id should resolve to the same paper count'
        );

        assert.equal(
            byExpert.body.author.name,
            byScopus.body.author.name,
            'expert_id and scopus_id should resolve to the same author name'
        );
    });
});

// ── Different authors return different results ──

describe('Author-scoped search: different authors', () => {
    it('two different authors return different result sets for the same query', async () => {
        const query = 'optimization';
        const [a1, a2] = await Promise.all([
            post('/search/author-scope', { query, author_id: EXPERT_ID, per_page: 10 }),
            post('/search/author-scope', { query, author_id: SECOND_AUTHOR_ID, per_page: 10 }),
        ]);

        assert.equal(a1.status, 200);
        assert.equal(a2.status, 200);

        if (a1.body.results.length > 0 && a2.body.results.length > 0) {
            const ids1 = new Set(a1.body.results.map(r => r._id));
            const ids2 = new Set(a2.body.results.map(r => r._id));

            // At least some results should differ (different authors = different papers)
            const overlap = [...ids1].filter(id => ids2.has(id)).length;
            const maxPossible = Math.min(ids1.size, ids2.size);
            assert.ok(
                overlap < maxPossible,
                `Expected different result sets for different authors, but ${overlap}/${maxPossible} overlap`
            );
        }
    });
});

// ── Semantic / synonym recall in author-scoped search ──

describe('Author-scoped search: semantic and synonym recall', () => {
    it('finds semantically related papers (photovoltaic → solar/PV papers)', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'photovoltaic',
            author_id: EXPERT_ID,
            per_page: 20,
            mode: 'advanced',
        });
        assert.equal(status, 200);
        assert.ok(body.results.length > 1, `"photovoltaic" should find >1 result via semantic recall, got ${body.results.length}`);
        assert.ok(body.results.length <= 30, `should not flood with too many results (got ${body.results.length})`);
    });

    it('finds grid-related papers for "grid stability"', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'grid stability',
            author_id: EXPERT_ID,
            per_page: 20,
            mode: 'advanced',
        });
        assert.equal(status, 200);
        assert.ok(body.results.length > 1, `"grid stability" should find >1 result, got ${body.results.length}`);
    });

    it('still finds exact keyword matches (BM25 + kNN boost)', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'renewable energy',
            author_id: EXPERT_ID,
            per_page: 20,
            mode: 'advanced',
        });
        assert.equal(status, 200);
        assert.ok(body.results.length >= 10, `exact match "renewable energy" should find many results, got ${body.results.length}`);
    });

    it('does not flood with all papers for a domain-adjacent query', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'Carbon',
            author_id: EXPERT_ID,
            per_page: 50,
            mode: 'advanced',
        });
        assert.equal(status, 200);
        assert.ok(
            body.pagination.total < 40,
            `"Carbon" should find <40 results for this power-systems author, got ${body.pagination.total}`
        );
        if (body.results.length > 0) {
            const topTitle = body.results[0].title.toLowerCase();
            assert.ok(
                topTitle.includes('carbon') || topTitle.includes('emission') || topTitle.includes('low-carbon'),
                `Top result should be carbon-related: "${body.results[0].title.slice(0, 60)}"`
            );
        }
    });

    it('partial word "optim" matches "optimization" papers', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'optim',
            author_id: EXPERT_ID,
            per_page: 10,
            mode: 'advanced',
        });
        assert.equal(status, 200);
        assert.ok(body.results.length > 5, `"optim" should find optimization papers, got ${body.results.length}`);
    });
});

// ── Multi-page result quality ──

describe('Author-scoped search: multi-page score consistency', () => {
    it('page 2 scores are less than or equal to page 1 max score', async () => {
        const params = { query: 'power', author_id: EXPERT_ID, per_page: 10, mode: 'advanced' };
        const [p1, p2] = await Promise.all([
            post('/search/author-scope', { ...params, page: 1 }),
            post('/search/author-scope', { ...params, page: 2 }),
        ]);
        assert.equal(p1.status, 200);
        assert.equal(p2.status, 200);

        if (p1.body.results.length > 0 && p2.body.results.length > 0) {
            const p1MinScore = Math.min(...p1.body.results.map(r => r.similarity_score));
            const p2MaxScore = Math.max(...p2.body.results.map(r => r.similarity_score));
            assert.ok(
                p1MinScore >= p2MaxScore - 0.01,
                `Page 1 min score (${p1MinScore.toFixed(3)}) should >= page 2 max (${p2MaxScore.toFixed(3)})`
            );
        }
    });

    it('last page results still meet minimum relevance threshold', async () => {
        const { status, body } = await post('/search/author-scope', {
            query: 'power',
            author_id: EXPERT_ID,
            per_page: 10,
            page: 1,
            mode: 'advanced',
        });
        assert.equal(status, 200);
        const totalPages = body.pagination.total_pages;

        if (totalPages > 1) {
            const lastPage = await post('/search/author-scope', {
                query: 'power',
                author_id: EXPERT_ID,
                per_page: 10,
                page: totalPages,
                mode: 'advanced',
            });
            assert.equal(lastPage.status, 200);
            for (const r of lastPage.body.results) {
                assert.ok(
                    r.similarity_score >= 1.0,
                    `Last page result "${r.title?.slice(0, 40)}" score ${r.similarity_score} is below 1.0 threshold`
                );
            }
        }
    });
});

// ── General search pagination quality ──

describe('General search: pagination bounded by reranker window', () => {
    it('total results are capped to candidateK (50) in advanced mode', async () => {
        const { status, body } = await post('/search', {
            query: 'machine learning',
            mode: 'advanced',
            per_page: 10,
            page: 1,
        });
        assert.equal(status, 200);
        assert.ok(
            body.pagination.total <= 50,
            `Total should be capped at candidateK (50), got ${body.pagination.total}`
        );
        assert.ok(
            body.pagination.total_pages <= 5,
            `Total pages should be <=5, got ${body.pagination.total_pages}`
        );
    });

    it('page beyond reranker window returns empty results', async () => {
        const { status, body } = await post('/search', {
            query: 'machine learning',
            mode: 'advanced',
            per_page: 10,
            page: 6,
        });
        assert.equal(status, 200);
        assert.equal(body.results.length, 0, 'page 6 (beyond candidateK=50) should return empty results');
    });

    it('basic mode still returns all results (no candidateK cap)', async () => {
        const { status, body } = await post('/search', {
            query: 'power',
            mode: 'basic',
            per_page: 10,
            page: 1,
        });
        assert.equal(status, 200);
        assert.ok(body.pagination.total > 0, 'basic mode should return results');
    });
});
