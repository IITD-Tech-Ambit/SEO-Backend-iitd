import grpc from '@grpc/grpc-js';
import fastJson from 'fast-json-stringify';
import { searchResponseSchema, authorScopedSearchResponseSchema } from '../../schemas/search.js';
import { ipSearchResponseSchema } from '../../schemas/ipSearch.js';

/**
 * search.v1.SearchService handlers — thin adapters over SearchService /
 * DocumentService / SuggestService / IpSearchService / IpSuggestService.
 * No search/OpenSearch logic lives here; each handler maps proto <-> the
 * existing service call and shapes the response so the gateway can reproduce
 * the byte-identical REST body.
 *
 * Fidelity rules (see search.proto): document-bearing / polymorphic payloads travel
 * as `*_json` strings holding exactly the REST JSON fragment named by the field
 * (e.g. `document_json` = the document object, `body_json` = the whole REST body),
 * so the gateway splices them verbatim. Deterministic payloads (suggest,
 * faculty-for-query, collaborators, ip suggest) are mapped to typed fields.
 *
 * `body_json` is produced with the SAME fast-json-stringify response schemas the
 * REST routes use, so the string is byte-identical to the live HTTP body: the
 * schema strips service-internal keys (e.g. `cacheHit`) and result-doc fields the
 * REST serializer already drops. Reusing the schema keeps the two planes in lockstep.
 */
const serializeSearchBody = fastJson(searchResponseSchema);
const serializeAuthorScopeBody = fastJson(authorScopedSearchResponseSchema);
const serializeIpSearchBody = fastJson(ipSearchResponseSchema);

// proto3 defaults hand us 0 / '' for unset scalars; the REST layer relies on
// Fastify schema defaults, so normalize the same way before calling services.
function mapSearchFilters(f) {
    if (!f) return undefined;
    const out = {};
    if (f.year_from) out.year_from = f.year_from;
    if (f.year_to) out.year_to = f.year_to;
    if (f.field_associated) out.field_associated = f.field_associated;
    if (f.document_type) out.document_type = f.document_type;
    if (f.document_types && f.document_types.length) out.document_types = f.document_types;
    if (f.subject_area && f.subject_area.length) out.subject_area = f.subject_area;
    if (f.author_id) out.author_id = f.author_id;
    if (f.first_author_only) out.first_author_only = true;
    if (f.interdisciplinary) out.interdisciplinary = true;
    if (f.kerberos) out.kerberos = f.kerberos;
    return Object.keys(out).length ? out : undefined;
}

function mapIpSearchFilters(f) {
    if (!f) return undefined;
    const out = {};
    if (f.year_from) out.year_from = f.year_from;
    if (f.year_to) out.year_to = f.year_to;
    if (f.type_of_ip) out.type_of_ip = f.type_of_ip;
    if (f.type_of_ip_list && f.type_of_ip_list.length) out.type_of_ip_list = f.type_of_ip_list;
    if (f.field_of_invention) out.field_of_invention = f.field_of_invention;
    if (f.classification && f.classification.length) out.classification = f.classification;
    if (f.department) out.department = f.department;
    if (f.country) out.country = f.country;
    if (f.kerberos) out.kerberos = f.kerberos;
    if (f.primary_inventor_only) out.primary_inventor_only = true;
    return Object.keys(out).length ? out : undefined;
}

export function createSearchServiceHandlers({
    searchService,
    documentService,
    suggestService,
    ipSearchService,
    ipSuggestService,
    logger
}) {
    return {
        // POST /api/v1/search — full REST body returned opaque (results are raw
        // hydrated Mongo docs; facet values polymorphic; status keys conditional).
        async Search(call, callback) {
            const startTime = Date.now();
            const req = call.request;
            if (!req.query) {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'query is required' });
            }
            try {
                const result = await searchService.search({
                    query: req.query,
                    filters: mapSearchFilters(req.filters),
                    sort: req.sort || 'relevance',
                    page: req.page || 1,
                    per_page: req.per_page || 20,
                    search_in: req.search_in && req.search_in.length ? req.search_in : null,
                    mode: req.mode || 'advanced',
                    refine_within: req.refine_within || null,
                    refine_chain: req.refine_chain && req.refine_chain.length ? req.refine_chain : null,
                    // optional bool: honour explicit presence, else server default
                    rerank: req._rerank !== undefined ? req.rerank : null
                });
                const body = { ...result, meta: { took_ms: Date.now() - startTime, cache_hit: result.cacheHit } };
                callback(null, { body_json: serializeSearchBody(body) });
            } catch (error) {
                logger.error({ err: error, query: req.query }, 'gRPC Search failed');
                callback({ code: grpc.status.INTERNAL, message: 'search failed' });
            }
        },

        // POST /api/v1/search/author-scope — same opaque body contract as Search.
        async SearchAuthorScope(call, callback) {
            const startTime = Date.now();
            const req = call.request;
            if (!req.query || !req.author_id) {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'query and author_id are required' });
            }
            try {
                const result = await searchService.authorScopedSearch({
                    query: req.query,
                    author_id: req.author_id,
                    page: req.page || 1,
                    per_page: req.per_page || 20,
                    mode: req.mode || 'advanced',
                    refine_within: req.refine_within || null,
                    refine_chain: req.refine_chain && req.refine_chain.length ? req.refine_chain : null,
                    search_in: req.search_in && req.search_in.length ? req.search_in : null,
                    filters: mapSearchFilters(req.filters)
                });
                const body = { ...result, meta: { took_ms: Date.now() - startTime, cache_hit: result.cacheHit } };
                callback(null, { body_json: serializeAuthorScopeBody(body) });
            } catch (error) {
                logger.error({ err: error, query: req.query, author_id: req.author_id }, 'gRPC SearchAuthorScope failed');
                callback({ code: grpc.status.INTERNAL, message: 'author-scope search failed' });
            }
        },

        // GET /api/v1/suggest — typeahead is deterministic and must never fail the
        // caller, so mirror the controller's degrade-to-empty-groups behaviour.
        async Suggest(call, callback) {
            const req = call.request;
            try {
                const result = await suggestService.suggest(req.q, req.limit);
                callback(null, {
                    intent: result.intent,
                    confidence: result.confidence,
                    groups: {
                        authors: (result.groups?.authors || []).map((a) => ({
                            id: a.id || '',
                            scopus_id: a.scopus_id || '',
                            name: a.name || '',
                            department: a.department || '',
                            image_url: a.image_url || '',
                            score: a.score || 0
                        })),
                        papers: (result.groups?.papers || []).map((p) => ({
                            id: p.id || '',
                            title: p.title || '',
                            year: p.year || 0,
                            lead_author: p.lead_author || '',
                            score: p.score || 0
                        }))
                    },
                    meta: { took_ms: result.tookMs || 0, cache_hit: Boolean(result.cacheHit) }
                });
            } catch (error) {
                logger.error({ err: error, q: req.q }, 'gRPC Suggest failed');
                callback(null, {
                    intent: 'mixed',
                    confidence: 0,
                    groups: { authors: [], papers: [] },
                    meta: { took_ms: 0, cache_hit: false }
                });
            }
        },

        // GET /api/v1/search/faculty-for-query — wire contract preserved verbatim
        // (unchanged from the original single-RPC server; do not regress).
        async FacultyForQuery(call, callback) {
            const { query, mode, search_in: searchIn } = call.request;
            if (!query) {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'query is required' });
            }
            const started = Date.now();
            try {
                const result = await searchService.getAllFacultyForQuery(
                    query,
                    mode || 'advanced',
                    searchIn && searchIn.length ? searchIn : undefined
                );
                callback(null, {
                    departments: (result.departments || []).map((dept) => ({
                        name: dept.name || '',
                        total_paper_count: dept.total_paper_count || 0,
                        faculty: (dept.faculty || []).map((f) => ({
                            name: f.name || '',
                            author_id: f.author_id || '',
                            paper_count: f.paper_count || 0,
                            relevance_score: f.relevance_score || 0
                        }))
                    })),
                    total_faculty: result.total_faculty || 0,
                    total_matching_papers: result.total_matching_papers || 0,
                    took_ms: Date.now() - started,
                    cache_hit: Boolean(result.cacheHit)
                });
            } catch (error) {
                logger.error({ err: error, query }, 'gRPC FacultyForQuery failed');
                callback({ code: grpc.status.INTERNAL, message: 'faculty lookup failed' });
            }
        },

        // GET /api/v1/document/:id — REST body is { document }; the raw doc rides in
        // document_json, `found=false` lets the gateway emit the REST 404.
        async GetDocument(call, callback) {
            const { id } = call.request;
            if (!id) {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'id is required' });
            }
            try {
                const document = await documentService.getDocument(id);
                if (!document) {
                    return callback(null, { found: false, document_json: '' });
                }
                callback(null, { found: true, document_json: JSON.stringify(document) });
            } catch (error) {
                logger.error({ err: error, id }, 'gRPC GetDocument failed');
                callback({ code: grpc.status.INTERNAL, message: 'document fetch failed' });
            }
        },

        // GET /api/v1/documents/by-author/:authorId — documents[] are raw Mongo docs
        // (opaque array), pagination is deterministic (typed).
        async GetDocumentsByAuthor(call, callback) {
            const req = call.request;
            if (!req.author_id) {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'author_id is required' });
            }
            try {
                const perPage = Math.min(req.per_page || 20, 100);
                const result = await documentService.getDocumentsByAuthor(req.author_id, {
                    page: req.page || 1,
                    per_page: perPage
                });
                callback(null, {
                    documents_json: JSON.stringify(result.documents || []),
                    pagination: result.pagination
                });
            } catch (error) {
                logger.error({ err: error, author_id: req.author_id }, 'gRPC GetDocumentsByAuthor failed');
                callback({ code: grpc.status.INTERNAL, message: 'author documents fetch failed' });
            }
        },

        // GET /api/v1/document/:id/similar — source block is deterministic (typed),
        // similar[] are hydrated docs + similarity_score (opaque array).
        async GetSimilarDocuments(call, callback) {
            const req = call.request;
            if (!req.id) {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'id is required' });
            }
            try {
                const limit = Math.min(req.limit || 10, 50);
                const result = await documentService.findSimilar(req.id, limit);
                callback(null, {
                    found: true,
                    source_id: result.source?.id || '',
                    source_title: result.source?.title || '',
                    source_subject_areas: result.source?.subject_areas || [],
                    similar_json: JSON.stringify(result.similar || [])
                });
            } catch (error) {
                // Matches the REST 404 (service throws this exact message).
                if (error.message === 'Document not found in search index') {
                    return callback(null, {
                        found: false,
                        source_id: '',
                        source_title: '',
                        source_subject_areas: [],
                        similar_json: ''
                    });
                }
                logger.error({ err: error, id: req.id }, 'gRPC GetSimilarDocuments failed');
                callback({ code: grpc.status.INTERNAL, message: 'similar documents fetch failed' });
            }
        },

        // GET /api/v1/author/:id/collaborators — fully deterministic, typed.
        async GetAuthorCollaborators(call, callback) {
            const { author_id: authorId } = call.request;
            if (!authorId) {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'author_id is required' });
            }
            try {
                const result = await documentService.getCoAuthors(authorId);
                callback(null, {
                    author_id: result.author_id || '',
                    total_papers: result.total_papers || 0,
                    collaborators: (result.collaborators || []).map((c) => ({
                        author_id: c.author_id || '',
                        collaboration_count: c.collaboration_count || 0,
                        name: c.name || ''
                    }))
                });
            } catch (error) {
                logger.error({ err: error, author_id: authorId }, 'gRPC GetAuthorCollaborators failed');
                callback({ code: grpc.status.INTERNAL, message: 'co-authors fetch failed' });
            }
        },

        async IpSuggest(call, callback) {
            const req = call.request;
            try {
                const result = await ipSuggestService.suggest(req.q, req.limit);
                callback(null, {
                    intent: result.intent,
                    confidence: result.confidence,
                    groups: {
                        inventors: (result.groups?.inventors || []).map((inv) => ({
                            id: inv.id || '',
                            name: inv.name || '',
                            is_faculty: Boolean(inv.is_faculty),
                            kerberos: inv.kerberos || '',
                            score: inv.score || 0
                        })),
                        documents: (result.groups?.documents || []).map((doc) => ({
                            id: doc.id || '',
                            title: doc.title || '',
                            year: doc.year || 0,
                            type_of_ip: doc.type_of_ip || '',
                            lead_inventor: doc.lead_inventor || '',
                            score: doc.score || 0
                        }))
                    },
                    meta: { took_ms: result.tookMs || 0, cache_hit: Boolean(result.cacheHit) }
                });
            } catch (error) {
                logger.error({ err: error, q: req.q }, 'gRPC IpSuggest failed');
                callback(null, {
                    intent: 'mixed',
                    confidence: 0,
                    groups: { inventors: [], documents: [] },
                    meta: { took_ms: 0, cache_hit: false }
                });
            }
        },

        async IpSearch(call, callback) {
            const startTime = Date.now();
            const req = call.request;
            if (!req.query) {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'query is required' });
            }
            try {
                const result = await ipSearchService.search({
                    query: req.query,
                    filters: mapIpSearchFilters(req.filters),
                    sort: req.sort || 'relevance',
                    page: req.page || 1,
                    per_page: req.per_page || 20,
                    search_in: req.search_in && req.search_in.length ? req.search_in : null,
                    mode: req.mode || 'advanced',
                    refine_within: req.refine_within || null,
                    refine_chain: req.refine_chain && req.refine_chain.length ? req.refine_chain : null,
                    rerank: req._rerank !== undefined ? req.rerank : null
                });
                const body = { ...result, meta: { took_ms: Date.now() - startTime, cache_hit: result.cacheHit } };
                callback(null, { body_json: serializeIpSearchBody(body) });
            } catch (error) {
                logger.error({ err: error, query: req.query }, 'gRPC IpSearch failed');
                callback({ code: grpc.status.INTERNAL, message: 'ip search failed' });
            }
        },

        async GetIpDocument(call, callback) {
            const { id } = call.request;
            if (!id) {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'id is required' });
            }
            try {
                const document = await ipSearchService.getDocument(id);
                if (!document) {
                    return callback(null, { found: false, document_json: '' });
                }
                callback(null, { found: true, document_json: JSON.stringify(document) });
            } catch (error) {
                logger.error({ err: error, id }, 'gRPC GetIpDocument failed');
                callback({ code: grpc.status.INTERNAL, message: 'ip document fetch failed' });
            }
        }
    };
}
