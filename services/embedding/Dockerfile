# Embedding Service - Python FastAPI
FROM python:3.11-slim

# Proxy for IITD network — needed for outbound HuggingFace Hub downloads
# (loader.py falls back to a live download on ONNX-cache miss, e.g. first
# boot before /app/.cache is populated). transformers/huggingface_hub only
# auto-detect the standard HTTP_PROXY/HTTPS_PROXY names (unlike our own
# outbound clients, this is third-party code, so it can't be pointed at an
# app-specific var the way auth-service's OAuth client was).
#
# NO_PROXY/no_proxy is set unconditionally (not from a build ARG) so the
# container's own HEALTHCHECK below (curl to localhost) always bypasses the
# proxy, regardless of whatever HTTP_PROXY/HTTPS_PROXY end up set at runtime
# (Coolify env vars, or Docker client-side config.json auto-injection). Real
# curl (unlike the BusyBox wget hit in auth-service) does honor NO_PROXY
# correctly — confirmed by direct testing — but only if it's actually set;
# nothing here set it before, so a proxy var landing on this container with
# no NO_PROXY would 503 the healthcheck against a perfectly healthy app.
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=$HTTP_PROXY
ENV HTTPS_PROXY=$HTTPS_PROXY
ENV http_proxy=$HTTP_PROXY
ENV https_proxy=$HTTPS_PROXY
ENV NO_PROXY=localhost,127.0.0.1,0.0.0.0
ENV no_proxy=localhost,127.0.0.1,0.0.0.0

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for caching
COPY requirements.txt .

# Install CPU-only PyTorch first (default PyPI torch is often CUDA-enabled, ~1-2GB+;
# CPU wheel is much smaller and matches typical USE_GPU=false deployments).
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

# Remaining deps (transformers will not pull a second torch if already satisfied)
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY . .

# Create cache directory and non-root user with proper permissions
RUN mkdir -p /app/.cache && \
    useradd -m -u 1001 appuser && \
    chown -R appuser:appuser /app /app/.cache

# Set environment for HuggingFace cache
ENV HF_HOME=/app/.cache
ENV TRANSFORMERS_CACHE=/app/.cache
# gunicorn imports "embedding.main:app" directly (unlike run.py, which does
# sys.path.insert(src) itself), so the package needs to be on the path.
ENV PYTHONPATH=/app/src

USER appuser

EXPOSE 8000 50052

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Each worker independently loads the embedding + reranker models in FastAPI's
# lifespan startup (not at import time), so gunicorn's --preload / fork-COW
# memory sharing does NOT apply here — every worker costs its own full model
# copy in RAM (~1.3-1.5GB each, measured). WEB_CONCURRENCY is deliberately
# conservative for that reason; see services/embedding/.env.docker.
# Note: gunicorn's own --log-level is intentionally hardcoded to "info", not
# tied to $LOG_LEVEL — the app's Python logging (config.LOG_LEVEL) expects
# uppercase (getattr(logging, "INFO")), while gunicorn's flag requires
# lowercase; they're independent knobs, not the same setting.
CMD ["sh", "-c", \
     "gunicorn embedding.main:app \
        --worker-class uvicorn.workers.UvicornWorker \
        --workers ${WEB_CONCURRENCY:-3} \
        --bind 0.0.0.0:${PORT:-8000} \
        --timeout ${GUNICORN_TIMEOUT:-120} \
        --graceful-timeout 30 \
        --keep-alive 5 \
        --log-level info \
        --access-logfile - \
        --error-logfile -"]
