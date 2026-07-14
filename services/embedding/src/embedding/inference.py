import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator, Callable, List, TypeVar

import numpy as np

from . import config
from .state import EmbeddingState, RerankerState

T = TypeVar("T")


def _pool_normalize(hidden: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    hidden = np.asarray(hidden, dtype=np.float32)
    mask = np.asarray(attention_mask, dtype=np.float32)

    if config.POOLING == "mean":
        mask_expanded = mask[:, :, np.newaxis]
        summed = (hidden * mask_expanded).sum(axis=1)
        counts = mask_expanded.sum(axis=1).clip(min=1e-9)
        embeddings = summed / counts
    else:
        embeddings = hidden[:, 0]

    if config.NORMALIZE:
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True).clip(min=1e-9)
        embeddings = embeddings / norms

    return embeddings


def _sub_batches(items: list, size: int) -> List[list]:
    return [items[i:i + size] for i in range(0, len(items), size)]


@asynccontextmanager
async def track_inflight(state: EmbeddingState) -> AsyncIterator[None]:
    state.in_flight += 1
    try:
        yield
    finally:
        state.in_flight -= 1


def encode(texts: List[str], state: EmbeddingState) -> List[List[float]]:
    sub = max(1, config.EMBED_SUB_BATCH)
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    results: list = [None] * len(texts)

    is_onnx = config.EMBED_BACKEND == "onnx"

    for batch_indices in _sub_batches(order, sub):
        batch = [texts[i] for i in batch_indices]

        inputs = state.tokenizer(
            batch, padding=True, truncation=True,
            max_length=config.MAX_LENGTH,
            return_tensors="np" if is_onnx else "pt",
        )

        if is_onnx:
            outputs = state.model(**inputs)
            hidden = outputs.last_hidden_state
            mask = inputs["attention_mask"]
            embeddings = _pool_normalize(hidden, mask)
        else:
            import torch

            if state.device in ("cuda", "mps"):
                inputs = {k: v.to(state.device) for k, v in inputs.items()}
            with torch.inference_mode():
                outputs = state.model(**inputs)
            hidden = outputs.last_hidden_state.cpu().float().numpy()
            mask = inputs["attention_mask"].cpu().float().numpy()
            embeddings = _pool_normalize(hidden, mask)

        for j, orig_idx in enumerate(batch_indices):
            results[orig_idx] = embeddings[j].tolist()

    return results


def rerank_sync(query: str, documents: List[str], state: RerankerState) -> List[float]:
    sub = max(1, config.RERANK_SUB_BATCH)
    all_scores: List[float] = []

    for batch_docs in _sub_batches(documents, sub):
        pairs = [[query, doc] for doc in batch_docs]
        inputs = state.tokenizer(
            pairs, padding=True, truncation=True,
            max_length=config.RERANK_MAX_LENGTH,
            return_tensors="np",
        )
        outputs = state.session(**inputs)
        logits = np.asarray(outputs.logits).squeeze(-1)
        scores = logits.tolist()
        if isinstance(scores, float):
            scores = [scores]
        all_scores.extend(scores)

    return all_scores


class InferenceQueueTimeout(Exception):
    """Raised when a request waits too long for a free inference slot.

    Distinct from the old pattern of wrapping the inference call itself in
    asyncio.wait_for: asyncio.to_thread runs on a real OS thread, which
    Python cannot forcibly cancel. Timing out the *call* left the "cancelled"
    work running in the background while the lock/semaphore slot it held was
    already released to the next request - the exact race the lock existed
    to prevent. Timing out the *wait for a slot* instead means nothing has
    started yet when we give up, so there's nothing left running.
    """


async def _acquire_or_timeout(sem: asyncio.Semaphore, timeout: float) -> None:
    try:
        await asyncio.wait_for(sem.acquire(), timeout=timeout)
    except asyncio.TimeoutError as e:
        raise InferenceQueueTimeout(
            f"timed out after {timeout}s waiting for a free inference slot"
        ) from e


async def run_embed(texts: List[str], state: EmbeddingState) -> List[List[float]]:
    await _acquire_or_timeout(state.infer_sem, config.INFER_QUEUE_TIMEOUT_S)
    try:
        return await asyncio.to_thread(encode, texts, state)
    finally:
        state.infer_sem.release()


async def run_rerank(
    query: str, documents: List[str], state: RerankerState
) -> List[float]:
    await _acquire_or_timeout(state.sem, config.INFER_QUEUE_TIMEOUT_S)
    try:
        return await asyncio.to_thread(rerank_sync, query, documents, state)
    finally:
        state.sem.release()
