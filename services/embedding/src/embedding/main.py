import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import config, metrics, routes
from .device import get_device
from .loader import load_embedding_model, load_reranker, tune_cpu_threads
from .state import EmbeddingState, RerankerState

log_level = getattr(logging, config.LOG_LEVEL, logging.INFO)
logging.basicConfig(level=log_level, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.validate()

    if config.BACKEND_NODES:
        from .load_balancer import NodePool

        logger.info(
            "Starting in GATEWAY mode with %d backend nodes: %s",
            len(config.BACKEND_NODES),
            config.BACKEND_NODES,
        )
        pool = NodePool(config.BACKEND_NODES)
        await pool.start()
        routes.node_pool = pool
        logger.info("Gateway ready")
    else:
        logger.info(
            "Starting in STANDALONE mode (%s), loading model: %s",
            config.EMBED_BACKEND.upper(),
            config.MODEL_NAME,
        )
        emb = EmbeddingState()
        emb.device = get_device()
        logger.info("Device: %s", emb.device)

        if emb.device == "cpu":
            tune_cpu_threads()

        emb.tokenizer, emb.model = load_embedding_model()

        if config.EMBED_BACKEND != "onnx" and emb.device in ("cuda", "mps"):
            emb.model = emb.model.to(emb.device)
            emb.model.eval()

        # Warmup forward pass
        dummy = emb.tokenizer(
            ["warmup"],
            return_tensors="np" if config.EMBED_BACKEND == "onnx" else "pt",
            truncation=True,
            max_length=config.MAX_LENGTH,
        )
        if config.EMBED_BACKEND != "onnx" and emb.device in ("cuda", "mps"):
            dummy = {k: v.to(emb.device) for k, v in dummy.items()}
        if config.EMBED_BACKEND == "onnx":
            emb.model(**dummy)
        else:
            import torch
            with torch.inference_mode():
                emb.model(**dummy)

        routes.emb_state = emb
        logger.info("Embedding model ready")

        if config.RERANK_ENABLED:
            rnk = RerankerState()
            rnk.tokenizer, rnk.session = await asyncio.to_thread(load_reranker)
            # Warmup reranker
            from .inference import rerank_sync
            await asyncio.to_thread(
                rerank_sync, "warmup query", ["doc one", "doc two"], rnk
            )
            rnk.loaded = True
            routes.reranker_state = rnk
            logger.info("Reranker ready")

    yield

    if routes.node_pool is not None:
        await routes.node_pool.stop()
    logger.info("Embedding service shut down")


app = FastAPI(
    title="Embedding Service",
    version="2.0.0",
    lifespan=lifespan,
)
app.include_router(routes.router)
metrics.setup_metrics(app)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("src.embedding.main:app", host=config.HOST, port=config.PORT, workers=1)
