"""
Embedding Service
FastAPI service for generating scientific document embeddings.

Supports two inference backends configured by EMBED_BACKEND env var:
  - "onnx" (default): optimum + onnxruntime (INT8-friendly, lower memory)
  - "torch": transformers + PyTorch (original path)

Runs in two modes depending on the BACKEND_NODES env var:
  - Standalone (default): loads the model locally and serves /embed.
  - Gateway:  no local model; scatters batches across backend GPU nodes
              and merges the results.
"""

import asyncio
import os
import time
import logging
import warnings
from contextlib import asynccontextmanager
from typing import List, Optional

warnings.filterwarnings("ignore", category=FutureWarning, module="huggingface_hub")
warnings.filterwarnings("ignore", category=UserWarning, module="torch")

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, ConfigDict

from . import config
from .metrics import (
    EMBEDDING_BATCH_SIZE,
    EMBEDDING_IN_FLIGHT,
    EMBEDDING_INFERENCE_SECONDS,
    EMBEDDING_REQUESTS_TOTAL,
    setup_metrics,
)

_USE_ONNX = config.EMBED_BACKEND == "onnx"

if not _USE_ONNX:
    import torch

# Configure logging based on environment
log_level = getattr(logging, config.LOG_LEVEL, logging.INFO)
logging.basicConfig(level=log_level, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


# ── Request / Response models ────────────────────────────────────────

class EmbedRequest(BaseModel):
    texts: List[str] = Field(
        ...,
        min_length=1,
        max_length=config.MAX_BATCH_SIZE,
        description=f"List of texts to embed (max {config.MAX_BATCH_SIZE})",
    )


class EmbedResponse(BaseModel):
    embeddings: List[List[float]]
    took_ms: float
    dimension: int = config.EMBED_DIM


class RerankRequest(BaseModel):
    query: str = Field(..., min_length=1, description="The query to rerank against")
    documents: List[str] = Field(
        ...,
        min_length=1,
        max_length=config.RERANK_MAX_CANDIDATES,
        description=f"Documents to rerank (max {config.RERANK_MAX_CANDIDATES})",
    )
    top_n: Optional[int] = Field(
        None, ge=1, description="Return only top N results (default: all)"
    )


class RerankResult(BaseModel):
    index: int
    score: float


class RerankResponse(BaseModel):
    results: List[RerankResult]
    took_ms: float


class HealthResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    status: str
    is_loaded: bool
    specter_model: str
    device: str
    in_flight: int = 0


# ── Global state ─────────────────────────────────────────────────────

class ModelState:
    model = None
    tokenizer = None
    device = None
    pool = None  # NodePool instance when running in gateway mode
    in_flight = 0  # standalone: concurrent /embed requests (informational; consumed by gateways)
    # One forward pass at a time: torch already parallelizes a single pass across
    # all CPU cores, so concurrent passes would just thrash caches and RAM.
    infer_lock = asyncio.Lock()

    # Cross-encoder reranker (lazy-loaded on first /rerank call)
    reranker_session = None
    reranker_tokenizer = None
    reranker_loaded = False
    reranker_lock = asyncio.Lock()


state = ModelState()


def _is_gateway_mode() -> bool:
    return len(config.BACKEND_NODES) > 0


# ── Device selection (standalone mode) ───────────────────────────────

def get_device():
    """Determine device based on configuration and availability."""
    if _USE_ONNX:
        return "cpu"  # ONNX Runtime handles its own CPU/GPU provider selection
    if config.USE_GPU == "false":
        return "cpu"
    elif config.USE_GPU == "true":
        if torch.cuda.is_available():
            return "cuda"
        elif torch.backends.mps.is_available():
            return "mps"
        else:
            logger.warning("GPU requested but not available, falling back to CPU")
            return "cpu"
    else:  # auto
        if torch.cuda.is_available():
            return "cuda"
        elif torch.backends.mps.is_available():
            return "mps"
        return "cpu"


# ── Model loading (offline-first) ────────────────────────────────────

def _onnx_cache_dir(model_name: str) -> str:
    """Filesystem path for persisted ONNX export of a HuggingFace model id."""
    safe = model_name.replace("/", "--")
    return os.path.join(config.ONNX_CACHE_DIR, safe)


def _onnx_artifacts_exist(model_dir: str) -> bool:
    """True if a prior export was saved to model_dir."""
    if not os.path.isdir(model_dir):
        return False
    for name in os.listdir(model_dir):
        if name.endswith(".onnx"):
            return True
    return False


def _ort_session_options():
    """Build ONNX Runtime session options with thread limits from config."""
    import onnxruntime as ort
    opts = ort.SessionOptions()
    if config.ORT_NUM_THREADS > 0:
        opts.intra_op_num_threads = config.ORT_NUM_THREADS
        opts.inter_op_num_threads = 1
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return opts


def _load_onnx_from_cache_or_export(model_cls, model_name: str, label: str):
    """
    Load an ONNX optimum model:
      1. From persistent local ONNX cache (fast restarts)
      2. One-time export from HF + save_pretrained to local cache
    """
    from transformers import AutoTokenizer

    session_opts = _ort_session_options()
    local_onnx_dir = _onnx_cache_dir(model_name)

    if _onnx_artifacts_exist(local_onnx_dir):
        logger.info("ONNX cache hit: %s", label)
        tokenizer = AutoTokenizer.from_pretrained(local_onnx_dir)
        model = model_cls.from_pretrained(
            local_onnx_dir, export=False, session_options=session_opts
        )
        return tokenizer, model

    if config.HF_OFFLINE == "true":
        local_attempts = [True]
    elif config.HF_OFFLINE == "false":
        local_attempts = [False]
    else:
        local_attempts = [True, False]

    last_err = None
    for local_only in local_attempts:
        try:
            logger.info("ONNX cache miss: %s — exporting (one-time)...", label)
            tokenizer = AutoTokenizer.from_pretrained(
                model_name, local_files_only=local_only
            )
            model = model_cls.from_pretrained(
                model_name, export=True, local_files_only=local_only,
                session_options=session_opts,
            )
            os.makedirs(local_onnx_dir, exist_ok=True)
            model.save_pretrained(local_onnx_dir)
            tokenizer.save_pretrained(local_onnx_dir)
            logger.info("ONNX cache saved: %s", label)
            return tokenizer, model
        except OSError as e:
            last_err = e
            if local_only and len(local_attempts) > 1:
                logger.info("HF cache miss: %s — downloading...", label)
                continue
            raise
    raise last_err


def _load_model_and_tokenizer():
    """
    Load tokenizer + model, preferring the local HuggingFace cache.
    """
    if _USE_ONNX:
        from optimum.onnxruntime import ORTModelForFeatureExtraction
        return _load_onnx_from_cache_or_export(
            ORTModelForFeatureExtraction, config.MODEL_NAME, config.MODEL_NAME
        )

    from transformers import AutoTokenizer, AutoModel

    if config.HF_OFFLINE == "true":
        attempts = [True]
    elif config.HF_OFFLINE == "false":
        attempts = [False]
    else:
        attempts = [True, False]

    last_err = None
    for local_only in attempts:
        try:
            tokenizer = AutoTokenizer.from_pretrained(
                config.MODEL_NAME, local_files_only=local_only
            )
            model = AutoModel.from_pretrained(
                config.MODEL_NAME, local_files_only=local_only
            )
            logger.info("HF cache hit: %s (PyTorch)", config.MODEL_NAME)
            return tokenizer, model
        except OSError as e:
            last_err = e
            if local_only and len(attempts) > 1:
                logger.info("HF cache miss: %s — downloading...", config.MODEL_NAME)
                continue
            raise
    raise last_err


def _tune_cpu_threads():
    """Pin torch thread pools for single-model CPU serving."""
    if _USE_ONNX:
        threads = config.ORT_NUM_THREADS if config.ORT_NUM_THREADS > 0 else (os.cpu_count() or 1)
        logger.info("ORT threads: %d of %d cores", threads, os.cpu_count() or 0)
        return
    threads = config.TORCH_THREADS if config.TORCH_THREADS > 0 else (os.cpu_count() or 1)
    try:
        torch.set_num_threads(threads)
        torch.set_num_interop_threads(max(1, config.TORCH_INTEROP_THREADS))
    except RuntimeError:
        pass
    logger.info(
        "Torch threads: intra-op=%d, inter-op=%d (cpus=%s)",
        torch.get_num_threads(),
        config.TORCH_INTEROP_THREADS,
        os.cpu_count(),
    )


# ── Lifespan ─────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    if _is_gateway_mode():
        # Gateway mode -- scatter-gather across backend nodes
        from .load_balancer import NodePool

        logger.info(
            "Starting in GATEWAY mode with %d backend nodes: %s",
            len(config.BACKEND_NODES),
            config.BACKEND_NODES,
        )
        state.pool = NodePool(config.BACKEND_NODES)
        await state.pool.start()
        logger.info("Gateway ready")
    else:
        # Standalone mode -- load model locally
        logger.info("Starting in STANDALONE mode (%s), loading model: %s",
                     "ONNX" if _USE_ONNX else "PyTorch", config.MODEL_NAME)

        start_time = time.time()

        state.device = get_device()
        logger.info(f"Using device: {state.device}")

        if state.device == "cpu":
            _tune_cpu_threads()

        state.tokenizer, state.model = _load_model_and_tokenizer()

        if _USE_ONNX:
            logger.info("Warming up embedding model...")
            dummy_input = state.tokenizer(
                ["warmup text"],
                return_tensors="np",
                truncation=True,
                max_length=config.MAX_LENGTH,
            )
            state.model(**dummy_input)
        else:
            if state.device in ("cuda", "mps"):
                state.model = state.model.to(state.device)
            state.model.eval()

            logger.info("Warming up model...")
            dummy_input = state.tokenizer(
                ["warmup text"],
                return_tensors="pt",
                truncation=True,
                max_length=config.MAX_LENGTH,
            )
            if state.device in ("cuda", "mps"):
                dummy_input = {k: v.to(state.device) for k, v in dummy_input.items()}

            with torch.inference_mode():
                state.model(**dummy_input)

        load_time = time.time() - start_time
        logger.info("Embedding model ready in %.2fs", load_time)

        if config.RERANK_ENABLED:
            rerank_start = time.time()
            try:
                state.reranker_tokenizer, state.reranker_session = (
                    await asyncio.to_thread(_load_reranker)
                )
                await asyncio.to_thread(
                    _rerank_sync,
                    "warmup query",
                    ["warmup document one", "warmup document two"],
                )
                state.reranker_loaded = True
                rerank_time = time.time() - rerank_start
                logger.info("Reranker ready in %.2fs", rerank_time)
            except Exception as e:
                logger.error("Failed to load reranker at startup: %s", e)
                raise

    yield

    # Cleanup
    if state.pool:
        await state.pool.stop()
    logger.info("Shutting down embedding service")


app = FastAPI(
    title="Embedding Service (BGE-M3)",
    description="Generate scientific document embeddings using BGE-M3",
    version="1.0.0",
    lifespan=lifespan,
)

# Prometheus instrumentation: HTTP RED middleware + GET /metrics
setup_metrics(app)


# ── Inference (standalone mode) ──────────────────────────────────────

def _pool_and_normalize_np(last_hidden_state, attention_mask):
    """Numpy-based pooling and normalization for ONNX backend."""
    if config.POOLING == "mean":
        mask = attention_mask[:, :, np.newaxis].astype(last_hidden_state.dtype)
        summed = (last_hidden_state * mask).sum(axis=1)
        counts = mask.sum(axis=1).clip(min=1e-9)
        embeddings = summed / counts
    else:
        embeddings = last_hidden_state[:, 0]

    if config.NORMALIZE:
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True).clip(min=1e-9)
        embeddings = embeddings / norms
    return embeddings


def _pool_and_normalize_torch(last_hidden_state, attention_mask):
    """Torch-based pooling and normalization for PyTorch backend."""
    if config.POOLING == "mean":
        mask = attention_mask.unsqueeze(-1).type_as(last_hidden_state)
        summed = (last_hidden_state * mask).sum(dim=1)
        counts = mask.sum(dim=1).clamp(min=1e-9)
        embeddings = summed / counts
    else:
        embeddings = last_hidden_state[:, 0]

    if config.NORMALIZE:
        embeddings = torch.nn.functional.normalize(embeddings, p=2, dim=1)
    return embeddings


def _encode(texts: List[str]) -> List[List[float]]:
    """
    Synchronous batched inference.
    Sorts by length for uniform sub-batch padding, restoring original order after.
    """
    sub = max(1, config.EMBED_SUB_BATCH)
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    results: List[Optional[List[float]]] = [None] * len(texts)

    for start in range(0, len(order), sub):
        idxs = order[start:start + sub]
        batch = [texts[i] for i in idxs]

        if _USE_ONNX:
            inputs = state.tokenizer(
                batch, padding=True, truncation=True,
                max_length=config.MAX_LENGTH, return_tensors="np",
            )
            outputs = state.model(**inputs)
            hidden = outputs.last_hidden_state
            if not isinstance(hidden, np.ndarray):
                hidden = np.array(hidden)
            attn = inputs["attention_mask"]
            if not isinstance(attn, np.ndarray):
                attn = np.array(attn)
            embeddings = _pool_and_normalize_np(hidden, attn)
            for j, i in enumerate(idxs):
                results[i] = embeddings[j].tolist()
        else:
            inputs = state.tokenizer(
                batch, padding=True, truncation=True,
                max_length=config.MAX_LENGTH, return_tensors="pt",
            )
            if state.device in ("cuda", "mps"):
                inputs = {k: v.to(state.device) for k, v in inputs.items()}

            with torch.inference_mode():
                outputs = state.model(**inputs)

            embeddings = _pool_and_normalize_torch(outputs.last_hidden_state, inputs["attention_mask"])
            for j, i in enumerate(idxs):
                results[i] = embeddings[j].cpu().tolist()

    return results


# ── Endpoints ────────────────────────────────────────────────────────

@app.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest):
    """
    Generate embeddings for a batch of texts.

    For best results, format document input as: "title\nabstract"

    In gateway mode the batch is scattered across all healthy GPU nodes
    and the results are merged back in order.
    """
    if not request.texts:
        raise HTTPException(status_code=400, detail="Empty texts list")

    EMBEDDING_BATCH_SIZE.observe(len(request.texts))

    # ── Gateway mode: scatter-gather ──
    if state.pool is not None:
        EMBEDDING_IN_FLIGHT.inc()
        gw_start = time.time()
        try:
            result = await state.pool.scatter_gather(request.texts)
            EMBEDDING_REQUESTS_TOTAL.labels("gateway", "success").inc()
            return EmbedResponse(**result)
        except RuntimeError as e:
            EMBEDDING_REQUESTS_TOTAL.labels("gateway", "error").inc()
            raise HTTPException(status_code=502, detail=str(e))
        except Exception as e:
            EMBEDDING_REQUESTS_TOTAL.labels("gateway", "error").inc()
            raise HTTPException(
                status_code=503,
                detail=f"All backend nodes unavailable: {e}",
            )
        finally:
            EMBEDDING_INFERENCE_SECONDS.observe(time.time() - gw_start)
            EMBEDDING_IN_FLIGHT.dec()

    # ── Standalone mode: local inference ──
    if state.model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    start_time = time.time()
    state.in_flight += 1
    EMBEDDING_IN_FLIGHT.inc()
    try:
        # Serialize forward passes (one at a time uses all cores) and run them
        # off the event loop so /health stays responsive during inference.
        async with state.infer_lock:
            embeddings_list = await asyncio.to_thread(_encode, request.texts)

        took_ms = (time.time() - start_time) * 1000
        EMBEDDING_INFERENCE_SECONDS.observe(took_ms / 1000)
        EMBEDDING_REQUESTS_TOTAL.labels("standalone", "success").inc()

        if config.LOG_LEVEL == "DEBUG":
            logger.debug(f"Generated {len(embeddings_list)} embeddings in {took_ms:.1f}ms")

        return EmbedResponse(
            embeddings=embeddings_list,
            took_ms=took_ms,
            dimension=len(embeddings_list[0]) if embeddings_list else config.EMBED_DIM,
        )
    except Exception:
        EMBEDDING_REQUESTS_TOTAL.labels("standalone", "error").inc()
        raise
    finally:
        state.in_flight = max(0, state.in_flight - 1)
        EMBEDDING_IN_FLIGHT.dec()


# ── Reranker (ONNX cross-encoder, loaded at startup) ─────────────────

def _load_reranker():
    """Load the cross-encoder reranker from ONNX cache (export only on first boot)."""
    from optimum.onnxruntime import ORTModelForSequenceClassification

    return _load_onnx_from_cache_or_export(
        ORTModelForSequenceClassification,
        config.RERANK_MODEL_NAME,
        config.RERANK_MODEL_NAME,
    )


def _rerank_sync(query: str, documents: List[str]) -> List[float]:
    """Run cross-encoder scoring in a thread. Returns raw logit scores."""
    import numpy as np

    tokenizer = state.reranker_tokenizer
    model = state.reranker_session
    sub = max(1, config.RERANK_SUB_BATCH)
    all_scores: List[float] = []

    for start in range(0, len(documents), sub):
        batch_docs = documents[start:start + sub]
        pairs = [[query, doc] for doc in batch_docs]
        inputs = tokenizer(
            pairs,
            padding=True,
            truncation=True,
            max_length=config.RERANK_MAX_LENGTH,
            return_tensors="np",
        )
        outputs = model(**inputs)
        logits = outputs.logits
        if hasattr(logits, 'numpy'):
            logits = logits.numpy()
        scores = logits.squeeze(-1).tolist()
        if isinstance(scores, float):
            scores = [scores]
        all_scores.extend(scores)

    return all_scores


@app.post("/rerank", response_model=RerankResponse)
async def rerank(request: RerankRequest):
    """Rerank documents against a query using the cross-encoder model."""
    if not config.RERANK_ENABLED:
        raise HTTPException(status_code=404, detail="Reranking is disabled")

    if not state.reranker_loaded:
        raise HTTPException(status_code=503, detail="Reranker not loaded")

    start_time = time.time()

    # Run cross-encoder inference off the event loop
    async with state.reranker_lock:
        scores = await asyncio.to_thread(
            _rerank_sync, request.query, request.documents
        )

    # Build results sorted by score descending
    indexed_scores = [
        RerankResult(index=i, score=s) for i, s in enumerate(scores)
    ]
    indexed_scores.sort(key=lambda r: r.score, reverse=True)

    if request.top_n is not None:
        indexed_scores = indexed_scores[: request.top_n]

    took_ms = (time.time() - start_time) * 1000
    return RerankResponse(results=indexed_scores, took_ms=took_ms)


@app.get("/health")
async def health():
    """Health check endpoint"""
    if state.pool is not None:
        pool_status = state.pool.get_status()
        return {
            "status": "healthy" if pool_status["nodes_healthy"] > 0 else "degraded",
            "mode": "gateway",
            "is_loaded": True,
            "specter_model": config.MODEL_NAME,
            "device": "gateway",
            **pool_status,
        }

    return HealthResponse(
        status="healthy" if state.model is not None and (
            not config.RERANK_ENABLED or state.reranker_loaded
        ) else "loading",
        is_loaded=state.model is not None,
        specter_model=config.MODEL_NAME,
        device=state.device or "unknown",
        in_flight=state.in_flight,
    )


@app.get("/")
async def root():
    """Root endpoint with service info"""
    mode = "gateway" if state.pool is not None else "standalone"
    endpoints = {
        "embed": "POST /embed",
        "health": "GET /health",
    }
    if config.RERANK_ENABLED:
        endpoints["rerank"] = "POST /rerank"
    return {
        "service": "Embedding Service (BGE-M3)",
        "version": "1.0.0",
        "mode": mode,
        "reranker_enabled": config.RERANK_ENABLED,
        "reranker_loaded": state.reranker_loaded,
        "endpoints": endpoints,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
        workers=1,
    )
