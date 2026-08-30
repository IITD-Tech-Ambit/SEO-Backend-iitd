import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const API_BASE = process.env.SEARCH_API_URL || `http://localhost:${process.env.PORT || 3001}/api/v1`;
const ROOT_BASE = API_BASE.replace(/\/api\/v1$/, '');
const batch = JSON.parse(readFileSync(new URL('../fixtures/fresh_retrieval_batch.json', import.meta.url)));
const docs = batch.docs || [];
const ipDocs = batch.ip || [];

const DISTINCTIVE = /terahertz|vienna|yrn2|haptoglobin|linguistics|zno|deinococcus|alfv/i;
const TITLE_DOCS = docs.filter((d) => DISTINCTIVE.test(d.title)).slice(0, 6);
const REFINE_DOCS = TITLE_DOCS.filter((d) => (d.title_terms || []).length >= 3).slice(0, 4);
const AUTHOR_DOCS = docs.filter((d) => d.author_id && DISTINCTIVE.test(d.title)).slice(0, 4);
const EXPERT_DOCS = docs.filter((d) => d.expert_id && d.faculty_name);
const FILTER_DOCS = TITLE_DOCS.filter((d) => d.field_associated && d.year && d.document_type);
const IP_TITLE = ipDocs.filter((d) => d.title).slice(0, 3);
const IP_FACULTY = ipDocs.filter((d) => d.expert_id && d.inventor_kerberos);

let serverUp = false;
let probeError = null;

async function post(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
    });
    return { status: res.status, body: await res.json() };
}

async function get(path, params) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${API_BASE}${path}?${qs}`, {
        method: 'GET',
        signal: AbortSignal.timeout(45_000),
    });
    return { status: res.status, body: await res.json() };
}

const totalOf = (body) => body.pagination?.total ?? body.total_matching_papers ?? body.total_matching_ip ?? -1;

function hasDoc(body, d) {
    return (body.results || []).some((r) => {
        const ids = [r._id, r.mongo_id, r.open_search_id].filter(Boolean).map(String);
        return ids.includes(String(d.id)) || ids.includes(String(d.os));
    });
}

function surname(d) {
    const n = d.author_name || d.first_author_name || '';
    return n.split(',')[0].trim();
}

function requireApi() {
    assert.ok(serverUp, `API not reachable at ${ROOT_BASE} — ${probeError}`);
}

before(async () => {
    try {
        const res = await fetch(`${ROOT_BASE}/health`, { signal: AbortSignal.timeout(3000) });
        serverUp = res.status === 200;
        if (!serverUp) probeError = `GET ${ROOT_BASE}/health returned ${res.status}`;
    } catch (err) {
        serverUp = false;
        probeError = err.message;
    }
});

describe('fresh batch', () => {
    it('has papers, IP, and distinctive titles', () => {
        assert.ok(docs.length >= 8, `expected paper batch, got ${docs.length}`);
        assert.ok(ipDocs.length >= 3, `expected IP batch, got ${ipDocs.length}`);
        assert.ok(TITLE_DOCS.length >= 4, `expected distinctive titles, got ${TITLE_DOCS.length}`);
    });
});

for (const mode of ['basic', 'advanced']) {
    describe(`exact title (${mode})`, () => {
        for (const d of TITLE_DOCS) {
            it(`recalls ${d.id}`, async () => {
                requireApi();
                const { status, body } = await post('/search', {
                    query: d.title, mode, per_page: 20, sort: 'relevance', filters: {},
                });
                assert.equal(status, 200);
                assert.ok(totalOf(body) >= 1, `no hits for ${d.title}`);
                assert.ok(hasDoc(body, d), `source missing from ${mode} title search: ${d.title}`);
            });
        }
    });
}

describe('search_in scoping', () => {
    it('title field recalls the source', async () => {
        requireApi();
        const d = TITLE_DOCS[0];
        const { status, body } = await post('/search', {
            query: d.title, mode: 'basic', search_in: ['title'], per_page: 10, filters: {},
        });
        assert.equal(status, 200);
        assert.ok(hasDoc(body, d));
    });

    it('author field + year finds the first author paper', async () => {
        requireApi();
        const d = AUTHOR_DOCS.find((x) => surname(x).length >= 4) || AUTHOR_DOCS[0];
        const { status, body } = await post('/search', {
            query: surname(d),
            mode: 'basic',
            search_in: ['author'],
            per_page: 20,
            filters: { year_from: d.year, year_to: d.year, author_id: d.author_id },
        });
        assert.equal(status, 200);
        assert.ok(totalOf(body) >= 1);
        assert.ok(hasDoc(body, d), `author-scoped search_in missed ${d.title}`);
    });

    it('title words do not match when search_in is author', async () => {
        requireApi();
        const d = TITLE_DOCS[0];
        const { status, body } = await post('/search', {
            query: d.title, mode: 'basic', search_in: ['author'], per_page: 5, filters: {},
        });
        assert.equal(status, 200);
        assert.equal(totalOf(body), 0);
    });

    it('field search_in matches field_associated', async () => {
        requireApi();
        const d = FILTER_DOCS[0];
        const token = d.field_associated.split(/[\s,]+/).find((w) => w.length > 4) || d.field_associated;
        const { status, body } = await post('/search', {
            query: token,
            mode: 'basic',
            search_in: ['field'],
            per_page: 10,
            filters: { year_from: d.year, year_to: d.year, author_id: d.author_id },
        });
        assert.equal(status, 200);
        assert.ok(totalOf(body) >= 1);
        assert.ok(hasDoc(body, d));
    });
});

describe('exact vs nearest on distinctive bigrams', () => {
    for (const d of TITLE_DOCS.slice(0, 4)) {
        it(`basic ⊆ nearest: ${d.bigram}`, async () => {
            requireApi();
            const basic = await post('/search', { query: d.bigram, mode: 'basic', per_page: 10, filters: {} });
            const adv = await post('/search', { query: d.bigram, mode: 'advanced', per_page: 10, filters: {} });
            assert.equal(basic.status, 200);
            assert.equal(adv.status, 200);
            assert.ok(totalOf(basic.body) <= totalOf(adv.body), `basic ${totalOf(basic.body)} > advanced ${totalOf(adv.body)} for ${d.bigram}`);
            if (totalOf(basic.body) > 0) assert.ok(hasDoc(basic.body, d) || hasDoc(adv.body, d));
        });
    }
});

describe('search-on-search refine_chain', () => {
    for (const d of REFINE_DOCS) {
        const query = d.title_terms.slice(0, 2).join(' ');
        const refine = d.title_terms[2];
        it(`narrows "${query}" with "${refine}"`, async () => {
            requireApi();
            const base = await post('/search', { query, mode: 'advanced', per_page: 20, filters: {} });
            const refined = await post('/search', {
                query: refine, mode: 'advanced', per_page: 20, filters: {}, refine_chain: [query],
            });
            assert.equal(base.status, 200);
            assert.equal(refined.status, 200);
            assert.ok(totalOf(refined.body) <= totalOf(base.body), `refine broadened ${totalOf(base.body)} → ${totalOf(refined.body)}`);
            if (hasDoc(base.body, d) && totalOf(refined.body) > 0) {
                assert.ok(hasDoc(refined.body, d));
            }
        });
    }

    it('refine_within matches a one-step refine_chain', async () => {
        requireApi();
        const d = REFINE_DOCS[0];
        const query = d.title_terms[2];
        const prior = d.title_terms.slice(0, 2).join(' ');
        const legacy = await post('/search', {
            query, mode: 'basic', per_page: 10, filters: {}, refine_within: prior,
        });
        const chain = await post('/search', {
            query, mode: 'basic', per_page: 10, filters: {}, refine_chain: [prior],
        });
        assert.equal(legacy.status, 200);
        assert.equal(chain.status, 200);
        assert.equal(totalOf(legacy.body), totalOf(chain.body));
    });

    it('gibberish refine is empty', async () => {
        requireApi();
        const { status, body } = await post('/search', {
            query: 'qwxzjkvbnm', mode: 'advanced', per_page: 10, filters: {},
            refine_chain: [REFINE_DOCS[0].title_terms.slice(0, 2).join(' ')],
        });
        assert.equal(status, 200);
        assert.equal(totalOf(body), 0);
    });
});

describe('filters', () => {
    it('year pin keeps the source', async () => {
        requireApi();
        const d = FILTER_DOCS[0];
        const { status, body } = await post('/search', {
            query: d.title, mode: 'basic', per_page: 10,
            filters: { year_from: d.year, year_to: d.year },
        });
        assert.equal(status, 200);
        assert.ok(hasDoc(body, d));
    });

    it('wrong year is empty', async () => {
        requireApi();
        const d = FILTER_DOCS[0];
        const { status, body } = await post('/search', {
            query: d.title, mode: 'basic', per_page: 5,
            filters: { year_from: 1900, year_to: 1901 },
        });
        assert.equal(status, 200);
        assert.equal(totalOf(body), 0);
    });

    it('exact field_associated keeps the source', async () => {
        requireApi();
        const d = FILTER_DOCS[0];
        const { status, body } = await post('/search', {
            query: d.title, mode: 'basic', per_page: 10,
            filters: { field_associated: d.field_associated },
        });
        assert.equal(status, 200);
        assert.ok(hasDoc(body, d));
    });

    it('wrong field_associated is empty', async () => {
        requireApi();
        const d = FILTER_DOCS.find((x) => x.field_associated !== 'Arts and Humanities') || FILTER_DOCS[0];
        const { status, body } = await post('/search', {
            query: d.title, mode: 'basic', per_page: 5,
            filters: { field_associated: 'Arts and Humanities' },
        });
        assert.equal(status, 200);
        if (d.field_associated !== 'Arts and Humanities') assert.equal(totalOf(body), 0);
    });

    it('document_type keeps the source', async () => {
        requireApi();
        const d = FILTER_DOCS[0];
        const { status, body } = await post('/search', {
            query: d.title, mode: 'basic', per_page: 10,
            filters: { document_type: d.document_type },
        });
        assert.equal(status, 200);
        assert.ok(hasDoc(body, d));
    });

    it('author_id filter keeps that author paper', async () => {
        requireApi();
        const d = AUTHOR_DOCS[0];
        const { status, body } = await post('/search', {
            query: d.title, mode: 'basic', per_page: 10,
            filters: { author_id: d.author_id },
        });
        assert.equal(status, 200);
        assert.ok(hasDoc(body, d));
    });

    it('first_author_only + author_id keeps a first-author paper', async () => {
        requireApi();
        const d = AUTHOR_DOCS.find((x) => x.author_is_first) || AUTHOR_DOCS[0];
        const { status, body } = await post('/search', {
            query: d.title, mode: 'basic', per_page: 10,
            filters: { author_id: d.author_id, first_author_only: true },
        });
        assert.equal(status, 200);
        assert.ok(hasDoc(body, d));
    });

    it('kerberos filter keeps the source', async () => {
        requireApi();
        const d = TITLE_DOCS.find((x) => x.kerberos);
        const { status, body } = await post('/search', {
            query: d.title, mode: 'basic', per_page: 10,
            filters: { kerberos: d.kerberos },
        });
        assert.equal(status, 200);
        assert.ok(hasDoc(body, d));
    });
});

describe('author-scope', () => {
    for (const d of AUTHOR_DOCS) {
        it(`scopes ${d.author_id} to "${d.bigram}"`, async () => {
            requireApi();
            const { status, body } = await post('/search/author-scope', {
                query: d.bigram, author_id: d.author_id, mode: 'advanced', per_page: 20,
            });
            assert.equal(status, 200);
            assert.ok(body.author, 'missing author block');
            if (totalOf(body) > 0) {
                assert.ok(hasDoc(body, d) || (body.author.total_papers ?? 0) >= 1);
            }
        });
    }

    it('expert_id resolves faculty', async () => {
        requireApi();
        const d = EXPERT_DOCS[0];
        assert.ok(d, 'fixture has no faculty-resolved expert_id');
        const { status, body } = await post('/search/author-scope', {
            query: d.bigram, author_id: d.expert_id, mode: 'basic', per_page: 10,
        });
        assert.equal(status, 200);
        assert.ok(body.author);
        assert.notEqual(body.author.name, 'Unknown');
    });

    it('ungrounded newest refine is empty', async () => {
        requireApi();
        const d = AUTHOR_DOCS[0];
        const { status, body } = await post('/search/author-scope', {
            query: 'qwxzjkvbnm', author_id: d.author_id, mode: 'advanced', per_page: 10,
            refine_chain: [d.bigram],
        });
        assert.equal(status, 200);
        assert.equal(totalOf(body), 0);
        assert.equal((body.results || []).length, 0);
    });

    it('ungrounded refine anchor is empty', async () => {
        requireApi();
        const d = AUTHOR_DOCS[0];
        const { status, body } = await post('/search/author-scope', {
            query: d.bigram, author_id: d.author_id, mode: 'advanced', per_page: 10,
            refine_chain: ['qwxzjkvbnm'],
        });
        assert.equal(status, 200);
        assert.equal(totalOf(body), 0);
    });

    it('gibberish without a chain is empty', async () => {
        requireApi();
        const d = AUTHOR_DOCS[0];
        const { status, body } = await post('/search/author-scope', {
            query: 'qwxzjkvbnm', author_id: d.author_id, mode: 'advanced', per_page: 10,
        });
        assert.equal(status, 200);
        assert.equal(totalOf(body), 0);
    });
});

describe('people sidebar matches papers total', () => {
    const peopleQueries = ['Oncology', ...TITLE_DOCS.slice(0, 2).map((d) => d.bigram)];
    for (const q of peopleQueries) {
        it(`"${q}"`, async () => {
            requireApi();
            const papers = await post('/search', { query: q, mode: 'advanced', per_page: 5, filters: {} });
            const people = await get('/search/faculty-for-query', { query: q, mode: 'advanced' });
            assert.equal(papers.status, 200);
            assert.equal(people.status, 200);
            assert.equal(people.body.total_matching_papers, totalOf(papers.body));
        });
    }

    it('matches under year + field filters', async () => {
        requireApi();
        const d = FILTER_DOCS[0];
        const filters = { year_from: d.year, year_to: d.year, field_associated: d.field_associated };
        const papers = await post('/search', { query: d.bigram, mode: 'basic', per_page: 5, filters });
        const people = await get('/search/faculty-for-query', {
            query: d.bigram, mode: 'basic', filters: JSON.stringify(filters),
        });
        assert.equal(papers.status, 200);
        assert.equal(people.status, 200);
        assert.equal(people.body.total_matching_papers, totalOf(papers.body));
    });
});

describe('admission gate', () => {
    for (const q of ['Cow Dung for curing cancer', 'cow dung cancer', 'aaa bbb ccc']) {
        it(`"${q}" is empty in both modes and people`, async () => {
            requireApi();
            for (const mode of ['basic', 'advanced']) {
                const papers = await post('/search', { query: q, mode, per_page: 10, filters: {} });
                const people = await get('/search/faculty-for-query', { query: q, mode });
                assert.equal(papers.status, 200);
                assert.equal(totalOf(papers.body), 0, `${mode} papers should be 0 for ${q}`);
                assert.equal(people.status, 200);
                assert.equal(people.body.total_faculty, 0);
                assert.equal(people.body.total_matching_papers, 0);
            }
        });
    }
});

describe('IP exact title', () => {
    for (const d of IP_TITLE) {
        it(`recalls ${d.id}`, async () => {
            requireApi();
            const { status, body } = await post('/ip/search', {
                query: d.title, mode: 'basic', per_page: 10, filters: {},
            });
            assert.equal(status, 200);
            assert.ok(totalOf(body) >= 1, `no IP hits for ${d.title}`);
            assert.ok(hasDoc(body, d), `IP source missing: ${d.title}`);
        });
    }

    it('search_in title recalls the source', async () => {
        requireApi();
        const d = IP_TITLE[0];
        const { status, body } = await post('/ip/search', {
            query: d.title, mode: 'basic', search_in: ['title'], per_page: 10, filters: {},
        });
        assert.equal(status, 200);
        assert.ok(hasDoc(body, d));
    });

    it('year pin keeps the source', async () => {
        requireApi();
        const d = IP_TITLE.find((x) => x.year);
        const { status, body } = await post('/ip/search', {
            query: d.title, mode: 'basic', per_page: 10,
            filters: { year_from: d.year, year_to: d.year },
        });
        assert.equal(status, 200);
        assert.ok(hasDoc(body, d));
    });

    it('field_of_invention pin keeps the source', async () => {
        requireApi();
        const d = IP_TITLE.find((x) => x.field_of_invention);
        const { status, body } = await post('/ip/search', {
            query: d.title, mode: 'basic', per_page: 10,
            filters: { field_of_invention: d.field_of_invention },
        });
        assert.equal(status, 200);
        assert.ok(hasDoc(body, d));
    });

    it('conjunction fail is empty', async () => {
        requireApi();
        const { status, body } = await post('/ip/search', {
            query: 'Cow Dung for curing cancer', mode: 'advanced', per_page: 10, filters: {},
        });
        assert.equal(status, 200);
        assert.equal(totalOf(body), 0);
    });
});

describe('IP inventor-scope', () => {
    it('expert_id + title word recalls the filing', async () => {
        requireApi();
        const d = IP_FACULTY[0];
        assert.ok(d, 'fixture has no faculty inventor');
        const q = d.title.split(/\s+/).filter((w) => w.length > 5).slice(0, 2).join(' ');
        const { status, body } = await post('/ip/search/inventor-scope', {
            query: q, inventor_id: d.expert_id, mode: 'basic', per_page: 20,
        });
        assert.equal(status, 200);
        assert.ok(totalOf(body) >= 1);
        assert.ok(hasDoc(body, d) || (body.inventor?.total_ip ?? 0) >= 1);
    });

    it('kerberos scopes the same inventor', async () => {
        requireApi();
        const d = IP_FACULTY[0];
        const { status, body } = await post('/ip/search/inventor-scope', {
            query: d.title, inventor_id: d.inventor_kerberos, mode: 'basic', per_page: 10,
        });
        assert.equal(status, 200);
        assert.ok(hasDoc(body, d));
    });

    it('ungrounded newest refine is empty', async () => {
        requireApi();
        const d = IP_FACULTY[0];
        const { status, body } = await post('/ip/search/inventor-scope', {
            query: 'qwxzjkvbnm', inventor_id: d.expert_id, mode: 'advanced', per_page: 10,
            refine_chain: [d.title.split(/\s+/).slice(0, 2).join(' ')],
        });
        assert.equal(status, 200);
        assert.equal(totalOf(body), 0);
        assert.equal((body.results || []).length, 0);
    });

    it('ungrounded refine anchor is empty', async () => {
        requireApi();
        const d = IP_FACULTY[0];
        const { status, body } = await post('/ip/search/inventor-scope', {
            query: d.title.split(/\s+/).slice(0, 2).join(' '),
            inventor_id: d.expert_id, mode: 'advanced', per_page: 10,
            refine_chain: ['qwxzjkvbnm'],
        });
        assert.equal(status, 200);
        assert.equal(totalOf(body), 0);
    });

    it('gibberish without a chain is empty', async () => {
        requireApi();
        const d = IP_FACULTY[0];
        const { status, body } = await post('/ip/search/inventor-scope', {
            query: 'qwxzjkvbnm', inventor_id: d.expert_id, mode: 'advanced', per_page: 10,
        });
        assert.equal(status, 200);
        assert.equal(totalOf(body), 0);
    });
});

describe('IP people sidebar matches IP total', () => {
    for (const q of ['polygon autotransformer', 'biochar', 'ripstop weaves']) {
        it(`"${q}"`, async () => {
            requireApi();
            const ips = await post('/ip/search', { query: q, mode: 'advanced', per_page: 5, filters: {} });
            const people = await get('/ip/faculty-for-query', { query: q, mode: 'advanced' });
            assert.equal(ips.status, 200);
            assert.equal(people.status, 200);
            assert.equal(people.body.total_matching_ip, totalOf(ips.body));
        });
    }
});
