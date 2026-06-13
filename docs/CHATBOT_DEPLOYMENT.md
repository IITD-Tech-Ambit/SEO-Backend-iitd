# RAG Chatbot — Deployment Guide (baadal VM)

The chatbot adds one new endpoint to the search-api:

```
POST /api/v1/chat
Body: { "message": "...", "history": [{ "role": "user"|"assistant", "content": "..." }] }
Response: Server-Sent Events stream (events: sources, token, done, error)
```

Pipeline per message: condense follow-up (Groq, fast model) -> embed query (BGE-M3) -> hybrid BM25 + kNN search in OpenSearch -> hydrate top-k papers from MongoDB -> stream grounded answer from Groq with `[n]` citations.

## 1. Get a Groq API key

Create a free key at https://console.groq.com/keys.

## 2. Configure environment on the VM

In the compose project directory (`~/main`), add to the `.env` file used by docker compose:

```bash
GROQ_API_KEY=gsk_...
# optional overrides (these are the defaults):
# GROQ_MODEL=llama-3.3-70b-versatile
# GROQ_CONDENSE_MODEL=llama-3.1-8b-instant
# CHAT_TOP_K=8
```

Then add the variables to the `search-api` service in the VM's compose file (same as done in `docker-compose.services.yml` here):

```yaml
  search-api:
    environment:
      # ... existing vars ...
      - GROQ_API_KEY=${GROQ_API_KEY}
      - GROQ_MODEL=${GROQ_MODEL:-llama-3.3-70b-versatile}
      - GROQ_CONDENSE_MODEL=${GROQ_CONDENSE_MODEL:-llama-3.1-8b-instant}
      - CHAT_TOP_K=${CHAT_TOP_K:-8}
```

## 3. Nginx: disable buffering for the SSE stream

Nginx buffers proxied responses by default, which breaks token streaming
(the whole answer would arrive at once). In the nginx config that proxies
`/search/` to the search-api, add a dedicated location for the chat route
**above** the general `/search/` location:

```nginx
# SSE chat stream - must not be buffered
location /search/api/v1/chat {
    proxy_pass http://search-api:3001/api/v1/chat;   # match your existing upstream/port
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    chunked_transfer_encoding off;
    proxy_read_timeout 120s;
}
```

Notes:
- Use the same `proxy_pass` upstream name/port as the existing `/search/` location (adjust `search-api:3001` if your compose uses port 3000 internally).
- The API also sends `X-Accel-Buffering: no`, which disables buffering per-response on most setups, but the explicit location block is the reliable option.

## 4. Rebuild and restart

```bash
cd ~/main
# pull the updated code for SEO-Backend-iitd and tech-ambit-explorer first
docker compose build search-api frontend nginx
docker compose up -d search-api frontend nginx
```

## 5. Verify

Health (chat returns 503 if GROQ_API_KEY is missing):

```bash
docker logs search-api --tail 20   # should NOT show "GROQ_API_KEY is not set"
```

Test the chat endpoint directly (streams SSE events):

```bash
curl -N -X POST http://localhost:3001/api/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "What research is being done on machine learning at IIT Delhi?"}'
```

Expected output: an `event: sources` frame with a JSON array of papers, then many `event: token` frames, then `event: done`.

Through nginx (verifies buffering is off — tokens must trickle in, not arrive all at once):

```bash
curl -N -X POST https://<your-domain>/search/api/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "Which faculty work on renewable energy?"}'
```

Finally open the website — the "Research Assistant" launcher sits at the bottom-right corner (the Suggestions button moved just above it).

## Operational notes

- Rate limit: 20 messages/min per IP (Redis-backed; override with `CHAT_RATE_MAX_REQUESTS` / `CHAT_RATE_WINDOW_SEC`).
- Chat is stateless server-side; conversation history lives in the browser (sessionStorage) and is sent with each request.
- Query embeddings are cached in Redis (24h TTL), so repeated questions skip the embedding service.
- Groq free tier is roughly 30 req/min per model; each chat message uses up to 2 LLM calls (condense + answer).
