import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import {
    searchRequestSchema,
    authorScopedSearchRequestSchema,
    facultyForQueryRequestSchema,
    facultyForQueryResponseSchema,
    errorResponseSchema,
    parseFacultyForQueryFilters
} from '../../src/schemas/search.js';
import {
    ipSearchRequestSchema,
    inventorScopedSearchRequestSchema,
    ipFacultyForQueryRequestSchema,
    ipFacultyForQueryResponseSchema,
    errorResponseSchema as ipErrorResponseSchema,
    parseIpFacultyForQueryFilters
} from '../../src/schemas/ipSearch.js';
import { getAllFacultyForQuery } from '../../src/controllers/searchController.js';
import { getAllFacultyForQuery as getAllIpFacultyForQuery } from '../../src/controllers/ipSearchController.js';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

/**
 * Every key a FilterBuilder actually consults, read straight from its source so this contract
 * keeps holding as filters are added without anyone having to update a hand-written list.
 * The lookbehind keeps `mustFilters.push` / `scopeFilters.push` out of the match.
 */
function builderFilterKeys(rel) {
    const keys = new Set();
    for (const [, key] of repoFile(rel).matchAll(/(?<![\w$])filters\??\.([A-Za-z_$][\w$]*)/g)) {
        keys.add(key);
    }
    return keys;
}

/** Keys the service injects itself after route validation; never part of the client contract. */
const isInternalKey = (key) => key.startsWith('_');

const STACKS = [
    {
        name: 'paper',
        builder: 'src/services/search/FilterBuilder.js',
        schema: searchRequestSchema,
        base: { query: 'machine learning' }
    },
    {
        name: 'ip',
        builder: 'src/services/ipSearch/FilterBuilder.js',
        schema: ipSearchRequestSchema,
        base: { query: 'graphene' }
    }
];

const CLOSED_FILTER_SCHEMAS = [
    { name: 'POST /search', schema: searchRequestSchema, base: { query: 'machine learning' } },
    { name: 'POST /search/author-scope', schema: authorScopedSearchRequestSchema, base: { query: 'machine learning', author_id: '7005' } },
    { name: 'POST /ip/search', schema: ipSearchRequestSchema, base: { query: 'graphene' } },
    { name: 'POST /ip/search/inventor-scope', schema: inventorScopedSearchRequestSchema, base: { query: 'graphene', inventor_id: 'jdoe' } }
];

function sampleFor(propSchema) {
    if (propSchema.enum) return propSchema.enum[0];
    switch (propSchema.type) {
        case 'integer':
        case 'number':
            return propSchema.minimum ?? 1;
        case 'boolean':
            return true;
        case 'array':
            return [sampleFor(propSchema.items)];
        case 'object':
            return Object.fromEntries(
                Object.entries(propSchema.properties ?? {}).map(([k, v]) => [k, sampleFor(v)])
            );
        default:
            return 'x';
    }
}

/**
 * Mirrors `src/app.js`'s error handler. Without it a rejection is reported by Fastify's default
 * shape, which drops `error.validation` — and `details` is the only place the offending property
 * name appears, so tests would be asserting on strictly less than clients receive.
 */
const withAppErrorHandler = (app) => {
    app.setErrorHandler((error, request, reply) => {
        if (error.validation) {
            return reply.status(400).send({
                error: 'Validation Error',
                message: error.message,
                details: error.validation,
                statusCode: 400
            });
        }
        throw error;
    });
    return app;
};

/** Validation-only harness: exercises the real schema without touching services or a port. */
async function validate(bodySchema, payload) {
    const app = withAppErrorHandler(Fastify({ logger: false }));
    app.post('/x', { schema: { body: bodySchema } }, async (request) => ({ body: request.body }));
    const res = await app.inject({ method: 'POST', url: '/x', payload });
    await app.close();
    return { statusCode: res.statusCode, body: res.json() };
}

for (const stack of STACKS) {
    test(`${stack.name}: schema declares every filter key its FilterBuilder reads`, () => {
        const declared = new Set(Object.keys(stack.schema.properties.filters.properties));
        const consumed = [...builderFilterKeys(stack.builder)].filter((k) => !isInternalKey(k));

        assert.ok(consumed.length > 0, 'regex found no filter keys — the builder source moved');
        const missing = consumed.filter((k) => !declared.has(k));
        assert.deepEqual(missing, [], `filters supported by the builder but absent from the schema would now 400: ${missing.join(', ')}`);
    });

    test(`${stack.name}: server-injected filter keys stay out of the request contract`, () => {
        const declared = Object.keys(stack.schema.properties.filters.properties);
        assert.deepEqual(declared.filter(isInternalKey), []);
    });

    test(`${stack.name}: every declared filter key is accepted and survives validation`, async () => {
        const properties = stack.schema.properties.filters.properties;
        const filters = Object.fromEntries(
            Object.entries(properties).map(([key, propSchema]) => [key, sampleFor(propSchema)])
        );

        const { statusCode, body } = await validate(stack.schema, { ...stack.base, filters });
        assert.equal(statusCode, 200);
        assert.deepEqual(Object.keys(body.body.filters).sort(), Object.keys(properties).sort());
    });
}

for (const { name, schema, base } of CLOSED_FILTER_SCHEMAS) {
    test(`${name}: propertyNames allow-list matches the declared filter properties`, () => {
        const filters = schema.properties.filters;
        assert.deepEqual(filters.propertyNames?.enum, Object.keys(filters.properties));
    });

    test(`${name}: unsupported filter key is rejected, not silently dropped`, async () => {
        const { statusCode, body } = await validate(schema, {
            ...base,
            filters: { department_typo: 'Physics Department' }
        });

        assert.equal(statusCode, 400, 'an unsupported filter key must fail loudly');
        assert.match(body.message, /filters/);
    });
}

// The originally reported payload. Both keys are unsupported on the paper stack (`department`
// is an IP-only filter), and under Fastify's removeAdditional:true default this returned 200
// with a total identical to an unfiltered search.
test('POST /search: reported silent-failure payload now fails validation', async () => {
    const { statusCode } = await validate(searchRequestSchema, {
        query: 'machine learning',
        filters: { department: 'Physics Department', year: 2020 }
    });
    assert.equal(statusCode, 400);
});

test('inventor-scope declares no filter the main IP endpoint lacks', () => {
    const main = new Set(Object.keys(ipSearchRequestSchema.properties.filters.properties));
    const scoped = Object.keys(inventorScopedSearchRequestSchema.properties.filters.properties);
    assert.deepEqual(scoped.filter((k) => !main.has(k)), []);
});

test('author-scope declares no filter the main paper endpoint lacks', () => {
    const main = new Set(Object.keys(searchRequestSchema.properties.filters.properties));
    const scoped = Object.keys(authorScopedSearchRequestSchema.properties.filters.properties);
    assert.deepEqual(scoped.filter((k) => !main.has(k)), []);
});

// ---------------------------------------------------------------------------
// faculty-for-query: filters arrive JSON-encoded inside a string, so no JSON Schema keyword
// can see the keys. An unsupported key used to be dropped by FilterBuilder in silence while
// the same key on POST /search returned 400 — the People sidebar and the papers list disagreed
// without telling anyone. The check now lives in the controller, keyed off the POST schema.
// ---------------------------------------------------------------------------

const ENCODED_FILTER_STACKS = [
    {
        name: 'faculty-for-query',
        parse: parseFacultyForQueryFilters,
        allowFrom: searchRequestSchema.properties.filters,
        valid: { year_from: 2020, document_type: 'Article' },
        // search/FilterBuilder reads this, but SearchService injects it AFTER route validation
        // (resolved from Faculty.email), so it is deliberately absent from the schema and must
        // stay un-settable by a client through the encoded form too.
        internal: '_authorKerberos'
    },
    {
        name: 'ip/faculty-for-query',
        parse: parseIpFacultyForQueryFilters,
        allowFrom: ipSearchRequestSchema.properties.filters,
        valid: { department: 'Physics Department', primary_inventor_only: true },
        // ipSearch/FilterBuilder has no injected key today; this pins the underscore convention
        // so adding one cannot accidentally arrive from the client side first.
        internal: '_inventorKerberos'
    }
];

/** The 400 body an unsupported/malformed encoded filter should produce. */
function captureValidationError(fn) {
    try {
        fn();
    } catch (error) {
        return error;
    }
    return null;
}

for (const stack of ENCODED_FILTER_STACKS) {
    const allowed = Object.keys(stack.allowFrom.properties);

    test(`${stack.name}: encoded-filter allow-list is the POST endpoint's filter properties`, () => {
        // Drift guard: the list is derived, never hand-copied, so adding a filter to the POST
        // schema opens it on the sidebar in the same commit.
        const error = captureValidationError(() => stack.parse('{"definitely_not_a_filter":1}'));
        assert.deepEqual(error.validation[0].params.allowedValues, allowed);
    });

    test(`${stack.name}: unsupported key inside the JSON string is rejected and named`, () => {
        const error = captureValidationError(() => stack.parse('{"department_typo":"Physics"}'));

        assert.ok(error, 'an unsupported encoded filter key must fail loudly');
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /department_typo/, 'the error must name the offending key');
        for (const key of allowed) {
            assert.match(error.message, new RegExp(key), `the error must list the allowed key ${key}`);
        }
        // Same ajv shape POST /search emits for the object form, so clients parse one contract.
        assert.equal(error.validation[0].keyword, 'enum');
        assert.equal(error.validation[0].propertyName, 'department_typo');
        assert.equal(error.validation[0].schemaPath, '#/properties/filters/propertyNames/enum');
        assert.equal(error.validation[1].keyword, 'propertyNames');
        assert.deepEqual(error.validation[1].params, { propertyName: 'department_typo' });
    });

    test(`${stack.name}: every supported key is still accepted inside the JSON string`, () => {
        const filters = Object.fromEntries(
            Object.entries(stack.allowFrom.properties).map(([key, propSchema]) => [key, sampleFor(propSchema)])
        );
        assert.deepEqual(stack.parse(JSON.stringify(filters)), filters);
        assert.deepEqual(stack.parse(JSON.stringify(stack.valid)), stack.valid);
    });

    test(`${stack.name}: malformed JSON is a clean 400, not a 500`, () => {
        for (const raw of ['{not json', '{"year_from":', '%7Bbroken']) {
            const error = captureValidationError(() => stack.parse(raw));
            assert.ok(error, `malformed filters (${raw}) must be rejected`);
            assert.equal(error.statusCode, 400);
            assert.ok(Array.isArray(error.validation), 'must carry ajv-shaped details so app.js answers 400');
            assert.match(error.message, /JSON-encoded object/);
        }
    });

    test(`${stack.name}: valid JSON that is not an object is a 400, not a silent no-op`, () => {
        // These all reached FilterBuilder before and every `filters?.key` lookup returned
        // undefined, so the request ran completely unfiltered and still returned 200.
        for (const raw of ['5', '"year_from"', '[{"year_from":2020}]', 'null']) {
            const error = captureValidationError(() => stack.parse(raw));
            assert.ok(error, `non-object filters (${raw}) must be rejected`);
            assert.equal(error.statusCode, 400);
        }
    });

    test(`${stack.name}: absent or blank filters stay absent`, () => {
        for (const raw of [undefined, null, '', '   ']) {
            assert.equal(stack.parse(raw), null);
        }
    });

    test(`${stack.name}: server-injected internal keys are not client-settable`, () => {
        const error = captureValidationError(() => stack.parse(JSON.stringify({ [stack.internal]: 'abc' })));
        assert.ok(error, `${stack.internal} must not be accepted from a client`);
        assert.equal(error.statusCode, 400);
        assert.match(error.message, new RegExp(stack.internal));
    });
}

/**
 * The paper sidebar wired the way `src/routes/search.js` wires it — real querystring schema,
 * real controller, real 400 response schema — with the error handler from `src/app.js`.
 * This is what proves the controller actually calls the check AND that `details` survives
 * response serialization (it is dropped unless `errorResponseSchema` declares it).
 */
async function facultyForQueryApp() {
    const app = Fastify({ logger: false });
    app.setErrorHandler((error, request, reply) => {
        if (error.validation) {
            return reply.status(400).send({
                error: 'Validation Error',
                message: error.message,
                details: error.validation,
                statusCode: 400
            });
        }
        throw error;
    });

    const calls = [];
    const searchService = {
        async getAllFacultyForQuery(query, mode, searchIn, refineWithin, filters, refineChain) {
            calls.push({ query, mode, searchIn, refineWithin, filters, refineChain });
            return { departments: [], total_faculty: 0, total_matching_papers: 0, cacheHit: false };
        }
    };

    app.get('/search/faculty-for-query', {
        schema: {
            querystring: facultyForQueryRequestSchema,
            response: { 200: facultyForQueryResponseSchema, 400: errorResponseSchema, 500: errorResponseSchema }
        },
        handler: (request, reply) => getAllFacultyForQuery(request, reply, searchService)
    });

    return { app, calls };
}

/**
 * The IP twin of `facultyForQueryApp`. The IP stack has its OWN controller rather than sharing
 * searchController, so wiring the parser into one says nothing about the other — this endpoint
 * was still returning 200 for an unsupported key after the paper side was closed.
 */
async function ipFacultyForQueryApp() {
    const app = Fastify({ logger: false });
    app.setErrorHandler((error, request, reply) => {
        if (error.validation) {
            return reply.status(400).send({
                error: 'Validation Error',
                message: error.message,
                details: error.validation,
                statusCode: 400
            });
        }
        throw error;
    });

    const calls = [];
    const ipSearchService = {
        async getAllFacultyForQuery(query, mode, searchIn, filters, refineChain) {
            calls.push({ query, mode, searchIn, filters, refineChain });
            return { departments: [], total_faculty: 0, total_matching_ip: 0, cacheHit: false };
        }
    };

    app.get('/ip/faculty-for-query', {
        schema: {
            querystring: ipFacultyForQueryRequestSchema,
            response: { 200: ipFacultyForQueryResponseSchema, 400: ipErrorResponseSchema, 500: ipErrorResponseSchema }
        },
        handler: (request, reply) => getAllIpFacultyForQuery(request, reply, ipSearchService)
    });

    return { app, calls };
}

test('GET /ip/faculty-for-query: unsupported encoded filter key returns a 400 naming the key', async () => {
    const { app, calls } = await ipFacultyForQueryApp();
    const res = await app.inject({
        method: 'GET',
        url: '/ip/faculty-for-query?query=solar&mode=basic&filters=' + encodeURIComponent('{"bogus":1}')
    });
    await app.close();

    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.match(body.message, /bogus/);
    assert.ok(body.details, 'details must survive response serialization');
    assert.equal(body.details[0].propertyName, 'bogus');
    assert.deepEqual(
        body.details[0].params.allowedValues,
        Object.keys(ipSearchRequestSchema.properties.filters.properties)
    );
    assert.deepEqual(calls, [], 'a rejected request must never reach the IP search service');
});

test('GET /ip/faculty-for-query: a valid encoded filter still reaches the service intact', async () => {
    const { app, calls } = await ipFacultyForQueryApp();
    const res = await app.inject({
        method: 'GET',
        url: '/ip/faculty-for-query?query=solar&mode=basic&filters=' + encodeURIComponent('{"country":"IN"}')
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].filters, { country: 'IN' });
});

test('GET /ip/faculty-for-query: malformed JSON in filters is a 400, not a 500 or a silent unfiltered 200', async () => {
    const { app, calls } = await ipFacultyForQueryApp();
    const res = await app.inject({
        method: 'GET',
        url: '/ip/faculty-for-query?query=solar&mode=basic&filters=' + encodeURIComponent('{not-json')
    });
    await app.close();

    assert.equal(res.statusCode, 400);
    assert.deepEqual(calls, [], 'a malformed filter must not reach the IP search service');
});

test('GET /search/faculty-for-query: unsupported encoded filter key returns a 400 naming the key', async () => {
    const { app, calls } = await facultyForQueryApp();
    const res = await app.inject({
        method: 'GET',
        url: '/search/faculty-for-query?query=quantum&mode=basic&filters=' + encodeURIComponent('{"bogus":1}')
    });
    await app.close();

    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.match(body.message, /bogus/);
    assert.ok(body.details, 'details must survive response serialization');
    assert.equal(body.details[0].propertyName, 'bogus');
    assert.deepEqual(
        body.details[0].params.allowedValues,
        Object.keys(searchRequestSchema.properties.filters.properties)
    );
    assert.deepEqual(calls, [], 'a rejected request must never reach the search service');
});

test('GET /search/faculty-for-query: a valid encoded filter still reaches the service intact', async () => {
    const { app, calls } = await facultyForQueryApp();
    const res = await app.inject({
        method: 'GET',
        url: '/search/faculty-for-query?query=quantum&mode=basic&search_in=title,abstract'
            + '&refine_chain=' + encodeURIComponent('["optics"]')
            + '&filters=' + encodeURIComponent('{"year_from":2020,"document_type":"Article"}')
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].filters, { year_from: 2020, document_type: 'Article' });
    assert.deepEqual(calls[0].searchIn, ['title', 'abstract']);
    assert.deepEqual(calls[0].refineChain, ['optics']);
});

test('GET /search/faculty-for-query: malformed encoded filters return 400, not 500', async () => {
    const { app, calls } = await facultyForQueryApp();
    const res = await app.inject({
        method: 'GET',
        url: '/search/faculty-for-query?query=quantum&filters=' + encodeURIComponent('{not json')
    });
    await app.close();

    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /JSON-encoded object/);
    assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Top-level `additionalProperties: false` was the same no-op one level up: POST /search with
// {"query":"x","fitlers":{...}} had `fitlers` stripped and returned 200 over the whole
// unfiltered corpus. propertyNames closes it.
// ---------------------------------------------------------------------------

const CLOSED_REQUEST_SCHEMAS = [
    { name: 'POST /search', schema: searchRequestSchema, base: { query: 'machine learning' } },
    { name: 'POST /search/author-scope', schema: authorScopedSearchRequestSchema, base: { query: 'machine learning', author_id: '7005' } },
    { name: 'POST /ip/search', schema: ipSearchRequestSchema, base: { query: 'graphene' } },
    { name: 'POST /ip/search/inventor-scope', schema: inventorScopedSearchRequestSchema, base: { query: 'graphene', inventor_id: 'jdoe' } },
    { name: 'GET /search/faculty-for-query', schema: facultyForQueryRequestSchema, base: { query: 'graphene' }, querystring: true },
    { name: 'GET /ip/faculty-for-query', schema: ipFacultyForQueryRequestSchema, base: { query: 'graphene' }, querystring: true }
];

/** Validation-only harness for a querystring schema, mirroring `validate` for bodies. */
async function validateQuery(querystringSchema, params) {
    const app = withAppErrorHandler(Fastify({ logger: false }));
    app.get('/x', { schema: { querystring: querystringSchema } }, async (request) => ({ query: request.query }));
    const res = await app.inject({ method: 'GET', url: '/x?' + new URLSearchParams(params).toString() });
    await app.close();
    return { statusCode: res.statusCode, body: res.json() };
}

const check = (entry, payload) =>
    entry.querystring ? validateQuery(entry.schema, payload) : validate(entry.schema, payload);

for (const entry of CLOSED_REQUEST_SCHEMAS) {
    test(`${entry.name}: top-level propertyNames allow-list matches the declared properties`, () => {
        assert.deepEqual(entry.schema.propertyNames?.enum, Object.keys(entry.schema.properties));
    });

    test(`${entry.name}: a typo'd top-level field is rejected, not silently dropped`, async () => {
        const { statusCode, body } = await check(entry, { ...entry.base, fitlers: 'x' });

        assert.equal(statusCode, 400, "a typo'd top-level field must fail loudly");
        assert.ok(
            body.details.some((d) => d.propertyName === 'fitlers' || d.params?.propertyName === 'fitlers'),
            'the rejection must name the offending field'
        );
    });

    test(`${entry.name}: every declared top-level field is still accepted`, async () => {
        const payload = Object.fromEntries(
            Object.entries(entry.schema.properties).map(([key, propSchema]) => [
                key,
                key === 'filters' && entry.querystring ? '{"year_from":2020}' : sampleFor(propSchema)
            ])
        );
        const { statusCode, body } = await check(entry, payload);
        assert.equal(statusCode, 200, `a fully-populated request must validate: ${JSON.stringify(body)}`);
    });
}

/**
 * The top-level lock-down can only break a client that sends an undeclared field, so pin the
 * exact field sets the real clients build. Sources (read at the time of the change):
 *   frontend  tech-ambit-explorer/src/hooks/explore/useExploreSearchState.ts  (searchRequest, authorScopedRequest)
 *             tech-ambit-explorer/src/hooks/explore/useIPExploreState.ts      (searchRequest, inventorScopedRequest)
 *             tech-ambit-explorer/src/lib/api/hooks/useIPSearch.ts            (faculty patents)
 *             tech-ambit-explorer/src/components/PatentTimeline.tsx           (load-more)
 *             tech-ambit-explorer/src/lib/api/services/{search,ipSearch}Service.ts (faculty-for-query params)
 *             plus the optional members of the SearchRequest / IPSearchRequest / *ScopedSearchRequest
 *             interfaces in tech-ambit-explorer/src/lib/api/types.ts
 * The api-gateway is deliberately absent: it forwards these routes over search.v1 gRPC with
 * proto-typed filters (api-gateway/src/routes/searchApi.js -> SearchRequest in
 * protos/search/v1/search.proto), so it never reaches these JSON schemas at all.
 */
const REAL_CLIENT_FIELDS = [
    { name: 'POST /search', schema: searchRequestSchema, fields: ['query', 'page', 'per_page', 'sort', 'filters', 'search_in', 'mode', 'refine_within', 'refine_chain'] },
    { name: 'POST /search/author-scope', schema: authorScopedSearchRequestSchema, fields: ['query', 'author_id', 'page', 'per_page', 'mode', 'refine_within', 'refine_chain', 'search_in', 'filters'] },
    { name: 'POST /ip/search', schema: ipSearchRequestSchema, fields: ['query', 'page', 'per_page', 'sort', 'mode', 'filters', 'search_in', 'refine_within', 'refine_chain', 'rerank'] },
    { name: 'POST /ip/search/inventor-scope', schema: inventorScopedSearchRequestSchema, fields: ['query', 'inventor_id', 'page', 'per_page', 'mode', 'refine_within', 'refine_chain', 'search_in', 'filters'] },
    { name: 'GET /search/faculty-for-query', schema: facultyForQueryRequestSchema, fields: ['query', 'mode', 'search_in', 'refine_within', 'refine_chain', 'filters'] },
    { name: 'GET /ip/faculty-for-query', schema: ipFacultyForQueryRequestSchema, fields: ['query', 'mode', 'search_in', 'refine_chain', 'filters'] }
];

for (const { name, schema, fields } of REAL_CLIENT_FIELDS) {
    test(`${name}: every top-level field the real clients send is still declared`, () => {
        const declared = new Set(Object.keys(schema.properties));
        const undeclared = fields.filter((f) => !declared.has(f));
        assert.deepEqual(undeclared, [], `real clients send fields this schema would now 400: ${undeclared.join(', ')}`);
    });
}

// The frontend's SearchFilters interface still carries `affiliation`, which no FilterBuilder
// reads and no code path sets. Pinned so that if anyone ever starts sending it, this test names
// the reason the request 400s instead of leaving it to be rediscovered from a support ticket.
test('POST /search: the frontend SearchFilters `affiliation` member is intentionally unsupported', async () => {
    assert.ok(!('affiliation' in searchRequestSchema.properties.filters.properties));
    const { statusCode } = await validate(searchRequestSchema, {
        query: 'machine learning',
        filters: { affiliation: 'IIT Delhi' }
    });
    assert.equal(statusCode, 400);
});

test('ip 400 responses can carry ajv details', () => {
    // Without this the IP error serializer drops `details` and a rejected key is unattributable.
    assert.equal(ipErrorResponseSchema.properties.details?.type, 'array');
    assert.equal(errorResponseSchema.properties.details?.type, 'array');
});
