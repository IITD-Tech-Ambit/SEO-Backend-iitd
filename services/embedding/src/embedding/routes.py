import time

from fastapi import APIRouter, HTTPException

from . import config
from .inference import run_embed, run_rerank, track_inflight
from .models import (
    EmbedRequest,
    EmbedResponse,
    HealthResponse,
    RerankRequest,
    RerankResponse,
    RerankResult,
)

router = APIRouter()

# Populated by the lifespan in main.py before any request is served.
emb_state = None
reranker_state = None
node_pool = None


@router.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest):
    if node_pool is not None:
        try:
            result = await node_pool.scatter_gather(request.texts)
            return EmbedResponse(**result)
        except RuntimeError as e:
            raise HTTPException(status_code=502, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"All backend nodes unavailable: {e}")

    if emb_state is None or emb_state.model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    start = time.time()
    async with track_inflight(emb_state):
        embeddings = await run_embed(request.texts, emb_state)

    took_ms = (time.time() - start) * 1000
    return EmbedResponse(
        embeddings=embeddings,
        took_ms=took_ms,
        dimension=len(embeddings[0]) if embeddings else config.EMBED_DIM,
    )


@router.post("/rerank", response_model=RerankResponse)
async def rerank(request: RerankRequest):
    if not config.RERANK_ENABLED:
        raise HTTPException(status_code=404, detail="Reranking is disabled")
    if reranker_state is None or not reranker_state.loaded:
        raise HTTPException(status_code=503, detail="Reranker not loaded")

    start = time.time()
    scores = await run_rerank(request.query, request.documents, reranker_state)

    ranked = sorted(
        [RerankResult(index=i, score=s) for i, s in enumerate(scores)],
        key=lambda r: r.score,
        reverse=True,
    )
    if request.top_n is not None:
        ranked = ranked[: request.top_n]

    return RerankResponse(results=ranked, took_ms=(time.time() - start) * 1000)


@router.get("/health")
async def health():
    if node_pool is not None:
        status = node_pool.get_status()
        return {
            "status": "healthy" if status["nodes_healthy"] > 0 else "degraded",
            "mode": "gateway",
            "is_loaded": True,
            "specter_model": config.MODEL_NAME,
            "device": "gateway",
            **status,
        }

    loaded = emb_state is not None and emb_state.model is not None
    reranker_ok = not config.RERANK_ENABLED or (
        reranker_state is not None and reranker_state.loaded
    )
    return HealthResponse(
        status="healthy" if loaded and reranker_ok else "loading",
        is_loaded=loaded,
        specter_model=config.MODEL_NAME,
        device=emb_state.device if emb_state else "unknown",
        in_flight=emb_state.in_flight if emb_state else 0,
    )


@router.get("/")
async def root():
    mode = "gateway" if node_pool is not None else "standalone"
    endpoints = {"embed": "POST /embed", "health": "GET /health"}
    if config.RERANK_ENABLED:
        endpoints["rerank"] = "POST /rerank"
    return {
        "service": "Embedding Service",
        "version": "2.0.0",
        "mode": mode,
        "reranker_enabled": config.RERANK_ENABLED,
        "reranker_quantized": config.RERANK_QUANTIZE,
        "reranker_loaded": reranker_state.loaded if reranker_state else False,
        "endpoints": endpoints,
    }
