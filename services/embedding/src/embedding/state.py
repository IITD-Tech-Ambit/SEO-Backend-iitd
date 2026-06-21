import asyncio
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class EmbeddingState:
    model: Any = None
    tokenizer: Any = None
    device: Optional[str] = None
    in_flight: int = 0
    infer_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


@dataclass
class RerankerState:
    session: Any = None
    tokenizer: Any = None
    loaded: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
