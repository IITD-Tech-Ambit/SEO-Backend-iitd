# Production Deployment (full stack)

These files are the **production orchestration** for the whole Tech Ambit stack
running on the VM. On the VM everything lives under `~/main/`, which is **not** a
git repo, so the canonical copies are versioned here.

> The `docker-compose.yml` build contexts (`./SEO-Backend-iitd`,
> `./research-ambit-main`, `./tech-ambit-explorer`, `./chatbot-service`,
> `./nginx`) are **siblings of this repo on the VM**, not subfolders of it.
> Deploy by copying these files to `~/main/` (see layout below), not by running
> them from inside this repo.

## VM layout (`~/main/`)

```
~/main/
├── docker-compose.yml          <- deploy/docker-compose.yml (this folder)
├── nginx/
│   ├── nginx.conf              <- deploy/nginx/nginx.conf (this folder)
│   └── Dockerfile
├── docker/
│   └── proxy.env               <- IITD proxy + NO_PROXY (not in git)
├── certs/                      <- TLS certs (not in git)
├── SEO-Backend-iitd/           <- this repo (search-api + embedding)
├── research-ambit-main/        <- backend repo
├── tech-ambit-explorer/        <- frontend repo
└── chatbot-service/            <- chatbot microservice repo
```

## Services

| Service | Image/Context | Port | Notes |
|---------|---------------|------|-------|
| mongodb, redis, opensearch | official images | 27017 / 6379 / 9200 | data stores |
| embedding | `./SEO-Backend-iitd/services/embedding` | 8000 | BGE-M3 |
| search-api | `./SEO-Backend-iitd` | 3001 | hybrid search |
| backend | `./research-ambit-main` | 3002 | CMS / directory |
| **chatbot** | `./chatbot-service` | **3003** | agentic RAG chatbot |
| frontend | `./tech-ambit-explorer` | 80 | React SPA |
| nginx | `./nginx` | 80/443 | reverse proxy + TLS |

## nginx routes

- `/` → frontend
- `/api/` → backend
- `/search/` → search-api
- `/chat-api/api/v1/chat` → chatbot (SSE, buffering disabled)
- `/embed/` → embedding

## Env files (kept out of git — create on the VM)

- `chatbot-service/.env.docker` — Mongo/OpenSearch/Redis/embedding/search-api URLs + `GROQ_API_KEY`
- `SEO-Backend-iitd/.env.docker`, `research-ambit-main/.env.docker`, embedding `.env.docker`
- `docker/proxy.env` — `HTTP(S)_PROXY` + `NO_PROXY`

## Deploy / update

```bash
cd ~/main
docker compose build chatbot search-api frontend nginx
docker compose up -d
```
