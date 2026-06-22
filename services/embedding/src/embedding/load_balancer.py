import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import httpx

from . import config

logger = logging.getLogger(__name__)


def _ema(current: float, new_value: float, alpha: float = 0.3) -> float:
    return new_value if current == 0.0 else alpha * new_value + (1 - alpha) * current


@dataclass
class BackendNode:
    url: str
    healthy: bool = False
    consecutive_failures: int = 0
    avg_response_ms: float = 0.0
    health_rtt_ms: float = 0.0
    circuit_open_until: Optional[datetime] = None
    active_requests: int = 0
    reserved_texts: int = 0
    remote_in_flight: int = 0
    semaphore: asyncio.Semaphore = field(
        default_factory=lambda: asyncio.Semaphore(config.MAX_INFLIGHT_PER_NODE)
    )
    _reservation_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @property
    def is_available(self) -> bool:
        if not self.healthy:
            return False
        if self.circuit_open_until and datetime.now() < self.circuit_open_until:
            return False
        return True

    @property
    def is_half_open(self) -> bool:
        return bool(self.circuit_open_until and datetime.now() >= self.circuit_open_until)

    @property
    def effective_load(self) -> float:
        reserved_norm = self.reserved_texts / max(config.SCATTER_MIN_BATCH, 1)
        extra_remote = max(0, self.remote_in_flight - self.active_requests)
        return self.active_requests + reserved_norm + extra_remote


class NodePool:
    def __init__(self, node_urls: List[str]):
        self.nodes = [BackendNode(url=url.rstrip("/")) for url in node_urls]
        self._client: Optional[httpx.AsyncClient] = None
        self._health_task: Optional[asyncio.Task] = None
        self._rr_index = 0

    async def start(self):
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(config.NODE_TIMEOUT_S, connect=10.0),
            limits=httpx.Limits(
                max_connections=100,
                max_keepalive_connections=len(self.nodes) * 4,
            ),
        )
        await self._run_health_checks()
        self._health_task = asyncio.create_task(self._health_check_loop())
        logger.info(
            "NodePool started: %d nodes, max_inflight_per_node=%d",
            len(self.nodes),
            config.MAX_INFLIGHT_PER_NODE,
        )

    async def stop(self):
        if self._health_task:
            self._health_task.cancel()
            try:
                await self._health_task
            except asyncio.CancelledError:
                pass
        if self._client:
            await self._client.aclose()

    # ── Health checking ──────────────────────────────────────────────

    async def _health_check_loop(self):
        while True:
            await asyncio.sleep(config.HEALTH_CHECK_INTERVAL_S)
            await self._run_health_checks()

    async def _run_health_checks(self):
        await asyncio.gather(
            *(self._check_node(n) for n in self.nodes),
            return_exceptions=True,
        )
        healthy = sum(1 for n in self.nodes if n.healthy)
        logger.debug("Health check: %d/%d nodes healthy", healthy, len(self.nodes))

    async def _check_node(self, node: BackendNode):
        if node.circuit_open_until and datetime.now() < node.circuit_open_until:
            return

        start = time.time()
        try:
            resp = await self._client.get(f"{node.url}/health", timeout=5.0)
            rtt_ms = (time.time() - start) * 1000
            data = resp.json()
            if resp.status_code == 200 and data.get("is_loaded"):
                node.healthy = True
                node.consecutive_failures = 0
                node.circuit_open_until = None
                node.health_rtt_ms = _ema(node.health_rtt_ms, rtt_ms)
                try:
                    node.remote_in_flight = int(data.get("in_flight", 0))
                except (TypeError, ValueError):
                    node.remote_in_flight = 0
            else:
                self._record_failure(node)
        except Exception:
            self._record_failure(node)

    def _record_failure(self, node: BackendNode):
        node.consecutive_failures += 1
        node.healthy = False
        if node.consecutive_failures >= config.CIRCUIT_BREAKER_THRESHOLD:
            node.circuit_open_until = datetime.now() + timedelta(
                seconds=config.CIRCUIT_BREAKER_RECOVERY_S
            )
            logger.warning(
                "Circuit OPEN for %s (failures=%d, recovery in %ds)",
                node.url,
                node.consecutive_failures,
                config.CIRCUIT_BREAKER_RECOVERY_S,
            )

    # ── Capacity scoring ─────────────────────────────────────────────

    def _latency_for_score(self, node: BackendNode) -> float:
        if node.avg_response_ms > 0:
            return max(node.avg_response_ms, config.LATENCY_FLOOR_MS)
        if node.health_rtt_ms > 0:
            return max(node.health_rtt_ms * 4, config.LATENCY_FLOOR_MS)
        return config.LATENCY_FLOOR_MS

    def _capacity_score(self, node: BackendNode) -> float:
        latency = self._latency_for_score(node)
        score = 1.0 / ((1.0 + node.effective_load) * (latency / config.LATENCY_BASE_MS))
        return max(score, 1e-6)

    # ── Node selection ───────────────────────────────────────────────

    def get_available_nodes(self) -> List[BackendNode]:
        return [n for n in self.nodes if n.is_available]

    def get_half_open_nodes(self) -> List[BackendNode]:
        return [n for n in self.nodes if n.is_half_open and not n.is_available]

    def get_healthy_nodes(self) -> List[BackendNode]:
        return self.get_available_nodes() + self.get_half_open_nodes()

    def _pick_by_capacity(self, nodes: List[BackendNode]) -> BackendNode:
        if not nodes:
            raise ValueError("nodes must be non-empty")
        scored = [(self._capacity_score(n), n) for n in nodes]
        max_score = max(s for s, _ in scored)
        tied = [n for s, n in scored if s >= max_score - 1e-9]
        if len(tied) == 1:
            return tied[0]
        pick = tied[self._rr_index % len(tied)]
        self._rr_index += 1
        return pick

    # ── Weighted chunk allocation ────────────────────────────────────

    def _weighted_chunk_sizes(self, num_texts: int, nodes: List[BackendNode]) -> List[int]:
        n = len(nodes)
        if n == 0:
            return []
        if n == 1:
            return [num_texts]

        scores = [self._capacity_score(node) for node in nodes]
        total = sum(scores)
        if total <= 0:
            base, rem = divmod(num_texts, n)
            return [base + (1 if i < rem else 0) for i in range(n)]

        min_w = config.MIN_NODE_WEIGHT / n
        weights = [max(s / total, min_w) for s in scores]
        w_total = sum(weights)
        weights = [w / w_total for w in weights]

        raw = [w * num_texts for w in weights]
        sizes = [int(r) for r in raw]
        remainder = num_texts - sum(sizes)
        if remainder > 0:
            fracs = sorted(
                range(n),
                key=lambda i: (raw[i] - sizes[i], scores[i]),
                reverse=True,
            )
            for i in fracs[:remainder]:
                sizes[i] += 1
        return sizes

    # ── Scatter-gather core ──────────────────────────────────────────

    async def scatter_gather(self, texts: List[str]) -> Dict[str, Any]:
        available = self.get_available_nodes()
        half_open = self.get_half_open_nodes()

        if not available and not half_open:
            raise RuntimeError("No healthy backend nodes available")

        primary_nodes = available if available else half_open
        start_time = time.time()

        if len(texts) < config.SCATTER_MIN_BATCH or len(primary_nodes) == 1:
            return await self._send_chunk(self._pick_by_capacity(primary_nodes), texts)

        sizes = self._weighted_chunk_sizes(len(texts), primary_nodes)

        node_chunks: List[Tuple[BackendNode, List[str]]] = []
        cursor = 0
        for node, size in zip(primary_nodes, sizes):
            if size <= 0:
                continue
            chunk = texts[cursor:cursor + size]
            cursor += size
            async with node._reservation_lock:
                node.reserved_texts += size
            node_chunks.append((node, chunk))

        if available and half_open and len(texts) >= config.SCATTER_MIN_BATCH * 2:
            probe_node = self._pick_by_capacity(half_open)
            probe_size = min(config.HALF_OPEN_PROBE_TEXTS, len(texts) // 4)
            if probe_size > 0 and node_chunks:
                largest_idx = max(range(len(node_chunks)), key=lambda i: len(node_chunks[i][1]))
                victim_node, victim_chunk = node_chunks[largest_idx]
                if len(victim_chunk) > probe_size:
                    async with victim_node._reservation_lock:
                        victim_node.reserved_texts -= probe_size
                    async with probe_node._reservation_lock:
                        probe_node.reserved_texts += probe_size
                    node_chunks[largest_idx] = (victim_node, victim_chunk[:-probe_size])
                    node_chunks.append((probe_node, victim_chunk[-probe_size:]))

        raw_results = await asyncio.gather(
            *(self._send_chunk(node, chunk) for node, chunk in node_chunks),
            return_exceptions=True,
        )

        final_results: List[Any] = list(raw_results)
        for i, result in enumerate(final_results):
            if not isinstance(result, Exception):
                continue
            failed_node, chunk_texts = node_chunks[i]
            retry_pool = [n for n in self.get_available_nodes() if n is not failed_node]
            if not retry_pool:
                retry_pool = [n for n in self.get_healthy_nodes() if n is not failed_node]
            if retry_pool:
                retry_node = self._pick_by_capacity(retry_pool)
                logger.warning(
                    "Chunk %d (%d texts) failed on %s — retrying on %s",
                    i, len(chunk_texts), failed_node.url, retry_node.url,
                )
                async with retry_node._reservation_lock:
                    retry_node.reserved_texts += len(chunk_texts)
                try:
                    final_results[i] = await self._send_chunk(retry_node, chunk_texts)
                except Exception as e:
                    final_results[i] = e

        for i, result in enumerate(final_results):
            if isinstance(result, Exception):
                failed_node, _ = node_chunks[i]
                raise RuntimeError(
                    f"Chunk {i} failed on {failed_node.url} (retry also failed): {result}"
                )

        merged: List[List[float]] = []
        dimension = config.EMBED_DIM
        for result in final_results:
            merged.extend(result["embeddings"])
            dimension = result.get("dimension", config.EMBED_DIM)

        return {
            "embeddings": merged,
            "took_ms": round((time.time() - start_time) * 1000, 1),
            "dimension": dimension,
        }

    # ── HTTP send ────────────────────────────────────────────────────

    async def _send_chunk(self, node: BackendNode, texts: List[str]) -> Dict[str, Any]:
        chunk_size = len(texts)

        if config.NODE_ACQUIRE_TIMEOUT_S > 0:
            try:
                await asyncio.wait_for(
                    node.semaphore.acquire(),
                    timeout=config.NODE_ACQUIRE_TIMEOUT_S,
                )
            except asyncio.TimeoutError:
                async with node._reservation_lock:
                    node.reserved_texts = max(0, node.reserved_texts - chunk_size)
                raise RuntimeError(
                    f"Timed out acquiring slot on {node.url} "
                    f"after {config.NODE_ACQUIRE_TIMEOUT_S}s"
                )
        else:
            await node.semaphore.acquire()

        node.active_requests += 1
        req_start = time.time()
        try:
            resp = await self._client.post(f"{node.url}/embed", json={"texts": texts})
            resp.raise_for_status()
            data = resp.json()

            elapsed_ms = (time.time() - req_start) * 1000
            per_text_ms = elapsed_ms / max(chunk_size, 1)
            node.avg_response_ms = _ema(node.avg_response_ms, per_text_ms)
            node.consecutive_failures = 0
            node.circuit_open_until = None
            return data

        except Exception as e:
            self._record_failure(node)
            logger.error("Request to %s failed: %s", node.url, e)
            raise
        finally:
            node.active_requests -= 1
            async with node._reservation_lock:
                node.reserved_texts = max(0, node.reserved_texts - chunk_size)
            node.semaphore.release()

    # ── Status ───────────────────────────────────────────────────────

    def get_status(self) -> Dict[str, Any]:
        return {
            "nodes_healthy": sum(1 for n in self.nodes if n.is_available),
            "nodes_total": len(self.nodes),
            "max_inflight_per_node": config.MAX_INFLIGHT_PER_NODE,
            "nodes": [
                {
                    "url": n.url,
                    "healthy": n.is_available,
                    "avg_response_ms_per_text": round(n.avg_response_ms, 2),
                    "health_rtt_ms": round(n.health_rtt_ms, 1),
                    "active_requests": n.active_requests,
                    "reserved_texts": n.reserved_texts,
                    "remote_in_flight": n.remote_in_flight,
                    "effective_load": round(n.effective_load, 2),
                    "capacity_score": round(self._capacity_score(n), 3) if n.is_available else 0.0,
                    "consecutive_failures": n.consecutive_failures,
                    "circuit_open": bool(
                        n.circuit_open_until and datetime.now() < n.circuit_open_until
                    ),
                }
                for n in self.nodes
            ],
        }
