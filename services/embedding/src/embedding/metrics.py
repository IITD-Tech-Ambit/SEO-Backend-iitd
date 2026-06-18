"""
Prometheus metrics for the embedding service.

Exposes RED metrics (Rate / Errors / Duration) under the SAME metric name and
label scheme as the Node services (`http_request_duration_seconds` with
method / route / status_code) so dashboards and alert rules stay uniform, plus
embedding-specific domain metrics.

Metrics are served on the app's own port at GET /metrics. nginx blocks the
public `/embed/metrics` path; Prometheus scrapes `embedding:8000/metrics`
directly on the internal Docker network.
"""

import time

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)
from starlette.requests import Request
from starlette.responses import Response

# ── HTTP RED metrics ─────────────────────────────────────────────────
HTTP_REQUEST_DURATION = Histogram(
    "http_request_duration_seconds",
    "HTTP request duration in seconds",
    labelnames=("method", "route", "status_code"),
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30),
)

# ── Embedding domain metrics ─────────────────────────────────────────
EMBEDDING_INFERENCE_SECONDS = Histogram(
    "embedding_inference_seconds",
    "Time spent generating embeddings for one request (seconds)",
    buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60),
)

EMBEDDING_BATCH_SIZE = Histogram(
    "embedding_batch_size",
    "Number of texts per embedding request",
    buckets=(1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 600),
)

EMBEDDING_IN_FLIGHT = Gauge(
    "embedding_in_flight_requests",
    "Embedding requests currently being processed",
)

EMBEDDING_REQUESTS_TOTAL = Counter(
    "embedding_requests_total",
    "Total embedding requests by mode and outcome",
    labelnames=("mode", "outcome"),  # mode: standalone|gateway ; outcome: success|error
)


def setup_metrics(app) -> None:
    """Attach the timing middleware and the /metrics endpoint to a FastAPI app."""

    @app.middleware("http")
    async def _track_requests(request: Request, call_next):
        # Skip self-scrape so /metrics does not inflate its own series.
        if request.url.path == "/metrics":
            return await call_next(request)

        start = time.perf_counter()
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        finally:
            elapsed = time.perf_counter() - start
            route = request.scope.get("route")
            route_label = getattr(route, "path", None) or request.url.path
            HTTP_REQUEST_DURATION.labels(
                request.method, route_label, str(status_code)
            ).observe(elapsed)

    @app.get("/metrics", include_in_schema=False)
    async def metrics_endpoint() -> Response:
        return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)
