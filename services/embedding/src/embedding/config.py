import os
from typing import List, Optional
from dotenv import load_dotenv

load_dotenv()

# Model configuration
MODEL_NAME = os.getenv("MODEL_NAME", "BAAI/bge-m3")
MAX_LENGTH = int(os.getenv("MAX_LENGTH", "1024"))
MAX_BATCH_SIZE = int(os.getenv("MAX_BATCH_SIZE", "600"))

# Output embedding dimensionality (BGE-M3 dense = 1024; SPECTER2 = 768).
# Reported in responses/health and used as the fallback when a backend omits it.
EMBED_DIM = int(os.getenv("EMBED_DIM", "1024"))

# Pooling strategy for the token embeddings: "cls" (BGE-M3 dense) or "mean".
POOLING = os.getenv("POOLING", "cls").lower()

# L2-normalize the output embeddings (required for cosine / inner-product kNN).
NORMALIZE = os.getenv("NORMALIZE", "true").lower() != "false"

# Server configuration
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", os.getenv("PORT2", "8000")))

# GPU/CPU configuration
USE_GPU = os.getenv("USE_GPU", "auto").lower()  # "auto", "true", "false"

# Logging
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

# --- Load Balancer / Gateway configuration ---
# Comma-separated list of backend node URLs. Empty = standalone mode (load model locally).
# Example: "http://10.0.0.1:8000,http://10.0.0.2:8000,http://10.0.0.3:8000"
_backend_nodes_raw = os.getenv("BACKEND_NODES", "").strip()
BACKEND_NODES: List[str] = [
    url.strip() for url in _backend_nodes_raw.split(",") if url.strip()
]

HEALTH_CHECK_INTERVAL_S = int(os.getenv("HEALTH_CHECK_INTERVAL_S", "10"))
NODE_TIMEOUT_S = int(os.getenv("NODE_TIMEOUT_S", "60"))
CIRCUIT_BREAKER_THRESHOLD = int(os.getenv("CIRCUIT_BREAKER_THRESHOLD", "3"))
CIRCUIT_BREAKER_RECOVERY_S = int(os.getenv("CIRCUIT_BREAKER_RECOVERY_S", "30"))

# Batches smaller than this go to a single node; larger batches are scattered across all healthy nodes.
SCATTER_MIN_BATCH = int(os.getenv("SCATTER_MIN_BATCH", "16"))

# --- Dynamic load balancing tunables ---
# Max concurrent in-flight requests to a single backend node (per gateway process).
# Set roughly to "uvicorn workers on that backend + 1 pipelined".
MAX_INFLIGHT_PER_NODE = int(os.getenv("MAX_INFLIGHT_PER_NODE", "2"))

# Latency normalizer for capacity scoring (ms). A node responding at this latency
# with one in-flight request gets weight ~1.0.
LATENCY_BASE_MS = float(os.getenv("LATENCY_BASE_MS", "100"))

# Floor used when a node has no observed latency yet (cold start).
LATENCY_FLOOR_MS = float(os.getenv("LATENCY_FLOOR_MS", "50"))

# Minimum share a healthy node must receive in weighted scatter (fraction).
# Prevents starvation of slow-but-up nodes; also keeps latency EMA fresh.
MIN_NODE_WEIGHT = float(os.getenv("MIN_NODE_WEIGHT", "0.1"))

# Max texts sent to a half-open (circuit recovery probe) node in scatter.
HALF_OPEN_PROBE_TEXTS = int(os.getenv("HALF_OPEN_PROBE_TEXTS", "4"))

# When acquiring a per-node semaphore for scatter chunks, skip this node and try
# the next-best after this timeout (seconds). 0 = pure try-acquire (no wait).
NODE_ACQUIRE_TIMEOUT_S = float(os.getenv("NODE_ACQUIRE_TIMEOUT_S", "0"))
