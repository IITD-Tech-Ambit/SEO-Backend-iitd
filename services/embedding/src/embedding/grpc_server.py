"""gRPC transport for embedding.v1.EmbeddingService.

Thin adapter over the same inference paths the FastAPI routes use — the model
state lives in `routes` (populated by the lifespan) so REST and gRPC share
one loaded model.

Each gunicorn worker claims its OWN port instead of sharing one via
SO_REUSEPORT. SO_REUSEPORT only load-balances at TCP-connection-accept time —
Envoy (and any other gRPC/HTTP2 client) holds a small number of long-lived,
multiplexed connections, so with one shared port nearly all traffic funnels
through whichever one worker happened to accept those connections, leaving
the other workers idle while that one queues. Binding a distinct port per
worker and listing all of them in Envoy's cluster (see envoy/envoy.yaml)
lets Envoy's own per-request load balancing actually spread work across
every worker.
"""

import logging
import os
import time

import grpc

from . import config, metrics, routes
from .inference import InferenceQueueTimeout, run_embed, run_rerank, track_inflight
from iitd_ambit_protos.embedding.v1 import embedding_pb2, embedding_pb2_grpc

logger = logging.getLogger(__name__)

GRPC_PORT = int(os.getenv("GRPC_PORT", "50052"))
# Pool size must cover every gunicorn worker (WEB_CONCURRENCY) so each one can
# claim a distinct port; keep envoy.yaml's embedding_grpc endpoint list in sync.
GRPC_PORT_POOL_SIZE = int(os.getenv("GRPC_PORT_POOL_SIZE", os.getenv("WEB_CONCURRENCY", "3")))


class EmbeddingServicer(embedding_pb2_grpc.EmbeddingServiceServicer):
    async def Embed(self, request, context):
        texts = list(request.texts)
        if not texts:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "texts must not be empty")

        start = time.time()

        if routes.node_pool is not None:
            try:
                result = await routes.node_pool.scatter_gather(texts)
                embeddings = result["embeddings"]
            except Exception as exc:
                metrics.EMBEDDING_REQUESTS_TOTAL.labels(mode="gateway", outcome="error").inc()
                await context.abort(grpc.StatusCode.UNAVAILABLE, f"backend nodes unavailable: {exc}")
            metrics.EMBEDDING_REQUESTS_TOTAL.labels(mode="gateway", outcome="success").inc()
        else:
            if routes.emb_state is None or routes.emb_state.model is None:
                await context.abort(grpc.StatusCode.UNAVAILABLE, "model not loaded")
            try:
                async with track_inflight(routes.emb_state):
                    embeddings = await run_embed(texts, routes.emb_state)
                metrics.EMBEDDING_REQUESTS_TOTAL.labels(mode="standalone", outcome="success").inc()
            except InferenceQueueTimeout as exc:
                metrics.EMBEDDING_REQUESTS_TOTAL.labels(mode="standalone", outcome="error").inc()
                await context.abort(grpc.StatusCode.UNAVAILABLE, str(exc))
            except Exception:
                metrics.EMBEDDING_REQUESTS_TOTAL.labels(mode="standalone", outcome="error").inc()
                raise

        elapsed = time.time() - start
        metrics.EMBEDDING_INFERENCE_SECONDS.observe(elapsed)
        metrics.EMBEDDING_BATCH_SIZE.observe(len(texts))

        return embedding_pb2.EmbedResponse(
            embeddings=[embedding_pb2.Embedding(values=e) for e in embeddings],
            took_ms=elapsed * 1000,
            dimension=len(embeddings[0]) if embeddings else config.EMBED_DIM,
        )

    async def Rerank(self, request, context):
        if not config.RERANK_ENABLED:
            await context.abort(grpc.StatusCode.UNIMPLEMENTED, "reranking is disabled")
        if routes.reranker_state is None or not routes.reranker_state.loaded:
            await context.abort(grpc.StatusCode.UNAVAILABLE, "reranker not loaded")

        start = time.time()
        try:
            scores = await run_rerank(request.query, list(request.documents), routes.reranker_state)
            metrics.RERANKER_REQUESTS_TOTAL.labels(outcome="success").inc()
        except InferenceQueueTimeout as exc:
            metrics.RERANKER_REQUESTS_TOTAL.labels(outcome="error").inc()
            await context.abort(grpc.StatusCode.UNAVAILABLE, str(exc))
        except Exception:
            metrics.RERANKER_REQUESTS_TOTAL.labels(outcome="error").inc()
            raise
        finally:
            elapsed = time.time() - start
            metrics.RERANKER_INFERENCE_SECONDS.observe(elapsed)
            metrics.RERANKER_DOCS_PER_REQUEST.observe(len(request.documents))

        ranked = sorted(
            (embedding_pb2.RerankResult(index=i, score=s) for i, s in enumerate(scores)),
            key=lambda r: r.score,
            reverse=True,
        )
        if request.top_n > 0:
            ranked = ranked[: request.top_n]

        return embedding_pb2.RerankResponse(
            results=ranked,
            took_ms=(time.time() - start) * 1000,
        )


async def start_grpc_server() -> grpc.aio.Server:
    """Claim the first free port in [GRPC_PORT, GRPC_PORT + GRPC_PORT_POOL_SIZE).

    `grpc.so_reuseport=0` disables the default SO_REUSEPORT behavior so a
    port already held by a sibling worker genuinely fails to bind instead of
    silently sharing it — that's what makes each worker land on its own
    distinct port. Concurrent workers racing for the same port is safe: the
    OS bind() is atomic, so at most one of them wins per attempt. A failed
    bind raises RuntimeError (not a 0 return, despite what the grpc-python
    docs imply) — caught below so the loop can fall through to the next port.
    """
    servicer = EmbeddingServicer()
    last_error = None
    for offset in range(GRPC_PORT_POOL_SIZE):
        port = GRPC_PORT + offset
        server = grpc.aio.server(options=(("grpc.so_reuseport", 0),))
        embedding_pb2_grpc.add_EmbeddingServiceServicer_to_server(servicer, server)
        try:
            bound_port = server.add_insecure_port(f"0.0.0.0:{port}")
        except RuntimeError as exc:
            last_error = f"port {port}: {exc}"
            continue
        if bound_port == 0:
            last_error = f"port {port} already in use"
            continue
        await server.start()
        logger.info("embedding.v1 gRPC server listening on :%d", port)
        return server
    raise RuntimeError(
        f"embedding.v1 gRPC server could not bind any port in "
        f"[{GRPC_PORT}, {GRPC_PORT + GRPC_PORT_POOL_SIZE}): {last_error}"
    )
