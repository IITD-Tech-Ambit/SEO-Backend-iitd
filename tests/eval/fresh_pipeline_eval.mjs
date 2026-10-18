#!/usr/bin/env node
import { writeFile } from 'fs/promises';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { computeAll } from './metrics.mjs';

dotenv.config();

const API_BASE = process.env.SEARCH_API_URL || `http://localhost:${process.env.PORT || 3001}/api/v1`;
const ROOT_BASE = API_BASE.replace(/\/api\/v1$/, '');
const OUT_BATCH = new URL('../fixtures/fresh_eval_batch.json', import.meta.url);
const OUT_REPORT = new URL('../fixtures/fresh_eval_report.json', import.meta.url);

const STOP = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into', 'is', 'it',
    'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there', 'these',
    'they', 'this', 'to', 'was', 'will', 'with',
]);

const INDEXED = {
    open_search_id: { $exists: true, $nin: [null, ''] },
    $expr: { $not: { $regexMatch: { input: '$open_search_id', regex: /^pending_/ } } },
};

const contentTerms = (s) => {
    const terms = String(s ?? '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));
    return terms;
};

const idsOf = (body) => (body.results || []).map((r) => String(r._id || r.mongo_id || r.open_search_id || '')).filter(Boolean);
const totalOf = (body) => body.pagination?.total ?? body.total_matching_papers ?? body.total_matching_ip ?? -1;
const hasId = (body, id) => idsOf(body).includes(String(id));

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
    const res = await fetch(`${API_BASE}${path}?${qs}`, { signal: AbortSignal.timeout(45_000) });
    return { status: res.status, body: await res.json() };
}

async function fetchBatch() {
    await mongoose.connect(process.env.MONGODB_URI);
    const papers = mongoose.connection.collection('researchmetadatascopus');
    const ips = mongoose.connection.collection('ipmetadatas');
    const faculty = mongoose.connection.collection('faculties');

    const fields = await papers.aggregate([
        { $match: { ...INDEXED, field_associated: { $type: 'string', $ne: '' } } },
        { $group: { _id: '$field_associated', n: { $sum: 1 } } },
        { $match: { n: { $gte: 80 } } },
        { $sort: { n: -1 } },
        { $limit: 12 },
    ]).toArray();

    const docs = [];
    for (const f of fields) {
        const sampled = await papers.aggregate([
            {
                $match: {
                    ...INDEXED,
                    field_associated: f._id,
                    title: { $type: 'string' },
                    $expr: { $gte: [{ $strLenCP: '$title' }, 28] },
                },
            },
            { $sample: { size: 3 } },
            {
                $project: {
                    title: 1, publication_year: 1, document_type: 1, field_associated: 1,
                    subject_area: 1, authors: 1, kerberos: 1, open_search_id: 1,
                },
            },
        ]).toArray();
        docs.push(...sampled);
    }

    const scopusIds = [...new Set(docs.flatMap((d) => (d.authors || []).map((a) => a.author_id).filter(Boolean)))];
    const facRows = await faculty.find({ scopus_id: { $in: scopusIds } }).project({
        expert_id: 1, firstName: 1, lastName: 1, email: 1, scopus_id: 1,
    }).toArray();
    const facByScopus = {};
    for (const f of facRows) for (const sid of f.scopus_id || []) facByScopus[sid] = f;

    const paperBatch = docs.map((d) => {
        const terms = contentTerms(d.title);
        const first = (d.authors || [])[0] || {};
        const fac = facByScopus[first.author_id];
        return {
            id: String(d._id),
            os: d.open_search_id,
            title: d.title,
            year: d.publication_year,
            document_type: d.document_type || null,
            field_associated: d.field_associated,
            title_terms: terms,
            bigram: terms.slice(0, 2).join(' '),
            author_id: first.author_id || null,
            author_name: first.author_name || '',
            kerberos: d.kerberos || null,
            expert_id: fac?.expert_id || null,
            faculty_name: fac ? `${fac.firstName} ${fac.lastName}`.trim() : null,
        };
    }).filter((d) => d.title_terms.length >= 2);

    const ipSample = await ips.aggregate([
        { $match: { ...INDEXED, title: { $type: 'string' }, $expr: { $gte: [{ $strLenCP: '$title' }, 20] } } },
        { $sample: { size: 10 } },
        { $project: { title: 1, open_search_id: 1, type_of_ip: 1, field_of_invention: 1, publication_year: 1, inventors: 1 } },
    ]).toArray();

    const ipKerberos = [...new Set(ipSample.flatMap((d) => (d.inventors || []).map((i) => i.kerberos).filter(Boolean)))];
    const facByKerberos = {};
    if (ipKerberos.length) {
        const re = ipKerberos.map((k) => new RegExp(`^${k}@`, 'i'));
        const f2 = await faculty.find({ email: { $in: re } }).project({ expert_id: 1, firstName: 1, lastName: 1, email: 1 }).toArray();
        for (const f of f2) facByKerberos[(f.email || '').split('@')[0].toLowerCase()] = f;
    }

    const ipBatch = ipSample.map((d) => {
        const inv = (d.inventors || [])[0] || {};
        const fac = inv.kerberos ? facByKerberos[String(inv.kerberos).toLowerCase()] : null;
        return {
            id: String(d._id),
            os: d.open_search_id,
            title: d.title,
            year: d.publication_year || null,
            type_of_ip: d.type_of_ip || null,
            field_of_invention: d.field_of_invention || null,
            inventor: inv.name || null,
            inventor_kerberos: inv.kerberos || null,
            expert_id: fac?.expert_id || null,
            title_terms: contentTerms(d.title),
        };
    });

    await mongoose.disconnect();
    return {
        fetched_at: new Date().toISOString(),
        fields: fields.map((f) => f._id),
        docs: paperBatch,
        ip: ipBatch,
    };
}

function buildCases(batch) {
    const papers = batch.docs;
    const ip = batch.ip;
    const titleDocs = papers.filter((d) => d.title_terms.length >= 3).slice(0, 16);
    const refineDocs = titleDocs.filter((d) => d.title_terms.length >= 3).slice(0, 8);
    const authorDocs = papers.filter((d) => d.author_id).slice(0, 8);
    const expertDocs = papers.filter((d) => d.expert_id);
    const ipTitle = ip.slice(0, 6);
    const ipFac = ip.filter((d) => d.expert_id || d.inventor_kerberos);
    const cases = [];

    for (const mode of ['basic', 'advanced']) {
        for (const d of titleDocs) {
            cases.push({
                id: `title-${mode}-${d.id}`,
                kind: `exact_title_${mode}`,
                relevant: { [d.id]: 3 },
                run: async () => {
                    const { status, body } = await post('/search', { query: d.title, mode, per_page: 20, filters: {} });
                    return { status, body, retrieved: idsOf(body), ok: status === 200 && hasId(body, d.id), detail: d.title };
                },
            });
        }
    }

    for (const d of titleDocs.slice(0, 8)) {
        cases.push({
            id: `search_in_title-${d.id}`,
            kind: 'search_in_title',
            relevant: { [d.id]: 3 },
            run: async () => {
                const { status, body } = await post('/search', { query: d.title, mode: 'basic', search_in: ['title'], per_page: 10, filters: {} });
                return { status, body, retrieved: idsOf(body), ok: status === 200 && hasId(body, d.id), detail: d.title };
            },
        });
        cases.push({
            id: `year_pin-${d.id}`,
            kind: 'filter_year',
            relevant: { [d.id]: 3 },
            run: async () => {
                const { status, body } = await post('/search', {
                    query: d.title, mode: 'basic', per_page: 10,
                    filters: { year_from: d.year, year_to: d.year },
                });
                return { status, body, retrieved: idsOf(body), ok: status === 200 && hasId(body, d.id), detail: `${d.year}` };
            },
        });
        cases.push({
            id: `year_miss-${d.id}`,
            kind: 'filter_year_miss',
            run: async () => {
                const { status, body } = await post('/search', {
                    query: d.title, mode: 'basic', per_page: 5,
                    filters: { year_from: 1900, year_to: 1901 },
                });
                return { status, body, retrieved: idsOf(body), ok: status === 200 && totalOf(body) === 0, detail: d.title };
            },
        });
        cases.push({
            id: `field_pin-${d.id}`,
            kind: 'filter_field',
            relevant: { [d.id]: 3 },
            run: async () => {
                const { status, body } = await post('/search', {
                    query: d.title, mode: 'basic', per_page: 10,
                    filters: { field_associated: d.field_associated },
                });
                return { status, body, retrieved: idsOf(body), ok: status === 200 && hasId(body, d.id), detail: d.field_associated };
            },
        });
    }

    for (const d of titleDocs.slice(0, 8)) {
        cases.push({
            id: `basic_le_advanced-${d.id}`,
            kind: 'basic_subseteq_advanced',
            run: async () => {
                const basic = await post('/search', { query: d.bigram, mode: 'basic', per_page: 10, filters: {} });
                const adv = await post('/search', { query: d.bigram, mode: 'advanced', per_page: 10, filters: {} });
                const ok = basic.status === 200 && adv.status === 200 && totalOf(basic.body) <= totalOf(adv.body);
                return { status: adv.status, body: adv.body, retrieved: idsOf(adv.body), ok, detail: `${d.bigram} ${totalOf(basic.body)}<=${totalOf(adv.body)}` };
            },
        });
    }

    for (const d of refineDocs) {
        const query = d.title_terms.slice(0, 2).join(' ');
        const refine = d.title_terms[2];
        cases.push({
            id: `refine-${d.id}`,
            kind: 'refine_narrows',
            run: async () => {
                const base = await post('/search', { query, mode: 'advanced', per_page: 10, filters: {} });
                const refined = await post('/search', { query: refine, mode: 'advanced', per_page: 10, filters: {}, refine_chain: [query] });
                const ok = base.status === 200 && refined.status === 200 && totalOf(refined.body) <= totalOf(base.body);
                return { status: refined.status, body: refined.body, retrieved: idsOf(refined.body), ok, detail: `${query} + ${refine}` };
            },
        });
    }

    cases.push({
        id: 'refine-gibberish',
        kind: 'refine_ungrounded',
        run: async () => {
            const { status, body } = await post('/search', {
                query: 'qwxzjkvbnm', mode: 'advanced', per_page: 10, filters: {},
                refine_chain: [refineDocs[0]?.bigram || 'machine learning'],
            });
            return { status, body, retrieved: idsOf(body), ok: status === 200 && totalOf(body) === 0, detail: 'qwxzjkvbnm' };
        },
    });

    for (const d of authorDocs.slice(0, 6)) {
        cases.push({
            id: `author_scope-${d.author_id}`,
            kind: 'author_scope',
            relevant: d.id ? { [d.id]: 3 } : undefined,
            run: async () => {
                const { status, body } = await post('/search/author-scope', {
                    query: d.bigram, author_id: d.author_id, mode: 'advanced', per_page: 20,
                });
                const ok = status === 200 && !!body.author && (totalOf(body) === 0 || hasId(body, d.id) || (body.author.total_papers ?? 0) >= 1);
                return { status, body, retrieved: idsOf(body), ok, detail: `${d.author_id} ${d.bigram}` };
            },
        });
    }

    if (expertDocs[0]) {
        const d = expertDocs[0];
        cases.push({
            id: `author_scope_expert-${d.expert_id}`,
            kind: 'author_scope_expert',
            run: async () => {
                const { status, body } = await post('/search/author-scope', {
                    query: d.bigram, author_id: d.expert_id, mode: 'basic', per_page: 10,
                });
                return { status, body, retrieved: idsOf(body), ok: status === 200 && body.author && body.author.name !== 'Unknown', detail: d.faculty_name };
            },
        });
        cases.push({
            id: `author_scope_ungrounded-${d.author_id}`,
            kind: 'author_scope_ungrounded',
            run: async () => {
                const { status, body } = await post('/search/author-scope', {
                    query: 'qwxzjkvbnm', author_id: d.author_id, mode: 'advanced', per_page: 10,
                    refine_chain: [d.bigram],
                });
                return { status, body, retrieved: idsOf(body), ok: status === 200 && totalOf(body) === 0, detail: d.bigram };
            },
        });
    }

    for (const q of ['Oncology', ...titleDocs.slice(0, 4).map((d) => d.bigram)]) {
        cases.push({
            id: `people-${q}`,
            kind: 'people_total_match',
            run: async () => {
                const papers = await post('/search', { query: q, mode: 'advanced', per_page: 5, filters: {} });
                const people = await get('/search/faculty-for-query', { query: q, mode: 'advanced' });
                const ok = papers.status === 200 && people.status === 200 && people.body.total_matching_papers === totalOf(papers.body);
                return { status: people.status, body: people.body, retrieved: [], ok, detail: `${q} papers=${totalOf(papers.body)} people=${people.body.total_matching_papers}` };
            },
        });
    }

    for (const q of ['Cow Dung for curing cancer', 'cow dung cancer', 'aaa bbb ccc']) {
        cases.push({
            id: `admission-${q}`,
            kind: 'admission_empty',
            run: async () => {
                const papers = await post('/search', { query: q, mode: 'advanced', per_page: 10, filters: {} });
                const people = await get('/search/faculty-for-query', { query: q, mode: 'advanced' });
                const ok = papers.status === 200 && totalOf(papers.body) === 0 && people.status === 200 && people.body.total_matching_papers === 0;
                return { status: papers.status, body: papers.body, retrieved: idsOf(papers.body), ok, detail: q };
            },
        });
    }

    for (const d of ipTitle) {
        cases.push({
            id: `ip_title-${d.id}`,
            kind: 'ip_exact_title',
            relevant: { [d.id]: 3 },
            run: async () => {
                const { status, body } = await post('/ip/search', { query: d.title, mode: 'basic', per_page: 10, filters: {} });
                return { status, body, retrieved: idsOf(body), ok: status === 200 && hasId(body, d.id), detail: d.title };
            },
        });
    }

    for (const d of ipFac.slice(0, 4)) {
        const inventorId = d.expert_id || d.inventor_kerberos;
        cases.push({
            id: `ip_inventor-${inventorId}`,
            kind: 'ip_inventor_scope',
            relevant: { [d.id]: 3 },
            run: async () => {
                const { status, body } = await post('/ip/search/inventor-scope', {
                    query: d.title, inventor_id: inventorId, mode: 'basic', per_page: 10,
                });
                const ok = status === 200 && (hasId(body, d.id) || (body.inventor?.total_patents ?? 0) >= 1);
                return { status, body, retrieved: idsOf(body), ok, detail: d.title };
            },
        });
        cases.push({
            id: `ip_inventor_ungrounded-${inventorId}`,
            kind: 'ip_inventor_ungrounded',
            run: async () => {
                const { status, body } = await post('/ip/search/inventor-scope', {
                    query: 'qwxzjkvbnm', inventor_id: inventorId, mode: 'advanced', per_page: 10,
                    refine_chain: [d.title_terms.slice(0, 2).join(' ')],
                });
                return { status, body, retrieved: idsOf(body), ok: status === 200 && totalOf(body) === 0, detail: inventorId };
            },
        });
    }

    for (const q of ipTitle.slice(0, 4).map((d) => d.title_terms.slice(0, 2).join(' ')).filter(Boolean)) {
        cases.push({
            id: `ip_people-${q}`,
            kind: 'ip_people_total_match',
            run: async () => {
                const ips = await post('/ip/search', { query: q, mode: 'advanced', per_page: 5, filters: {} });
                const people = await get('/ip/faculty-for-query', { query: q, mode: 'advanced' });
                const ok = ips.status === 200 && people.status === 200 && people.body.total_matching_ip === totalOf(ips.body);
                return { status: people.status, body: people.body, retrieved: [], ok, detail: `${q} list=${totalOf(ips.body)} people=${people.body.total_matching_ip}` };
            },
        });
    }

    cases.push({
        id: 'ip-admission-cow-dung',
        kind: 'ip_admission_empty',
        run: async () => {
            const { status, body } = await post('/ip/search', { query: 'Cow Dung for curing cancer', mode: 'advanced', per_page: 10, filters: {} });
            return { status, body, retrieved: idsOf(body), ok: status === 200 && totalOf(body) === 0, detail: 'cow dung' };
        },
    });

    return cases;
}

async function main() {
    const health = await fetch(`${ROOT_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) throw new Error(`API down at ${ROOT_BASE}`);

    console.log('Sampling a fresh stratified batch from Mongo…');
    const batch = await fetchBatch();
    await writeFile(OUT_BATCH, JSON.stringify(batch, null, 2) + '\n');
    console.log(`  papers=${batch.docs.length} fields=${batch.fields.length} ip=${batch.ip.length}`);

    const cases = buildCases(batch);
    console.log(`Running ${cases.length} constructed cases against ${API_BASE}\n`);

    const rows = [];
    for (const c of cases) {
        try {
            const r = await c.run();
            const metrics = c.relevant ? computeAll(r.retrieved || [], c.relevant) : null;
            const ok = r.ok && (metrics ? metrics.recall_50 === 1 : true);
            rows.push({
                id: c.id,
                kind: c.kind,
                ok,
                status: r.status,
                detail: r.detail,
                recall_50: metrics?.recall_50 ?? null,
                precision_1: metrics?.precision_1 ?? null,
                mrr: metrics?.mrr ?? null,
            });
            if (!ok) console.log(`  FAIL ${c.kind}  ${c.id}  ${r.detail || ''}`);
        } catch (err) {
            rows.push({ id: c.id, kind: c.kind, ok: false, status: 0, detail: err.message, recall_50: null, precision_1: null, mrr: null });
            console.log(`  ERR  ${c.kind}  ${c.id}  ${err.message}`);
        }
    }

    const byKind = {};
    for (const r of rows) {
        if (!byKind[r.kind]) byKind[r.kind] = { n: 0, pass: 0, recall: [], p1: [], mrr: [] };
        byKind[r.kind].n += 1;
        if (r.ok) byKind[r.kind].pass += 1;
        if (r.recall_50 != null) byKind[r.kind].recall.push(r.recall_50);
        if (r.precision_1 != null) byKind[r.kind].p1.push(r.precision_1);
        if (r.mrr != null) byKind[r.kind].mrr.push(r.mrr);
    }

    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    console.log('\nKind                              N  pass   R@50    P@1     MRR');
    console.log('─'.repeat(70));
    for (const [kind, s] of Object.entries(byKind)) {
        const fmt = (v) => (v == null ? '   —  ' : v.toFixed(3).padStart(6));
        console.log(
            `${kind.padEnd(32)} ${String(s.n).padStart(3)} ${String(s.pass).padStart(4)}  ${fmt(avg(s.recall))} ${fmt(avg(s.p1))} ${fmt(avg(s.mrr))}`
        );
    }

    const passed = rows.filter((r) => r.ok).length;
    const report = {
        fetched_at: batch.fetched_at,
        api: API_BASE,
        batch: { papers: batch.docs.length, ip: batch.ip.length, fields: batch.fields },
        totals: { cases: rows.length, passed, failed: rows.length - passed },
        byKind: Object.fromEntries(Object.entries(byKind).map(([k, s]) => [k, {
            n: s.n, pass: s.pass,
            recall_50: avg(s.recall), precision_1: avg(s.p1), mrr: avg(s.mrr),
        }])),
        failures: rows.filter((r) => !r.ok),
    };
    await writeFile(OUT_REPORT, JSON.stringify(report, null, 2) + '\n');
    console.log(`\n${passed}/${rows.length} passed`);
    process.exit(passed === rows.length ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
