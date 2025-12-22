# Running the Search Stack

## Prerequisites

- Docker and Docker Compose installed
- Minimum 4–6 GB free RAM (OpenSearch is memory intensive)

Create a `.env` file in the project root or export environment variables in your shell. At minimum set:

```env
OPENSEARCH_INITIAL_ADMIN_PASSWORD=your_admin_password
OPENSEARCH_PASSWORD=your_admin_password
MONGODB_URI=mongodb://localhost:27017
```

Optionally set `OPENSEARCH_USER` (defaults to `admin`).

## Start the stack

```bash
docker-compose -f docker/docker-compose.yml up -d
```

## Inspect running services

List containers:

```bash
docker-compose -f docker/docker-compose.yml ps
```

Tail logs for main services:

```bash
docker-compose -f docker/docker-compose.yml logs -f api embedding opensearch-node1 redis
```

## Health checks

OpenSearch (TLS + auth):

```bash
curl -u ${OPENSEARCH_USER:-admin}:${OPENSEARCH_PASSWORD} -k https://localhost:9200/
```

Embedding service:

```bash
curl http://localhost:8001/health
```

API health:

```bash
curl http://localhost:3000/api/v1/search/health
```

## Notes

- The compose uses images `sudarshan052/embedding-service:latest` and `sudarshan052/search-api:latest`. To use local builds, change `image:` to `build:` in `docker/docker-compose.yml` or build & tag images locally.
- Volumes: `opensearch-data1`, `opensearch-data2`, `redis-data` persist data.

---

# Go Indexer (services_go/indexer_go)

Path: [services_go/indexer_go](services_go/indexer_go)

### Run locally (recommended for development)

Build the indexer:

```bash
cd services_go/indexer_go
go build -o indexer ./cmd/indexer
```

Set environment variables (example):

```bash
export MONGODB_URI="mongodb://localhost:27017"
export OPENSEARCH_NODE="https://localhost:9200"
export OPENSEARCH_USER=admin
export OPENSEARCH_PASSWORD=your_admin_password
```

Start the indexer (example flags):

```bash
./indexer --create-index --reindex-all
```

---

# Troubleshooting

- If OpenSearch is unreachable, inspect its logs:

```bash
docker-compose -f docker/docker-compose.yml logs opensearch-node1
```

- Confirm `OPENSEARCH_INITIAL_ADMIN_PASSWORD` was set before the first startup.
- If the API returns 5xx, check API logs and embedding health:

```bash
docker-compose -f docker/docker-compose.yml logs api
curl http://localhost:8001/health
```

- Stop and remove the stack and volumes:

```bash
docker-compose -f docker/docker-compose.yml down --volumes
```

- Pull latest images:

```bash
docker-compose -f docker/docker-compose.yml pull
```

---

Before running in a new environment, inspect `docker/docker-compose.yml` for required env placeholders and review `services/indexer/src/indexer/config.py` to confirm exact env variable names used by the indexer.
