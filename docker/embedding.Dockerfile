# ============================================
# SPECTER2 Embedding Service - Production Dockerfile
# ============================================
# Optimized for PyTorch CPU inference

# Stage 1: Builder
FROM python:3.10-slim AS builder
WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Create virtual environment
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy requirements
COPY services/embedding/requirements.txt .

# Install dependencies (CPU-only PyTorch for smaller image)
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir \
    torch==2.6.0+cpu \
    --index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir -r requirements.txt

# Stage 2: Production
FROM python:3.10-slim AS production
WORKDIR /app

# Create non-root user
RUN groupadd -r embedding && useradd -r -g embedding embedding

# Copy virtual environment from builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy application code
COPY services/embedding/src/ ./src/
COPY services/embedding/run.py ./

# Create cache directory for HuggingFace models
RUN mkdir -p /app/.cache && chown -R embedding:embedding /app
ENV HF_HOME=/app/.cache
ENV TRANSFORMERS_CACHE=/app/.cache

# Set environment
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV HOST=0.0.0.0
ENV PORT=8001

# Use non-root user
USER embedding

# Expose port
EXPOSE 8001

# Health check
HEALTHCHECK --interval=30s --timeout=30s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8001/health')" || exit 1

# Start server
CMD ["python", "run.py"]
