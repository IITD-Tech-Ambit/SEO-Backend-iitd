import os
from typing import List

from dotenv import load_dotenv

load_dotenv()

MODEL_NAME = os.getenv("MODEL_NAME", "BAAI/bge-base-en-v1.5")
MAX_LENGTH = int(os.getenv("MAX_LENGTH", "512"))
MAX_BATCH_SIZE = int(os.getenv("MAX_BATCH_SIZE", "32"))
EMBED_DIM = int(os.getenv("EMBED_DIM", "768"))
EMBED_BACKEND = os.getenv("EMBED_BACKEND", "onnx").lower()
EMBED_SUB_BATCH = int(os.getenv("EMBED_SUB_BATCH", "8"))

_default_onnx_cache = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    ".cache", "onnx",
)
ONNX_CACHE_DIR = os.getenv("ONNX_CACHE_DIR", _default_onnx_cache)

_default_onnx_int8_cache = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    ".cache", "onnx_int8",
)
ONNX_INT8_CACHE_DIR = os.getenv("ONNX_INT8_CACHE_DIR", _default_onnx_int8_cache)

POOLING = os.getenv("POOLING", "cls").lower()
NORMALIZE = os.getenv("NORMALIZE", "true").lower() != "false"

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", os.getenv("PORT2", "8000")))

USE_GPU = os.getenv("USE_GPU", "auto").lower()
HF_OFFLINE = os.getenv("HF_OFFLINE", "auto").lower()
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

# ORT_NUM_THREADS — prefer the dedicated var, fall back to the legacy OMP alias.
ORT_NUM_THREADS = int(os.getenv("ORT_NUM_THREADS", os.getenv("OMP_NUM_THREADS", "0")))
TORCH_THREADS = int(os.getenv("TORCH_THREADS", "0"))
TORCH_INTEROP_THREADS = int(os.getenv("TORCH_INTEROP_THREADS", "1"))

RERANK_ENABLED = os.getenv("RERANK_ENABLED", "true").lower() == "true"
RERANK_MODEL_NAME = os.getenv("RERANK_MODEL_NAME", "BAAI/bge-reranker-base")
RERANK_MAX_LENGTH = int(os.getenv("RERANK_MAX_LENGTH", "320"))
RERANK_MAX_CANDIDATES = int(os.getenv("RERANK_MAX_CANDIDATES", "50"))
RERANK_SUB_BATCH = int(os.getenv("RERANK_SUB_BATCH", "8"))
RERANK_QUANTIZE = os.getenv("RERANK_QUANTIZE", "true").lower() == "true"

_backend_nodes_raw = os.getenv("BACKEND_NODES", "").strip()
BACKEND_NODES: List[str] = [
    url.strip() for url in _backend_nodes_raw.split(",") if url.strip()
]

HEALTH_CHECK_INTERVAL_S = int(os.getenv("HEALTH_CHECK_INTERVAL_S", "10"))
NODE_TIMEOUT_S = int(os.getenv("NODE_TIMEOUT_S", "60"))
CIRCUIT_BREAKER_THRESHOLD = int(os.getenv("CIRCUIT_BREAKER_THRESHOLD", "3"))
CIRCUIT_BREAKER_RECOVERY_S = int(os.getenv("CIRCUIT_BREAKER_RECOVERY_S", "30"))
SCATTER_MIN_BATCH = int(os.getenv("SCATTER_MIN_BATCH", "16"))
MAX_INFLIGHT_PER_NODE = int(os.getenv("MAX_INFLIGHT_PER_NODE", "2"))
LATENCY_BASE_MS = float(os.getenv("LATENCY_BASE_MS", "100"))
LATENCY_FLOOR_MS = float(os.getenv("LATENCY_FLOOR_MS", "50"))
MIN_NODE_WEIGHT = float(os.getenv("MIN_NODE_WEIGHT", "0.1"))
HALF_OPEN_PROBE_TEXTS = int(os.getenv("HALF_OPEN_PROBE_TEXTS", "4"))
NODE_ACQUIRE_TIMEOUT_S = float(os.getenv("NODE_ACQUIRE_TIMEOUT_S", "0"))


def validate() -> None:
    errors = []

    if EMBED_BACKEND not in ("onnx", "torch"):
        errors.append(f"EMBED_BACKEND must be 'onnx' or 'torch', got {EMBED_BACKEND!r}")
    if HF_OFFLINE not in ("auto", "true", "false"):
        errors.append(f"HF_OFFLINE must be 'auto', 'true', or 'false', got {HF_OFFLINE!r}")
    if USE_GPU not in ("auto", "true", "false"):
        errors.append(f"USE_GPU must be 'auto', 'true', or 'false', got {USE_GPU!r}")
    if POOLING not in ("cls", "mean"):
        errors.append(f"POOLING must be 'cls' or 'mean', got {POOLING!r}")
    if MAX_BATCH_SIZE <= 0:
        errors.append(f"MAX_BATCH_SIZE must be > 0, got {MAX_BATCH_SIZE}")
    if EMBED_DIM <= 0:
        errors.append(f"EMBED_DIM must be > 0, got {EMBED_DIM}")
    if LATENCY_BASE_MS <= LATENCY_FLOOR_MS or LATENCY_FLOOR_MS <= 0:
        errors.append(
            f"Required: LATENCY_BASE_MS ({LATENCY_BASE_MS}) > LATENCY_FLOOR_MS ({LATENCY_FLOOR_MS}) > 0"
        )
    if not (0.0 < MIN_NODE_WEIGHT <= 1.0):
        errors.append(f"MIN_NODE_WEIGHT must be in (0, 1], got {MIN_NODE_WEIGHT}")

    if errors:
        raise ValueError("Invalid configuration:\n" + "\n".join(f"  - {e}" for e in errors))
