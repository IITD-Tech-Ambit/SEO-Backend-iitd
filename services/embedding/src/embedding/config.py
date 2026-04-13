import os
from typing import List, Optional
from dotenv import load_dotenv

load_dotenv()

# Model configuration
MODEL_NAME = os.getenv("MODEL_NAME", "allenai/specter2_base")
MAX_LENGTH = int(os.getenv("MAX_LENGTH", "512"))
MAX_BATCH_SIZE = int(os.getenv("MAX_BATCH_SIZE", "600"))

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
