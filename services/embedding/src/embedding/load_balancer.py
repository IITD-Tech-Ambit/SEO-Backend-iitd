"""
Load balancer with scatter-gather batch splitting for the embedding service.

When BACKEND_NODES is configured, the gateway splits large batches across all
healthy GPU nodes in parallel and merges the results back in order.
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import httpx

from . import config

logger = logging.getLogger(__name__)


@dataclass
class BackendNode:
    url: str
    healthy: bool = False
    consecutive_failures: int = 0
    avg_response_ms: float = 0.0
    circuit_open_until: Optional[datetime] = None
    active_requests: int = 0

    @property
    def is_available(self) -> bool:
        if not self.healthy:
            return False
        if self.circuit_open_until and datetime.now() < self.circuit_open_until:
            return False
        return True

    @property
    def is_half_open(self) -> bool:
        """Circuit was open but recovery period has passed -- allow one probe."""
        if self.circuit_open_until and datetime.now() >= self.circuit_open_until:
            return True
        return False


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
            "NodePool started with %d nodes: %s",
            len(self.nodes),
            [n.url for n in self.nodes],
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
        results = await asyncio.gather(
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

        try:
            resp = await self._client.get(f"{node.url}/health", timeout=5.0)
            data = resp.json()
            if resp.status_code == 200 and data.get("is_loaded"):
                node.healthy = True
                node.consecutive_failures = 0
                node.circuit_open_until = None
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

    # ── Node selection ───────────────────────────────────────────────

    def get_healthy_nodes(self) -> List[BackendNode]:
        available = [n for n in self.nodes if n.is_available]
        half_open = [n for n in self.nodes if n.is_half_open and n not in available]
        return available + half_open

    def _pick_least_busy(self, nodes: List[BackendNode]) -> BackendNode:
        return min(nodes, key=lambda n: n.active_requests)

    # ── Scatter-gather core ──────────────────────────────────────────

    async def scatter_gather(self, texts: List[str]) -> Dict[str, Any]:
        healthy = self.get_healthy_nodes()
        if not healthy:
            raise httpx.HTTPStatusError(
                "No healthy backend nodes available",
                request=httpx.Request("POST", "/embed"),
                response=httpx.Response(503),
            )

        start_time = time.time()

        if len(texts) < config.SCATTER_MIN_BATCH or len(healthy) == 1:
            node = self._pick_least_busy(healthy)
            result = await self._send_chunk(node, texts)
            return result

        chunks = self._split_texts(texts, len(healthy))
        assignments = list(zip(healthy, chunks))

        raw_results = await asyncio.gather(
            *(self._send_chunk(node, chunk) for node, chunk in assignments),
            return_exceptions=True,
        )

        # Retry failed chunks on other healthy nodes
        final_results: List[Optional[Dict]] = list(raw_results)
        for i, result in enumerate(final_results):
            if isinstance(result, Exception):
                failed_node = assignments[i][0]
                chunk_texts = assignments[i][1]
                retry_nodes = [n for n in self.get_healthy_nodes() if n is not failed_node]
                if retry_nodes:
                    retry_node = self._pick_least_busy(retry_nodes)
                    logger.warning(
                        "Chunk %d failed on %s, retrying on %s",
                        i, failed_node.url, retry_node.url,
                    )
                    try:
                        final_results[i] = await self._send_chunk(retry_node, chunk_texts)
                    except Exception as e:
                        final_results[i] = e

        # Check for any remaining failures
        for i, result in enumerate(final_results):
            if isinstance(result, Exception):
                failed_node = assignments[i][0]
                raise RuntimeError(
                    f"Chunk {i} failed on {failed_node.url} and retry also failed: {result}"
                )

        merged_embeddings = []
        dimension = 768
        for result in final_results:
            merged_embeddings.extend(result["embeddings"])
            dimension = result.get("dimension", 768)

        took_ms = (time.time() - start_time) * 1000
        return {
            "embeddings": merged_embeddings,
            "took_ms": round(took_ms, 1),
            "dimension": dimension,
        }

    def _split_texts(self, texts: List[str], n_chunks: int) -> List[List[str]]:
        chunk_size, remainder = divmod(len(texts), n_chunks)
        chunks = []
        start = 0
        for i in range(n_chunks):
            end = start + chunk_size + (1 if i < remainder else 0)
            chunks.append(texts[start:end])
            start = end
        return chunks

    async def _send_chunk(self, node: BackendNode, texts: List[str]) -> Dict[str, Any]:
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
            # Exponential moving average of response time
            alpha = 0.3
            node.avg_response_ms = (
                alpha * elapsed_ms + (1 - alpha) * node.avg_response_ms
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

    # ── Status for health endpoint ───────────────────────────────────

    def get_status(self) -> Dict[str, Any]:
        healthy_nodes = [n for n in self.nodes if n.is_available]
        return {
            "nodes_healthy": len(healthy_nodes),
            "nodes_total": len(self.nodes),
            "nodes": [
                {
                    "url": n.url,
                    "healthy": n.is_available,
                    "avg_response_ms": round(n.avg_response_ms, 1),
                    "active_requests": n.active_requests,
                    "consecutive_failures": n.consecutive_failures,
                    "circuit_open": n.circuit_open_until is not None
                    and datetime.now() < n.circuit_open_until,
                }
                for n in self.nodes
            ],
        }
