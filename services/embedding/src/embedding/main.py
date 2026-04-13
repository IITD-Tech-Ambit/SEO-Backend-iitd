"""
SPECTER2 Embedding Service
FastAPI service for generating scientific document embeddings.

Runs in two modes depending on the BACKEND_NODES env var:
  - Standalone (default): loads the model locally and serves /embed.
  - Gateway:  no local model; scatters batches across backend GPU nodes
              and merges the results.
"""

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
    dimension: int = 768


class HealthResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    status: str
    is_loaded: bool
    specter_model: str
    device: str


# ── Global state ─────────────────────────────────────────────────────

class ModelState:
    model = None
    tokenizer = None
    device = None
    pool = None  # NodePool instance when running in gateway mode


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
        from transformers import AutoTokenizer, AutoModel

        start_time = time.time()

        state.device = get_device()
        logger.info(f"Using device: {state.device}")

        state.tokenizer = AutoTokenizer.from_pretrained(config.MODEL_NAME)
        state.model = AutoModel.from_pretrained(config.MODEL_NAME)

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

        with torch.no_grad():
            state.model(**dummy_input)

        load_time = time.time() - start_time
        logger.info(f"Model loaded in {load_time:.2f}s")

    yield

    # Cleanup
    if state.pool:
        await state.pool.stop()
    logger.info("Shutting down embedding service")


app = FastAPI(
    title="SPECTER2 Embedding Service",
    description="Generate scientific document embeddings using SPECTER2",
    version="1.0.0",
    lifespan=lifespan,
)


# ── Endpoints ────────────────────────────────────────────────────────

@app.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest):
    """
    Generate embeddings for a batch of texts.

    For best results, format input as: "title [SEP] abstract"

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

    inputs = state.tokenizer(
        request.texts,
        padding=True,
        truncation=True,
        max_length=config.MAX_LENGTH,
        return_tensors="pt",
    )

    if state.device in ("cuda", "mps"):
        inputs = {k: v.to(state.device) for k, v in inputs.items()}

    with torch.no_grad():
        outputs = state.model(**inputs)

    embeddings = outputs.last_hidden_state.mean(dim=1)
    embeddings = torch.nn.functional.normalize(embeddings, p=2, dim=1)
    embeddings_list = embeddings.cpu().tolist()

    took_ms = (time.time() - start_time) * 1000

    if config.LOG_LEVEL == "DEBUG":
        logger.debug(f"Generated {len(embeddings_list)} embeddings in {took_ms:.1f}ms")

    return EmbedResponse(
        embeddings=embeddings_list,
        took_ms=took_ms,
        dimension=embeddings.shape[1],
    )


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
    )


@app.get("/")
async def root():
    """Root endpoint with service info"""
    mode = "gateway" if state.pool is not None else "standalone"
    return {
        "service": "SPECTER2 Embedding Service",
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
