# Embedding Service - Python FastAPI
FROM python:3.11-slim

# Proxy for IITD network
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=$HTTP_PROXY
ENV HTTPS_PROXY=$HTTPS_PROXY
ENV http_proxy=$HTTP_PROXY
ENV https_proxy=$HTTPS_PROXY

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for caching
COPY requirements.txt .

# Install Python dependencies
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

USER appuser

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["python", "run.py"]
