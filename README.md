![Research Ambit Search API](assets/banner.png)

# Research Ambit Search API

Search and retrieval service for IIT Delhi research papers, faculty, and IP filings. A Fastify process serves HTTP under `/api/v1` and, when enabled, gRPC `search.v1` on the same service objects. Retrieval runs against OpenSearch. Result documents, the faculty roster, and taxonomy browse data come from MongoDB. Redis caches query bodies, query embeddings, and rerank scores.

This repository does not contain an indexer. It expects the OpenSearch indices named below to already exist.

---

## Role

| Surface | What it retrieves |
|---|---|
| Paper search | `ResearchMetaDataScopus` papers on the `research_documents` index |
| Faculty | IITD roster in MongoDB `Faculty`, used to gate author matches, display names, and the people sidebar |
| IP / patents | `IPMetaData` filings on the `ip_documents` index |
| Taxonomy browse | Precomputed theme, domain, and subdomain counts in MongoDB. Not an OpenSearch query |

Index names are configurable: `OPENSEARCH_INDEX` (default `research_documents`), `OPENSEARCH_AUTHORS_INDEX` (default `authors_suggest`), `OPENSEARCH_IP_INDEX` (default `ip_documents`).

---

## Index fields the queries use

This repo does not define index mappings. The fields below are the ones the query builders, filters, and suggest queries actually read.

**Papers (`research_documents`).** `mongo_id`, `embedding` (k-NN), `title` plus `title.exact`, `title.standard`, `title.autocomplete`, `abstract` plus `abstract.standard`, `subject_area` plus `subject_area.keyword` and `subject_area.ngram`, `field_associated` plus `field_associated.keyword` and `field_associated.ngram`, `publication_year`, `document_type`, `citation_count`, `subject_area_count`, `kerberos`, flat `author_ids`, and nested `authors` (`author_id`, `author_name`, `author_name_variants`, `author_position`). Term suggestions also read `title` and `author_names`.

**Author typeahead (`authors_suggest`).** `expert_id`, `scopus_id`, `name`, `department`, `image_url`.

**IP (`ip_documents`).** `mongo_id`, `embedding`, `title` (same subfields as papers), `abstract`, `field_of_invention` plus `.keyword` and `.ngram`, `classification`, `type_of_ip`, `department_name.keyword`, `country`, `publication_year`, flat `inventor_names`, and nested `inventors` (`name`, `kerberos`, `inventor_position`, `is_faculty`).

OpenSearch hits return `mongo_id`, `title`, and `abstract`. The API then loads the Mongo document and keeps that order.

---

## Stored document types

**Paper (`ResearchMetaDataScopus`).** `document_eid`, `document_scopus_id`, `link`, `publication_year`, `document_type`, `citation_count`, `reference_count`, `title`, `abstract`, `field_associated`, `subject_area[]`, `authors[]`, `kerberos`, `iitd_authors[]` (kerberos, faculty, department, `matched_via`), `classification` (one thematic area, one domain, one subdomain, plus display-only `topics`), `open_search_id`.

The search response schema also allows `source` and `source_relationship` as free-form objects on each result (paper search and author-scoped search). The Mongoose model does not declare them. Hydration returns the stored document, so those keys appear only when they are already on the Mongo document. This service does not interpret them.

**IP filing (`IPMetaData`).** `application_number`, `title`, `abstract`, `type_of_ip`, `department`, `field_of_invention`, `classification[]`, `filing_date`, `publication_date`, `publication_year`, `country`, `application_status`, `patent_number`, `grant_date`, `inventors[]` (index 0 is the primary inventor), `applicants[]`, `open_search_id`.

**Faculty.** Directory record keyed by `expert_id`, with `scopus_id[]` and `email`. Kerberos is the email local-part. `dominant_domains` is written by `scripts/taxonomy/populateFacultyDomains.js` and is not computed on the search path.

**Taxonomy.** `ThematicArea` (the model documents nine fixed strategic themes, independent of domains), `Domain`, `Subdomain`, `TaxonomyFacetCounts` (one row per browse configuration), `TaxonomyFacetMembers`, `Department`.

---

## Query path

```
HTTP POST /api/v1/search          gRPC search.v1.Search
        |                                  |
        +---------------- SearchService.search
                         |
                    Redis key search:<hash>
                         | miss
           +-------------+--------------+
           | mode=basic                 | mode=advanced (default)
           | strict BM25                | embed query (Redis embed:<hash>)
           | no fuzziness, no k-NN      | refine_chain -> mongo_id filters
           |                            | BM25 pre-check (0 hits: stop)
           |                            | OpenSearch hybrid or field sort
           +-------------+--------------+
                         |
              hydrate ResearchMetaDataScopus
              keep IITD authors, faculty display names
                         |
              optional cross-encoder rerank (top K, relevance only)
                         |
              facets, related_faculty, suggestions, Redis set
```

`IpSearchService` follows the same shape against `ip_documents`. An empty IP query with filters set is a filter-only browse: no text clause and no embedding call.

### Parse

Fastify validates the body. `search_in` is deduped and sorted. `refine_chain` (max 8 strings) wins over the legacy single `refine_within`. `mode` is `basic` or `advanced`.

Paper `search_in`: `title`, `abstract`, `author`, `subject_area`, `field`. IP `search_in`: `title`, `abstract`, `inventor`, `field_of_invention`, `classification`. When `search_in` is set, each query term must match at least one selected field.

If `search_in` is only `author`, the query is resolved against the in-memory Faculty roster to Scopus author ids and kerberos values. Author-name clauses are nested under `authors` and filtered to that roster, so non-IITD co-authors do not match. Queries longer than six terms skip the identity arms and stay on text BM25.

### Expand

Expansion is lexical, not a learned rewriter.

- Advanced BM25 uses `fuzziness: AUTO`, with `max_expansions` capped at 10.
- A British/American spelling variant (`SpellingVariants`) is added as an alternate `multi_match` when one is known.
- Multi-word queries add phrase-boost tiers on title and abstract (exact phrase, then slop).
- A `title.standard` AND-of-terms clause boosts titles that contain every query term.
- `refine_chain`: each prior term is re-executed as its own hybrid search (same filters, no further chain). The current query is filtered to those `mongo_id`s, so the set narrows to what the earlier step actually returned. If that lookup fails, the code falls back to a literal term clause. Author-only refinement uses the first chain entry as the person and later entries as topic filters.

Basic mode does not fuzz, does not embed, and does not run the fuzzy fallback.

### Execute

The query string is embedded once per advanced request (`EmbeddingService.embedQuery`). Document vectors are read from the index; this process does not write them.

**`sort=relevance` or `sort=normalized`.** OpenSearch `hybrid` query with a BM25 arm and a k-NN arm on `embedding` (`k` 100), sent with `search_pipeline=rrf-hybrid`. Reciprocal rank fusion combines arms by rank. Each arm carries its own filter (the code comments that OpenSearch 2.19's `hybrid` query has no top-level filter). `pagination_depth` is set from `from + size`, clamped to `CANDIDATE_K` and `MAX_RESULT_WINDOW` (default 10000).

A BM25 pre-check runs before hybrid search. It requires a strict match on `title`, `abstract`, `subject_area`, or `field_associated`, or an IITD author-name match. Stopwords are removed first. A query of up to three content terms must match every term; a longer query must match at least three quarters of them, and at least three. Zero hits skip hybrid search, so a query with no lexical overlap does not open k-NN. A query of one or two content terms that fails the strict check but matches with typo fuzziness goes to the fuzzy fallback instead of hybrid. If the primary hybrid itself returns zero hits and no refine chain is active, that fallback requires a fuzzy BM25 match and uses k-NN only as a `should` boost.

k-NN admission is omitted when the query is scoped to one author or inventor on a fresh chain, and when author-only refine-narrow is active. Inside a small personal set, a corpus-sized `k` admits almost the whole set.

**`sort=date` or `sort=citations` (papers).** BM25 and k-NN are a recall `should`, then the hit list is sorted by `publication_year` or `citation_count`. IP `sort=date` sorts by `publication_year` then filing date. IP has no citation or impact sort.

**`sort=impact` (papers only).** Same recall gate inside a `function_score`: `log1p` of `citation_count` (weight 1.2) and a Gaussian on `publication_year` (scale 5 years, decay 0.5, weight 0.8), `score_mode: sum`, `boost_mode: multiply`, `min_score` 0.3.

`config.search.hybridWeights` (0.4 / 0.6) and the adaptive weight tables are not applied by the query builders. Relevance fusion is the `rrf-hybrid` pipeline.

### Shape

Hits are loaded from Mongo by `mongo_id`, in OpenSearch order. Paper authors are reduced to the Faculty roster (Scopus id, with `kerberos` as a fallback). `author_name` is replaced with the Faculty display name. `department` on a paper result is that professor's department, not `field_associated`. IP hits resolve faculty inventors by kerberos.

Facets come from the OpenSearch aggregations on that same request.

Paper facets: `publication_year`, year ranges (2020-present, 2010-2019, 2000-2009, pre-2000), `document_type`, `field_associated.keyword`, `subject_area.keyword`.

IP facets: `publication_year`, `type_of_ip`, `field_of_invention.keyword`, `country`, `classification`, `department_name.keyword`.

Paper filters: `year_from` / `year_to`, `field_associated` (fuzzy match), `document_type` or `document_types`, `subject_area` (keyword terms), `author_id` (nested, or'd with `kerberos` when the Faculty email prefix resolves), `first_author_only` (`authors.author_position` 1), `interdisciplinary` (`subject_area_count` >= 3), `kerberos`.

IP filters: year range, `type_of_ip` / `type_of_ip_list`, `field_of_invention.keyword`, `classification`, `department_name.keyword`, `country`, nested `inventors.kerberos`, `primary_inventor_only` (`inventors.inventor_position` 0).

When the hit count is under 3, or the pre-check finds nothing, a term suggester on `title` and `author_names` (IP: inventor names) fills `suggestions`. That does not re-run the query.

`related_faculty` is derived from the hydrated page, not from a second search.

---

## Ranking

Rerank runs only when all of the following hold: `RERANK_ENABLED` is true (default), the request does not set `rerank: false`, and `sort` is `relevance` or `normalized`. The first `CANDIDATE_K` hits (default 50) are the ranked window. Pages past that window are the first-stage order, still bounded by `max_result_window`.

`RerankService` sends `title\nabstract` truncated to 1200 characters to the cross-encoder. Per-document scores are cached in Redis under `rerank:<RERANK_MODEL_VERSION>:<query hash>:<id>`. The default cache-key version in code is `bge-reranker-base-v1`. `.env.example` sets `RERANK_MODEL_VERSION=ms-marco-minilm-l12-v2`. That variable does not select the model; it only namespaces cached scores. Change it when `RERANK_MODEL_NAME` changes.

Fusion, after min-max normalization:

```
fused = 0.7 * norm(rerank) + 0.3 * norm(first-stage) + 0.3 if the title contains the query
```

`RERANK_FUSION_ALPHA` and `RERANK_LITERAL_TITLE_BONUS` override the two constants. If the reranker times out or errors, the first-stage order is returned with no `rerank_score`. Default rerank timeout is `RERANK_TIMEOUT_MS` (code default 800 ms; `.env.example` sets 15000).

---

## Faculty-scoped and inventor-scoped search

`POST /api/v1/search/author-scope` ranks one author's papers. The author id is resolved through `Faculty` (`expert_id` or `scopus_id`) to the same Scopus-id-or-kerberos filter the people sidebar uses. Basic mode is strict BM25 inside that filter. Advanced mode uses the normalized hybrid query, then pushes the author filter into every arm, including the k-NN filter. A fresh scoped query drops the k-NN arm.

`GET /api/v1/search/faculty-for-query` aggregates matching papers by flat `author_ids`, nested `authors.author_id` (counted with `reverse_nested` so a repeated author id is one paper), and `kerberos`. Buckets are joined to `Faculty` and grouped by the professor's department. It uses the same query builders as `POST /search`.

`POST /api/v1/ip/search/inventor-scope` ranks one faculty inventor's filings. Identity is kerberos on nested `inventors`. These two IP people routes are HTTP only. They are not RPCs on `search.v1.SearchService`.

`GET /api/v1/ip/faculty-for-query` is the IP people sidebar (faculty inventors, `ipCount`). HTTP only.

---

## Other reads

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/suggest` | Prefix search on `authors_suggest` and `research_documents` in parallel. Intent (`author`, `paper`, `mixed`) is a weighted heuristic over a faculty name-token set, name shape, and the top author vs paper scores. In-process LRU plus Redis. |
| `GET` | `/ip/suggest` | Same pattern over nested inventors and `ip_documents`. No separate inventor index. |
| `GET` | `/document/:id` | One paper from Mongo (`_id` or `open_search_id`). |
| `GET` | `/documents/by-author/:authorId` | Papers for one author, Mongo pagination. |
| `GET` | `/document/:id/similar` | Loads that paper's stored `embedding` and runs k-NN, excluding the source id. |
| `GET` | `/author/:id/collaborators` | Nested `authors.author_id` terms aggregation, excluding the subject's Scopus ids. |
| `GET` | `/ip/document/:id` | One IP document from Mongo. |
| `GET` | `/taxonomy/departments` | Departments that have classified papers. |
| `GET` | `/taxonomy/themes` | Thematic areas with rollup counts. Optional `department`. |
| `GET` | `/taxonomy/domains` | Domains. Optional `theme` and `department`. Themes are not parents of domains. |
| `GET` | `/taxonomy/domains/:domainSlug/subdomains` | Subdomains of one domain. |
| `GET` | `/taxonomy/counts` | Paper and faculty counts for one exact configuration. |
| `GET` | `/taxonomy/faculty` | Kerberos ids for a configuration. `recommended_count` is a per-combination cutoff. |
| `GET` | `/taxonomy/faculty/:kerberos/papers` | Live query on papers in that configuration, sorted by year and citations. |

Taxonomy list and count reads use `TaxonomyFacetCounts` / `TaxonomyFacetMembers`. Papers-in-context queries `ResearchMetaDataScopus` on `classification.*` and `iitd_authors.kerberos`.

`GET /health` is process liveness. `GET /api/v1/search/health` and `GET /api/v1/ip/search/health` check OpenSearch cluster status, the embedding client, and Redis.

Prometheus metrics listen on `METRICS_PORT_BASE + NODE_APP_INSTANCE` (default base `9101`), not on the API port.

---

## Embedding service

Separate Python process in `services/embedding`. FastAPI. `python run.py` serves it with uvicorn. The image (`services/embedding/Dockerfile`, Python 3.11) serves it with gunicorn and Uvicorn workers (`WEB_CONCURRENCY`, default 3). Each worker loads its own model copy.

| Setting | Default |
|---|---|
| `MODEL_NAME` | `BAAI/bge-base-en-v1.5` |
| `EMBED_DIM` | 768 |
| `EMBED_BACKEND` | `onnx` (`torch` is the other accepted value) |
| `POOLING` | `cls` (`mean` is accepted) |
| `NORMALIZE` | true (L2) |
| `MAX_LENGTH` | 512 |
| `RERANK_MODEL_NAME` | `BAAI/bge-reranker-base` |
| `RERANK_QUANTIZE` | true (INT8 ONNX) |
| `RERANK_MAX_LENGTH` | 320 |
| `RERANK_MAX_CANDIDATES` | 50 |

It embeds the texts it is sent. Search sends the query string. It does not embed the corpus. If `BACKEND_NODES` is set, the process is a scatter-gather gateway and does not load a local model.

HTTP: `POST /embed`, `POST /rerank`, `GET /health`. Default bind port is 8000 (`PORT`, or `PORT2`).

gRPC `embedding.v1`: `Embed` and `Rerank`. Default `GRPC_PORT` is 50052. Each gunicorn worker binds the next free port in a pool of size `GRPC_PORT_POOL_SIZE` (default `WEB_CONCURRENCY`) so long-lived HTTP/2 connections do not all land on one worker.

The Node client picks a transport with `EMBEDDING_TRANSPORT`:

- `http` (default): `EMBEDDING_SERVICE_URL` (code default `http://localhost:8000`; `.env.example` sets `http://localhost:8001`).
- `grpc`: `embedding.v1` through `ENVOY_GRPC_TARGET` (default `envoy:10000`).

Query embeddings are cached in Redis for `redis.ttl.queryEmbedding` seconds (86400).

---

## gRPC

`search.v1` is served by this process when `GRPC_ENABLED` is true (the default), on `GRPC_BIND_ADDRESS` (default `0.0.0.0:50053`), with insecure credentials. One listener registers both services. A PM2 worker that loses the bind logs a warning and keeps serving HTTP.

`SearchService`: `Search`, `SearchAuthorScope`, `Suggest`, `FacultyForQuery`, `GetDocument`, `GetDocumentsByAuthor`, `GetSimilarDocuments`, `GetAuthorCollaborators`, `IpSuggest`, `IpSearch`, `GetIpDocument`.

`TaxonomyService`: `GetDepartments`, `GetThemes`, `GetDomains`, `GetSubdomains`, `GetCounts`, `GetFaculty`, `GetFacultyPapers`.

Document-bearing responses (`Search`, `SearchAuthorScope`, `IpSearch`, document fetches, similar papers) return JSON strings produced with the same Fastify response schemas as HTTP, so a gateway can splice them unchanged. Suggest, faculty-for-query, collaborators, and taxonomy responses are typed fields.

The proto comments describe Envoy routing the `/search.v1` prefix and a public HTTP prefix of `/search/api/v1`. That routing is not implemented in this repository. `embedding.v1` is served by the Python process, not by the Node listener.

Not on this gRPC surface: `POST /ip/search/inventor-scope`, `GET /ip/faculty-for-query`, and the health routes.

---

## Data stores

| Store | How this process uses it |
|---|---|
| OpenSearch | Client `@opensearch-project/opensearch`. Node `OPENSEARCH_NODE` (code default `http://localhost:9200`; `.env.example` uses `https://localhost:9200`). TLS verification is disabled in the client. Indices listed above. Relevance hybrid search expects a cluster search pipeline named `rrf-hybrid`, created outside this repo. |
| MongoDB | Mongoose, `MONGODB_URI` (default `mongodb://localhost:27017/research_db`). Papers, faculty, departments, IP filings, taxonomy collections. Compose in this repo does not start MongoDB. |
| Redis | `REDIS_URL` (default `redis://localhost:6379`). Search bodies (300 s), query embeddings (86400 s), rerank scores (`RERANK_CACHE_TTL`, default 3600 s), suggest (60 s, plus an in-process LRU), taxonomy rollup reads (`TAXONOMY_CACHE_TTL`, default 3600 s) and papers-in-context (300 s), co-authors (600 s), author-scoped IP results (`IP_AUTHOR_SEARCH_CACHE_TTL`, default 900 s). Cache failures are logged and the request continues. |

`docker-compose.yml` starts a two-node OpenSearch cluster from `opensearchproject/opensearch:latest`, Dashboards from `opensearchproject/opensearch-dashboards:latest`, and `redis:7-alpine`.

---

## Local development

Use the OpenSearch and Redis from this repo's compose file, and a MongoDB you can reset. `MONGODB_URI` and `OPENSEARCH_NODE` on a developer machine must not be the Research Ambit VM. Host ports `27017` and `9200` there are the production stores. This API reads faculty, papers, and IP from whichever database you configure.

## Quick start

### Prerequisites

- Docker, for the OpenSearch cluster and Redis in `docker-compose.yml`
- Node.js 18 or newer (the API image is `node:20-alpine`; CI runs Node 18)
- Python 3.11 for the embedding image
- A MongoDB instance that already holds the collections above

### 1. Configure

```bash
cp .env.example .env
```

Set `OPENSEARCH_PASSWORD` and `MONGODB_URI`. Align ports before starting processes:

- Copied `.env` sets API `PORT=3000`. With no `PORT` set, `src/config/index.js` listens on **3001**. The root `Dockerfile` exposes 3001 and health-checks `http://localhost:3001/health`.
- Copied `.env` sets `EMBEDDING_SERVICE_URL=http://localhost:8001`. `python run.py` listens on **8000** unless `PORT` is set in the embedding process. Either export `PORT=8001` for the embedding process, or point `EMBEDDING_SERVICE_URL` at port 8000.

`EMBEDDING_TRANSPORT=http` matches a local embedding process. `grpc` expects Envoy at `ENVOY_GRPC_TARGET`.

### 2. OpenSearch and Redis

```bash
docker compose up -d
curl -k -u admin:$OPENSEARCH_PASSWORD https://localhost:9200/_cluster/health
```

The first compose file does not start the API or the embedding service, and it does not create indices or the `rrf-hybrid` pipeline.

### 3. Embedding service

```bash
cd services/embedding
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
PORT=8001 python run.py
```

The first standalone start exports `BAAI/bge-base-en-v1.5` and `BAAI/bge-reranker-base` to ONNX under `services/embedding/.cache` if those files are not already there.

### 4. API

```bash
npm install
npm run dev
```

With the copied `.env`, HTTP is `http://localhost:3000`. gRPC listens on `0.0.0.0:50053` unless `GRPC_ENABLED=false`.

Application compose (API plus embedding; requires the network created by the first compose file):

```bash
docker compose -f docker-compose.services.yml up -d
```

That file publishes the API on port 3000 and the embedding HTTP port on 8001, and sets `EMBEDDING_SERVICE_URL=http://embedding:8001`. It does not set `EMBEDDING_TRANSPORT`, so the API default `http` applies.

```bash
curl -X POST http://localhost:3000/api/v1/search \
  -H "Content-Type: application/json" \
  -d '{"query": "carbon nanotubes thermal conductivity", "page": 1, "per_page": 20}'
```

---

## Taxonomy ingest

Explore reads rollup collections. Rebuild them from classification CSVs with:

```bash
npm run taxonomy:ingest
npm run taxonomy:rollup
npm run taxonomy:faculty-domains
```

Dry runs: `taxonomy:ingest:dry`, `taxonomy:faculty-domains:dry`.

---

## Testing

CI (`.github/workflows/ci.yml`) runs `node --test tests/unit/*.test.mjs` on Node 18. That suite is mocked.

`npm test` also runs regression, performance, author-scope, integration, and corpus retrieval tests. Those need live OpenSearch, MongoDB, and Redis.

---

## Layout

```
SEO-Backend-iitd/
├── src/                  # Fastify API, search/ipSearch/taxonomy services, gRPC server
├── protos/               # search.v1, embedding.v1, plus auth, directory, and chat protos
├── services/embedding/   # BGE embed + cross-encoder rerank (HTTP and embedding.v1)
├── scripts/taxonomy/     # Ingest, rollup, faculty dominant-domains
├── tests/
├── docker-compose.yml    # OpenSearch (two nodes) + Redis
└── Dockerfile            # API image, node:20, PM2, ports 3001 and 50053
```
