"""
Dynamic load balancer for the embedding service gateway.

When BACKEND_NODES is configured, the gateway distributes a batch of texts
across healthy GPU nodes proportional to each node's live spare capacity:

  capacity_score = 1 / ((1 + effective_load) * (latency / LATENCY_BASE_MS))

where:
  - effective_load  = active_requests + reserved_texts / SCATTER_MIN_BATCH
  - latency         = EMA of observed /embed response time (ms), with a floor
                      so cold nodes start at neutral weight

This replaces the previous static equal split (N / num_nodes). Per-node
asyncio.Semaphore caps in-flight requests so concurrent gateway calls do not
collectively overload a slow backend (e.g. an M2 Air paired with an i7).

Standalone mode is unaffected: when BACKEND_NODES is empty, main.py loads the
model locally and this module is never imported.
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import httpx

from . import config

logger = logging.getLogger(__name__)


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
    # Backend-reported in-flight count from /health (captures load from other
    # gateways/clients hitting the same backend). 0 if backend does not report it.
    remote_in_flight: int = 0
    semaphore: asyncio.Semaphore = field(
        default_factory=lambda: asyncio.Semaphore(config.MAX_INFLIGHT_PER_NODE)
    )

    @property
    def is_available(self) -> bool:
        if not self.healthy:
            return False
        if self.circuit_open_until and datetime.now() < self.circuit_open_until:
            return False
        return True

    @property
    def is_half_open(self) -> bool:
        """Circuit was open but recovery period has passed -- allow a probe."""
        if self.circuit_open_until and datetime.now() >= self.circuit_open_until:
            return True
        return False

    @property
    def effective_load(self) -> float:
        """Combined live load.

        Includes:
          - active_requests: in-flight from this gateway
          - reserved_texts (normalized): assigned chunks not yet sent
          - remote_in_flight: backend-reported concurrent requests from any client
            (only the portion not already accounted for locally)
        """
        reserved_norm = self.reserved_texts / max(config.SCATTER_MIN_BATCH, 1)
        # Avoid double-counting our own in-flight requests against the backend's report.
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
            "NodePool started with %d nodes: %s (max_inflight_per_node=%d)",
            len(self.nodes),
            [n.url for n in self.nodes],
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
        logger.info("NodePool stopped")

    # ── Health checking ──────────────────────────────────────────────

    async def _health_check_loop(self):
        while True:
            await asyncio.sleep(config.HEALTH_CHECK_INTERVAL_S)
            await self._run_health_checks()

    async def _run_health_checks(self):
        await asyncio.gather(
            *(self._check_node(node) for node in self.nodes),
            return_exceptions=True,
        )
        healthy_count = sum(1 for n in self.nodes if n.healthy)
        logger.debug(
            "Health check complete: %d/%d nodes healthy", healthy_count, len(self.nodes)
        )

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
                # EMA of health probe latency (weak capacity hint for cold nodes)
                alpha = 0.3
                node.health_rtt_ms = (
                    alpha * rtt_ms + (1 - alpha) * node.health_rtt_ms
                    if node.health_rtt_ms
                    else rtt_ms
                )
                # Optional backend-reported load (only present on standalone backends
                # that expose it; missing field => 0, no behavior change).
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
        if node.consecutive_failures >= config.CIRCUIT_BREAKER_THRESHOLD:
            node.healthy = False
            node.circuit_open_until = datetime.now() + timedelta(
                seconds=config.CIRCUIT_BREAKER_RECOVERY_S
            )
            logger.warning(
                "Circuit OPEN for %s (failures=%d, recovery in %ds)",
                node.url,
                node.consecutive_failures,
                config.CIRCUIT_BREAKER_RECOVERY_S,
            )
        else:
            node.healthy = False

    # ── Capacity scoring ─────────────────────────────────────────────

    def _latency_for_score(self, node: BackendNode) -> float:
        """Use observed /embed EMA; fall back to health-probe RTT; then floor."""
        if node.avg_response_ms > 0:
            return max(node.avg_response_ms, config.LATENCY_FLOOR_MS)
        if node.health_rtt_ms > 0:
            # Health probes are cheap; treat as weak signal (scale up).
            return max(node.health_rtt_ms * 4, config.LATENCY_FLOOR_MS)
        return config.LATENCY_FLOOR_MS

    def _capacity_score(self, node: BackendNode) -> float:
        """Higher = more spare capacity. Drives weighted scatter and node picking."""
        latency = self._latency_for_score(node)
        inflight_factor = 1.0 + node.effective_load
        score = 1.0 / (inflight_factor * (latency / config.LATENCY_BASE_MS))
        return max(score, 1e-6)

    # ── Node selection ───────────────────────────────────────────────

    def get_available_nodes(self) -> List[BackendNode]:
        """Fully healthy nodes (circuit closed)."""
        return [n for n in self.nodes if n.is_available]

    def get_half_open_nodes(self) -> List[BackendNode]:
        return [n for n in self.nodes if n.is_half_open and not n.is_available]

    def get_healthy_nodes(self) -> List[BackendNode]:
        """Available + half-open. Kept for backward compatibility."""
        return self.get_available_nodes() + self.get_half_open_nodes()

    def _pick_by_capacity(self, nodes: List[BackendNode]) -> BackendNode:
        """Pick the node with highest capacity score; round-robin on ties."""
        if not nodes:
            raise ValueError("nodes must be non-empty")
        scored = [(self._capacity_score(n), n) for n in nodes]
        max_score = max(s for s, _ in scored)
        # Use a small epsilon so floating-point ties are detected.
        tied = [n for s, n in scored if s >= max_score - 1e-9]
        if len(tied) == 1:
            return tied[0]
        pick = tied[self._rr_index % len(tied)]
        self._rr_index += 1
        return pick

    # ── Weighted chunk allocation ────────────────────────────────────

    def _weighted_chunk_sizes(
        self, num_texts: int, nodes: List[BackendNode]
    ) -> List[int]:
        """Allocate `num_texts` across nodes proportional to capacity score.

        Guarantees:
          - sum(sizes) == num_texts
          - every node gets at least floor(MIN_NODE_WEIGHT * num_texts / n) ... but
            sizes can be 0 if num_texts is very small (caller falls back to single-node)
        """
        n = len(nodes)
        if n == 0:
            return []
        if n == 1:
            return [num_texts]

        scores = [self._capacity_score(node) for node in nodes]
        total = sum(scores)
        if total <= 0:
            # Degenerate: fall back to equal split
            base, rem = divmod(num_texts, n)
            return [base + (1 if i < rem else 0) for i in range(n)]

        # Apply minimum-weight floor so a slow node still participates and keeps
        # its latency EMA fresh (otherwise it never gets traffic to re-measure).
        min_w = config.MIN_NODE_WEIGHT / n
        weights = [max(s / total, min_w) for s in scores]
        w_total = sum(weights)
        weights = [w / w_total for w in weights]

        # Largest-remainder method: keeps integer sizes summing to num_texts.
        raw = [w * num_texts for w in weights]
        sizes = [int(r) for r in raw]
        remainder = num_texts - sum(sizes)
        if remainder > 0:
            # Distribute remainder to nodes with the largest fractional parts,
            # breaking ties by capacity score (highest first).
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

        # Prefer fully-available nodes. Fall back to half-open probes only if
        # nothing else is up (true emergency).
        if not available and not half_open:
            raise httpx.HTTPStatusError(
                "No healthy backend nodes available",
                request=httpx.Request("POST", "/embed"),
                response=httpx.Response(503),
            )

        primary_nodes = available if available else half_open
        start_time = time.time()

        # Small batch or single node -> capacity-based single pick (no scatter)
        if len(texts) < config.SCATTER_MIN_BATCH or len(primary_nodes) == 1:
            node = self._pick_by_capacity(primary_nodes)
            result = await self._send_chunk(node, texts)
            return result

        # Compute weighted sizes and greedily assign, reserving load as we go.
        sizes = self._weighted_chunk_sizes(len(texts), primary_nodes)

        # Build (node, size) assignments. Skip zero-size nodes; the remainder
        # logic ensures non-zero totals, but defensive.
        node_chunks: List[Tuple[BackendNode, List[str]]] = []
        cursor = 0
        for node, size in zip(primary_nodes, sizes):
            if size <= 0:
                continue
            chunk = texts[cursor:cursor + size]
            cursor += size
            node.reserved_texts += size  # reserve before await so concurrent calls see it
            node_chunks.append((node, chunk))

        # Optionally include a half-open probe alongside available nodes.
        # Only when we have fully-available primaries (otherwise primary_nodes IS half-open).
        if available and half_open and len(texts) >= config.SCATTER_MIN_BATCH * 2:
            probe_node = self._pick_by_capacity(half_open)
            probe_size = min(config.HALF_OPEN_PROBE_TEXTS, len(texts) // 4)
            if probe_size > 0 and node_chunks:
                # Steal from the largest assignment to keep total constant.
                largest_idx = max(range(len(node_chunks)), key=lambda i: len(node_chunks[i][1]))
                victim_node, victim_chunk = node_chunks[largest_idx]
                if len(victim_chunk) > probe_size:
                    probe_chunk = victim_chunk[-probe_size:]
                    new_victim = victim_chunk[:-probe_size]
                    victim_node.reserved_texts -= probe_size
                    node_chunks[largest_idx] = (victim_node, new_victim)
                    probe_node.reserved_texts += probe_size
                    node_chunks.append((probe_node, probe_chunk))

        raw_results = await asyncio.gather(
            *(self._send_chunk(node, chunk) for node, chunk in node_chunks),
            return_exceptions=True,
        )

        # Retry failed chunks on healthier nodes (excluding the failed one).
        final_results: List[Any] = list(raw_results)
        for i, result in enumerate(final_results):
            if isinstance(result, Exception):
                failed_node, chunk_texts = node_chunks[i]
                retry_pool = [
                    n
                    for n in self.get_available_nodes()
                    if n is not failed_node
                ]
                if not retry_pool:
                    # Last resort: any healthy node other than the failed one
                    retry_pool = [
                        n
                        for n in self.get_healthy_nodes()
                        if n is not failed_node
                    ]
                if retry_pool:
                    retry_node = self._pick_by_capacity(retry_pool)
                    logger.warning(
                        "Chunk %d (%d texts) failed on %s, retrying on %s",
                        i, len(chunk_texts), failed_node.url, retry_node.url,
                    )
                    retry_node.reserved_texts += len(chunk_texts)
                    try:
                        final_results[i] = await self._send_chunk(retry_node, chunk_texts)
                    except Exception as e:
                        final_results[i] = e

        # Surface any remaining failures.
        for i, result in enumerate(final_results):
            if isinstance(result, Exception):
                failed_node, _ = node_chunks[i]
                raise RuntimeError(
                    f"Chunk {i} failed on {failed_node.url} and retry also failed: {result}"
                )

        merged_embeddings: List[List[float]] = []
        dimension = config.EMBED_DIM
        for result in final_results:
            merged_embeddings.extend(result["embeddings"])
            dimension = result.get("dimension", config.EMBED_DIM)

        took_ms = (time.time() - start_time) * 1000
        return {
            "embeddings": merged_embeddings,
            "took_ms": round(took_ms, 1),
            "dimension": dimension,
        }

    # ── HTTP send with semaphore + EMA update ────────────────────────

    async def _send_chunk(self, node: BackendNode, texts: List[str]) -> Dict[str, Any]:
        chunk_size = len(texts)
        # Acquire per-node semaphore so concurrent gateway calls cannot pile
        # more than MAX_INFLIGHT_PER_NODE requests onto a single backend.
        if config.NODE_ACQUIRE_TIMEOUT_S > 0:
            try:
                await asyncio.wait_for(
                    node.semaphore.acquire(),
                    timeout=config.NODE_ACQUIRE_TIMEOUT_S,
                )
            except asyncio.TimeoutError:
                node.reserved_texts = max(0, node.reserved_texts - chunk_size)
                raise RuntimeError(
                    f"Timed out acquiring slot on {node.url} after "
                    f"{config.NODE_ACQUIRE_TIMEOUT_S}s"
                )
        else:
            await node.semaphore.acquire()

        node.active_requests += 1
        req_start = time.time()
        try:
            resp = await self._client.post(
                f"{node.url}/embed",
                json={"texts": texts},
            )
            resp.raise_for_status()
            data = resp.json()

            elapsed_ms = (time.time() - req_start) * 1000
            # EMA on per-text latency to make capacity score comparable across
            # nodes that get different chunk sizes.
            per_text_ms = elapsed_ms / max(chunk_size, 1)
            alpha = 0.3
            if node.avg_response_ms == 0:
                node.avg_response_ms = per_text_ms
            else:
                node.avg_response_ms = (
                    alpha * per_text_ms + (1 - alpha) * node.avg_response_ms
                )
            node.consecutive_failures = 0
            node.circuit_open_until = None
            return data

        except Exception as e:
            self._record_failure(node)
            logger.error("Request to %s failed: %s", node.url, e)
            raise
        finally:
            node.active_requests -= 1
            node.reserved_texts = max(0, node.reserved_texts - chunk_size)
            node.semaphore.release()

    # ── Status for health endpoint ───────────────────────────────────

    def get_status(self) -> Dict[str, Any]:
        healthy_nodes = [n for n in self.nodes if n.is_available]
        return {
            "nodes_healthy": len(healthy_nodes),
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
                    "capacity_score": round(self._capacity_score(n), 3)
                    if n.is_available
                    else 0.0,
                    "consecutive_failures": n.consecutive_failures,
                    "circuit_open": n.circuit_open_until is not None
                    and datetime.now() < n.circuit_open_until,
                }
                for n in self.nodes
            ],
        }
