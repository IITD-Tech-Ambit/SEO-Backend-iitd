import asyncio
from dataclasses import dataclass, field
from typing import Any, Optional

from . import config


@dataclass
class EmbeddingState:
    model: Any = None
    tokenizer: Any = None
    device: Optional[str] = None
    in_flight: int = 0
    infer_sem: asyncio.Semaphore = field(
        default_factory=lambda: asyncio.Semaphore(config.EMBED_MAX_CONCURRENCY)
    )


@dataclass
class RerankerState:
    session: Any = None
    tokenizer: Any = None
    loaded: bool = False
    sem: asyncio.Semaphore = field(
        default_factory=lambda: asyncio.Semaphore(config.RERANK_MAX_CONCURRENCY)
    )
