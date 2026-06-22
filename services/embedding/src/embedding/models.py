from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

from . import config


class EmbedRequest(BaseModel):
    texts: List[str] = Field(
        ...,
        min_length=1,
        max_length=config.MAX_BATCH_SIZE,
        description=f"Texts to embed (max {config.MAX_BATCH_SIZE})",
    )


class EmbedResponse(BaseModel):
    embeddings: List[List[float]]
    took_ms: float
    dimension: int = config.EMBED_DIM


class RerankRequest(BaseModel):
    query: str = Field(..., min_length=1)
    documents: List[str] = Field(
        ...,
        min_length=1,
        max_length=config.RERANK_MAX_CANDIDATES,
        description=f"Documents to rerank (max {config.RERANK_MAX_CANDIDATES})",
    )
    top_n: Optional[int] = Field(None, ge=1)


class RerankResult(BaseModel):
    index: int
    score: float


class RerankResponse(BaseModel):
    results: List[RerankResult]
    took_ms: float


class HealthResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    status: str
    is_loaded: bool
    specter_model: str
    device: str
    in_flight: int = 0
