"""
Embedding Service (BGE-M3)
FastAPI service for generating scientific document embeddings.

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

# Suppress external library deprecation warnings
warnings.filterwarnings("ignore", category=FutureWarning, module="huggingface_hub")
warnings.filterwarnings("ignore", category=UserWarning, module="torch")

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, ConfigDict

from . import config

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


state = ModelState()


def _is_gateway_mode() -> bool:
    return len(config.BACKEND_NODES) > 0


# ── Device selection (standalone mode) ───────────────────────────────

def get_device():
    """Determine device based on configuration and availability"""
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

def _load_model_and_tokenizer():
    """
    Load tokenizer + model, preferring the local HuggingFace cache.

    HF_OFFLINE=true  -> never touch the network (fail if not cached).
    HF_OFFLINE=false -> normal behavior (network allowed).
    HF_OFFLINE=auto  -> try local cache first; fall back to download only
                        if the model is not cached.
    """
    from transformers import AutoTokenizer, AutoModel

    if config.HF_OFFLINE == "true":
        attempts = [True]
    elif config.HF_OFFLINE == "false":
        attempts = [False]
    else:  # auto
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
            logger.info(
                "Loaded %s from %s",
                config.MODEL_NAME,
                "local cache (no network)" if local_only else "hub (downloaded)",
            )
            return tokenizer, model
        except OSError as e:
            last_err = e
            if local_only and len(attempts) > 1:
                logger.info("Model not in local cache, falling back to download...")
                continue
            raise
    raise last_err


def _tune_cpu_threads():
    """Pin torch thread pools for single-model CPU serving."""
    threads = config.TORCH_THREADS if config.TORCH_THREADS > 0 else (os.cpu_count() or 1)
    try:
        torch.set_num_threads(threads)
        torch.set_num_interop_threads(max(1, config.TORCH_INTEROP_THREADS))
    except RuntimeError:
        # set_num_interop_threads can only be called once / before parallel work
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
        logger.info(f"Starting in STANDALONE mode, loading model: {config.MODEL_NAME}")

        start_time = time.time()

        state.device = get_device()
        logger.info(f"Using device: {state.device}")

        if state.device == "cpu":
            _tune_cpu_threads()

        state.tokenizer, state.model = _load_model_and_tokenizer()

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
        logger.info(f"Model loaded in {load_time:.2f}s")

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


# ── Inference (standalone mode) ──────────────────────────────────────

def _pool_and_normalize(last_hidden_state, attention_mask):
    if config.POOLING == "mean":
        # Mean pooling over non-padding tokens.
        mask = attention_mask.unsqueeze(-1).type_as(last_hidden_state)
        summed = (last_hidden_state * mask).sum(dim=1)
        counts = mask.sum(dim=1).clamp(min=1e-9)
        embeddings = summed / counts
    else:
        # CLS pooling — BGE-M3 dense embedding uses the [CLS] token.
        embeddings = last_hidden_state[:, 0]

    if config.NORMALIZE:
        embeddings = torch.nn.functional.normalize(embeddings, p=2, dim=1)
    return embeddings


def _encode(texts: List[str]) -> List[List[float]]:
    """
    Synchronous batched inference, tuned for CPU:
      - processes EMBED_SUB_BATCH texts per forward pass (bounds peak RAM:
        activations scale with batch x sequence length),
      - sorts texts by length so each sub-batch pads to a similar length
        (less wasted compute on pad tokens), restoring original order after,
      - uses torch.inference_mode() (cheaper than no_grad).
    """
    sub = max(1, config.EMBED_SUB_BATCH)
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    results: List[Optional[List[float]]] = [None] * len(texts)

    for start in range(0, len(order), sub):
        idxs = order[start:start + sub]
        batch = [texts[i] for i in idxs]

        inputs = state.tokenizer(
            batch,
            padding=True,
            truncation=True,
            max_length=config.MAX_LENGTH,
            return_tensors="pt",
        )
        if state.device in ("cuda", "mps"):
            inputs = {k: v.to(state.device) for k, v in inputs.items()}

        with torch.inference_mode():
            outputs = state.model(**inputs)

        embeddings = _pool_and_normalize(outputs.last_hidden_state, inputs["attention_mask"])
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

    # ── Gateway mode: scatter-gather ──
    if state.pool is not None:
        try:
            result = await state.pool.scatter_gather(request.texts)
            return EmbedResponse(**result)
        except RuntimeError as e:
            raise HTTPException(status_code=502, detail=str(e))
        except Exception as e:
            raise HTTPException(
                status_code=503,
                detail=f"All backend nodes unavailable: {e}",
            )

    # ── Standalone mode: local inference ──
    if state.model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    start_time = time.time()
    state.in_flight += 1
    try:
        # Serialize forward passes (one at a time uses all cores) and run them
        # off the event loop so /health stays responsive during inference.
        async with state.infer_lock:
            embeddings_list = await asyncio.to_thread(_encode, request.texts)

        took_ms = (time.time() - start_time) * 1000

        if config.LOG_LEVEL == "DEBUG":
            logger.debug(f"Generated {len(embeddings_list)} embeddings in {took_ms:.1f}ms")

        return EmbedResponse(
            embeddings=embeddings_list,
            took_ms=took_ms,
            dimension=len(embeddings_list[0]) if embeddings_list else config.EMBED_DIM,
        )
    finally:
        state.in_flight = max(0, state.in_flight - 1)


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
        status="healthy" if state.model is not None else "loading",
        is_loaded=state.model is not None,
        specter_model=config.MODEL_NAME,
        device=state.device or "unknown",
        in_flight=state.in_flight,
    )


@app.get("/")
async def root():
    """Root endpoint with service info"""
    mode = "gateway" if state.pool is not None else "standalone"
    return {
        "service": "Embedding Service (BGE-M3)",
        "version": "1.0.0",
        "mode": mode,
        "endpoints": {
            "embed": "POST /embed",
            "health": "GET /health",
        },
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
