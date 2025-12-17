"""
SPECTER2 Embedding Service
FastAPI service for generating scientific document embeddings
"""

import time
import logging
import warnings
from contextlib import asynccontextmanager
from typing import List

# Suppress external library deprecation warnings
warnings.filterwarnings("ignore", category=FutureWarning, module="huggingface_hub")
warnings.filterwarnings("ignore", category=UserWarning, module="torch")

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from transformers import AutoTokenizer, AutoModel

from . import config

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# Request/Response models
class EmbedRequest(BaseModel):
    texts: List[str] = Field(
        ..., 
        min_length=1, 
        max_length=config.MAX_BATCH_SIZE,
        description="List of texts to embed (max 64)"
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


# Global model state
class ModelState:
    model = None
    tokenizer = None
    device = None


state = ModelState()


def get_device():
    """Determine device based on configuration and availability"""
    if config.USE_GPU == "false":
        return "cpu"
    elif config.USE_GPU == "true":
        if torch.cuda.is_available():
            return "cuda"
        elif torch.backends.mps.is_available():
            return "mps"  # Apple Silicon GPU
        else:
            logger.warning("GPU requested but not available, falling back to CPU")
            return "cpu"
    else:  # auto
        if torch.cuda.is_available():
            return "cuda"
        elif torch.backends.mps.is_available():
            return "mps"  # Apple Silicon GPU
        return "cpu"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load model on startup"""
    logger.info(f"Loading SPECTER2 model: {config.MODEL_NAME}")
    start_time = time.time()
    
    state.device = get_device()
    logger.info(f"Using device: {state.device}")
    
    # Load tokenizer and model
    state.tokenizer = AutoTokenizer.from_pretrained(config.MODEL_NAME)
    state.model = AutoModel.from_pretrained(config.MODEL_NAME)
    
    # Move to device
    if state.device in ("cuda", "mps"):
        state.model = state.model.to(state.device)
    
    state.model.eval()
    
    # Warmup inference
    logger.info("Warming up model...")
    dummy_input = state.tokenizer(
        ["warmup text"], 
        return_tensors="pt", 
        truncation=True, 
        max_length=config.MAX_LENGTH
    )
    if state.device in ("cuda", "mps"):
        dummy_input = {k: v.to(state.device) for k, v in dummy_input.items()}
    
    with torch.no_grad():
        state.model(**dummy_input)
    
    load_time = time.time() - start_time
    logger.info(f"Model loaded in {load_time:.2f}s")
    
    yield
    
    # Cleanup
    logger.info("Shutting down embedding service")


app = FastAPI(
    title="SPECTER2 Embedding Service",
    description="Generate scientific document embeddings using SPECTER2",
    version="1.0.0",
    lifespan=lifespan
)


@app.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest):
    """
    Generate embeddings for a batch of texts.
    
    For best results, format input as: "title [SEP] abstract"
    """
    if state.model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    if not request.texts:
        raise HTTPException(status_code=400, detail="Empty texts list")
    
    start_time = time.time()
    
    # Tokenize
    inputs = state.tokenizer(
        request.texts,
        padding=True,
        truncation=True,
        max_length=config.MAX_LENGTH,
        return_tensors="pt"
    )
    
    # Move to device
    if state.device in ("cuda", "mps"):
        inputs = {k: v.to(state.device) for k, v in inputs.items()}
    
    # Generate embeddings
    with torch.no_grad():
        outputs = state.model(**inputs)
    
    # Mean pooling over token embeddings
    embeddings = outputs.last_hidden_state.mean(dim=1)
    
    # L2 normalize for cosine similarity
    embeddings = torch.nn.functional.normalize(embeddings, p=2, dim=1)
    
    # Convert to list
    embeddings_list = embeddings.cpu().tolist()
    
    took_ms = (time.time() - start_time) * 1000
    
    logger.info(f"Generated {len(embeddings_list)} embeddings in {took_ms:.1f}ms")
    
    return EmbedResponse(
        embeddings=embeddings_list,
        took_ms=took_ms,
        dimension=embeddings.shape[1]
    )


@app.get("/health", response_model=HealthResponse)
async def health():
    """Health check endpoint"""
    return HealthResponse(
        status="healthy" if state.model is not None else "loading",
        is_loaded=state.model is not None,
        specter_model=config.MODEL_NAME,
        device=state.device or "unknown"
    )


@app.get("/")
async def root():
    """Root endpoint with service info"""
    return {
        "service": "SPECTER2 Embedding Service",
        "version": "1.0.0",
        "endpoints": {
            "embed": "POST /embed",
            "health": "GET /health"
        }
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
        workers=1  # Single worker for model loading
    )
