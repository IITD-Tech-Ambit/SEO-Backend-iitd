# Search Retrieval Audit Report

**System:** IIT Delhi Research Ambit — SEO Backend (`SEO-Backend-iitd`)  
**Date:** 2026-07-21  
**API under test:** `http://localhost:3001`  
**Scope:** Research paper search + Patent/IP search (moderate → very hard queries)  
**Method:** Live API probes against OpenSearch + MongoDB ground truth; four parallel test batteries

---

## 1. Executive summary

Advanced hybrid search (BM25 + kNN embeddings, optional rerank) is **production-usable for topical and technical queries** that share some vocabulary with indexed text. It is **weak on pure paraphrases, long conversational questions, free-text person names (research), and patent application-number lookup**.

| Corpus | OpenSearch root docs | Mongo collection | Aligned? |
|--------|---------------------:|------------------|----------|
| Research | 70,298 | `researchmetadatascopus` (70,298) | Yes |
| Patents / IP | 796 | `ipmetadatas` (796) | Yes |

> **Note:** `_cat/indices` `docs.count` (~310k research / ~3.1k IP) is **Lucene nested-document inflation** (authors / inventors), not a Mongo sync gap. Use `_count` for true document totals.

| Area | Moderate | Hard / very hard | Hydration |
|------|----------|------------------|-----------|
| Research | Strong on topics; **author-name FAIL** | ~5 PASS / 3 PARTIAL / 4 FAIL | Near-complete |
| Patents | Strong (9/10 high relevance) | Advanced strong (~12/12 semantic); ID lookup FAIL | 0% broken in samples |

**Health at audit time:** OpenSearch ✅ · Embedding ✅ · Redis ✅ · Cluster status yellow (single-node replica unassigned — availability risk only).

---

## 2. System under test

```
Client → Fastify API → Redis (query / embedding cache)
              ├─ Embedding service (BGE-base + optional cross-encoder rerank)
              ├─ OpenSearch 2.x (BM25 + HNSW kNN)
              └─ MongoDB (result hydration + faculty directory)
```

| Mode | Behavior |
|------|----------|
| `basic` | Strict BM25 only — no fuzziness, no embeddings |
| `advanced` (default) | BM25 pre-check → hybrid BM25 + kNN → optional rerank (`CANDIDATE_K≈50`) |

**Endpoints exercised**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/v1/search` | Research hybrid search |
| `GET` | `/api/v1/suggest` | Research typeahead |
| `POST` | `/api/v1/ip/search` | Patent hybrid search |
| `GET` | `/api/v1/ip/suggest` | Patent typeahead |
| `GET` | `/api/v1/search/health` | Dependency health |

**Relevant config (from env / `src/config`)**

- OpenSearch: `https://10.17.8.24:9200` — indexes `research_documents`, `ip_documents`, `authors_suggest`
- `RELEVANT_MIN_SCORE` ≈ 1.20 (user-facing relevance bar)
- `CANDIDATE_K` = 50, `RERANK_ENABLED` = true
- Hybrid weights: BM25 0.4 / vector 0.6 (adaptive lexical-rich vs semantic regimes exist in `QueryBuilder`)

---

## 3. Audit method

1. Read search/IP services, query builders, hydrators, and config.
2. Verified live connectivity: OpenSearch cluster, MongoDB MCP, local API health.
3. Built ground-truth anchors from Mongo + OpenSearch (known papers/patents).
4. Ran four parallel batteries:
   - Research — moderate
   - Research — hard → very hard
   - Patents — moderate
   - Patents — hard → very hard
5. Cross-checked failure modes against code paths (`_bm25PreCheck`, field lists, hydrator `filter(Boolean)`).

**Pass criteria (hard tests):** known ground-truth document in top-10 (patents); relevance judgment on top-3 titles (research).

---

## 4. Research search findings

### 4.1 Moderate queries

| Query | Approx. total | Verdict |
|-------|--------------:|---------|
| machine learning | 1,443 | PASS |
| graphene oxide | 361 | PASS |
| perovskite solar cell | 165 | PASS |
| wireless sensor network | 239 | PASS |
| protein folding | 1,012 | PASS |
| CO2 capture | 305 | PASS |
| quantum computing | 534 | PASS |
| civil engineering structural health monitoring | 204 | PASS |
| concrete structure vibration | 74 | PARTIAL — concrete/structure strong; vibration weak in top ranks |
| Trilok Singh (faculty from suggest) | 781 | **FAIL** — unrelated papers; faculty not in `related_faculty` |

**Suggest vs search:** `GET /suggest?q=Trilok` correctly resolves the faculty member (intent=author). The same name on `POST /search` does **not** route to author-scoped retrieval.

**Advanced vs basic (sample):** Advanced returns a superset with more topic-core ranking; basic is stricter BM25 and often ranks more applied/indirect matches.

### 4.2 Hard / very hard queries

Summary from 12 designed hard queries: **5 PASS · 3 PARTIAL · 4 FAIL**.

| Pattern | Example behavior | Verdict |
|---------|------------------|---------|
| Multi-concept with domain tokens | MAX-phase / silicone energy harvester | PASS (GT often #1) |
| Chemical formula / niche gases | Zn4O MOF epoxy; He/TFE plasma textile | PASS |
| Typos (`solor`, `perovskkite`) | Advanced recovers; basic often 0 | PARTIAL / mode-dependent |
| Pure synonym paraphrase (no shared keywords) | Coordination-polymer fluorescence rewrite | **FAIL (0 hits)** |
| Long natural-language question (~34 words) | Conversational DBD plasma question | **FAIL (0 hits)** |
| Negation | “without lead halide” | PARTIAL — lead-halide paper still #1 |
| Author + topic as free text | “Roy benzoxazine…” | PARTIAL — topic hits; name not scoped |
| Indirect TENG paraphrase | “friction-induced electrostatic… GaAs” | FAIL until domain anchors (`PTENG`, `tribo-photovoltaic`) added |
| Ambiguous “cell” | lithium-ion battery cell | PASS — not biology |

**Positive diagnostic:** When a zero-hit paraphrase is shortened with 1–2 domain anchors (e.g. `nicotine cotinine fluorescence`), embeddings surface the ground-truth paper at #1 — vectors work when the BM25 gate opens.

### 4.3 Research failure root causes

| Priority | Cause | Evidence |
|----------|-------|----------|
| P0 | **BM25 pre-check gates kNN** — requires ~50% of tokens to match text fields *without fuzziness*; if pre-check = 0, hybrid/kNN never runs | Pure paraphrase & long NL → advanced total = 0 |
| P0 | **Person-name queries not routed to author scope** | Suggest finds faculty; `/search` treats “Singh” as free text |
| P1 | Strict per-term BM25 in hybrid (all / 75% terms) | Long multi-concept queries need lexical luck to enter hybrid |
| P1 | No negation / intent rewrite | Exclusion words ignored |
| P2 | Soft relevance bar + kNN widen pool | Focused paraphrases still report 2k–4k totals |
| P2 | Basic mode literal-only | Typos / conceptual queries die by design |
| P3 | Relevance scores not returned in API | Harder offline eval |

---

## 5. Patent / IP search findings

### 5.1 Moderate queries

| Query | Approx. total | Relevance | Notes |
|-------|--------------:|-----------|-------|
| sensor | 54 | High | |
| hydrogel | 257 | High | |
| electrochemical | 62 | High | |
| recombinant protein | 64 | High | |
| polymer foam / porous | 250 | High | |
| biotechnology | 60 | High | Semantic bio-process matches |
| video analysis | 18 | Moderate | #1 strong; #2–3 weaker |
| ADC / analog to digital | 255 | Moderate | Top on-topic; mid/tail noise |
| Suresh Bhalla | 5 | High + FP | ~2/5 false positives (token “Suresh”) |
| Naresh Bhatnagar | 20 | High + FP | Partial surname matches |

**Hydration:** 0/95 sampled result slots missing core Mongo fields (`title`, `abstract`, `inventors`, `type_of_ip`). OS↔Mongo aligned at 796.

**Basic vs advanced:** Large recall gap (e.g. hydrogel 5 vs 257; ADC basic **0** vs advanced 255) — expected for keyword-only basic; indexed title typo **“Anolog”** worsens literal “Analog” queries in basic.

### 5.2 Hard / very hard queries

Advanced mode: **strong** on semantic paraphrase, inventor lookup, typo recovery, synonym, and noisy contrastive queries (ground truth typically in top 10; often #1–2).

| ID | Pattern | Result |
|----|---------|--------|
| H1 | Piezoelectric building vibration paraphrase | PASS (GT #2) |
| H1b | Same in **basic** | **FAIL (0)** |
| H2 / H2b | Inventor / inventor+topic | PASS |
| H4 | Analog → stored Anolog | PASS (advanced) |
| H5 | Protein refolding conceptual | PASS (GT #2) |
| H6 | Application number `1011/DEL/2011` | **FAIL** — GT absent from top 100 |
| H7 | Foaming / porous polymer synonym | PASS |
| H8 / H11 | Contrastive noise (blockchain, NFT, quantum…) | PASS — GT still tops |
| H9 | `search_in: [inventor]` | GT #1 but **widens** (5 → 231) — token OR |
| H12 | Multi-camera video paraphrase | PASS (GT #1) |

**Direct OpenSearch check:** `match` on `application_number: "1011/DEL/2011"` returns the correct patent. The API never queries that field.

### 5.3 Patent failure root causes

| Priority | Cause | Evidence |
|----------|-------|----------|
| P0 | **`application_number` indexed but excluded from search fields / `search_in`** | H6 fails; raw OS term query works |
| P0 | App numbers tokenized as `1011` / `del` / `2011` without exact routing | Spurious year/number hits |
| P1 | Inventor matching is **token-OR**, not phrase-on-same-inventor | False positives; `search_in: inventor` widens |
| P1 | Basic mode has no semantic path | Paraphrase → 0 by design |
| P2 | Broad tokens (`digital`, `system`) + kNN | ADC / some topic tails noisier |
| P2 | Stored typo `Anolog` | Correct “Analog” weaker in basic / suggest |
| P3 | Hydrator silently drops orphans; `pagination.total` is pre-hydration | Safe today; risk if sync drifts |

---

## 6. Cross-cutting conclusions

1. **Data integrity is healthy** for this environment — research and IP root counts match Mongo; no hydration orphans observed.
2. **Advanced > basic** for conceptual / typo / paraphrase queries; basic should be treated as a precision/keyword mode, not a default for chatbot-style NL.
3. **Research’s biggest product gap** is person discovery on `/search` despite a working suggest intent engine.
4. **Patent’s biggest product gap** is identifier search (application numbers).
5. **Research’s biggest retrieval gap** is the BM25 pre-check that **prevents semantic-only recovery**.
6. **Patent advanced semantic retrieval outperforms research** on zero-/low-overlap paraphrases in this audit (smaller corpus + different gate/query construction likely contribute).
7. Cluster **yellow** (unassigned replica) is an ops concern, not a ranking bug.

---

## 7. Recommendations

### P0 — Fix first

| # | Action | Target |
|---|--------|--------|
| 1 | Relax or rewrite BM25 pre-check for long/NL queries (stopword strip; lower MSM; or small kNN backup when pre-check = 0) | Research `SearchService._bm25PreCheck` |
| 2 | Add `application_number` to IP search fields with exact/keyword boost; detect `\d+/DEL/\d+` (and similar) and route to `term` query | IP `QueryBuilder` / `FilterBuilder` |
| 3 | Extend IP `search_in` with `application_number` | IP schema + filter builder |

### P1 — High value

| # | Action | Target |
|---|--------|--------|
| 4 | Route person-shaped queries to author/inventor scope using suggest intent (or NER) | Research + IP search entry |
| 5 | Inventor nested clause: require all name tokens on the **same** inventor (phrase / AND) | IP query builder |
| 6 | UI/API hint when `mode=basic` returns 0: “Try advanced for conceptual queries” | Clients / API meta |
| 7 | Soften `name + topic` AND pre-check when author refine is detected | Research |

### P2 — Ranking / UX polish

| # | Action |
|---|--------|
| 8 | Tighten mid-rank noise for broad tokens (ADC-style); boost multi-concept co-occurrence |
| 9 | Expose first-stage / fused scores in API for eval harnesses |
| 10 | Suggest: prefer exact stored-title matches when query is a corrected spelling of a known typo (`Anolog`) |
| 11 | Clarify in ops docs that nested `docs.count` ≠ searchable document count |

### P3 — Observability

| # | Action |
|---|--------|
| 12 | Response meta: `os_hits`, `mongo_hydrated`, `orphan_dropped`, `bm25_precheck_hits` |
| 13 | Golden-query eval harness (this audit’s queries) in CI against staging |
| 14 | Assign IP index replica or accept single-node and document RPO |

---

## 8. Sample ground-truth anchors used

**Research (examples)**

- Hydrophobic functionalization of cellulosic substrate by tetrafluoroethane dielectric barrier discharge plasma…
- Advanced engineering of an S-scheme BiCoO3/Co-g-C3N4 … photocatalytic activity
- Textile / knitted triboelectric nanogenerator papers
- Toughening of epoxy resin using Zn4O(…) metal-organic frameworks

**Patents (examples)**

| Application # | Title (abbrev.) |
|---------------|-----------------|
| 1011/DEL/2011 | Novel Vibration Sensor for Concrete Structures… |
| 1018/DEL/2012 | Process for Refolding of Recombinant Protein |
| 1034/DEL/2008 | Technology for Multi-Perspective Video Analysis |
| 1036/DEL/2015 | Continuous Manufacturing of Porous Polymeric Sheets… |
| 1046/DEL/2000 | An Anolog to Digital Converter… |

---

## 9. Appendix — Latency & cache (indicative)

| Scenario | Observed |
|----------|----------|
| Moderate research advanced (cold) | ~540–930 ms (`meta.took_ms`) |
| Same (cached) | ~13–17 ms |
| Hard research advanced | ~0.5–4.5 s (refine chains higher) |
| Patent advanced hard | ~200–650 ms typical |
| Patent basic (when hits exist) | Often faster; 0-result paraphrase fails quickly |

Exact numbers vary with cache, rerank load, and network RTT to OpenSearch (`10.17.8.24`).

---

## 10. Sign-off

| Item | Status |
|------|--------|
| Code changes in this audit | **None** (read-only testing) |
| Environment | Local API `:3001` → remote OS/Mongo/Redis |
| Follow-up | Implement P0/P1; add golden-query harness |

**Bottom line:** Ship confidence is high for **topic search** (research + patents) and for **patent semantic paraphrase** in advanced mode. Do not ship confidence for **research pure-NL / zero-overlap paraphrase**, **research person-name search**, or **patent application-number lookup** until the P0 items above are addressed.
