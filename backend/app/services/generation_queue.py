"""
Durable-ish generation queue with Redis (preferred) and in-process fallback.

All article content/image generation should pass through :func:`generation_slot`
so OpenAI + Mongo writes stay bounded under load.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from app.core.config import settings

log = logging.getLogger(__name__)

QUEUE_KEY = "aa:generation:queue"
DEDUP_PREFIX = "aa:generation:dedup:"
DEDUP_TTL_SECONDS = 20 * 60  # 20 minutes — generation takes at most ~5 min; short TTL prevents hours-long lockouts after container restarts


class GenerationJobKind(str, Enum):
    SCHEDULED_PREP = "scheduled_prep"
    SCHEDULED_POST_NOW = "scheduled_post_now"
    ARTICLE_GENERATE = "article_generate"
    IMAGE_REGENERATE = "image_regenerate"
    CLUSTER_GENERATE_ALL = "cluster_generate_all"
    TOPIC_CLUSTER_PLAN = "topic_cluster_plan"
    RESEARCH_IDEAS = "research_ideas"


@dataclass
class GenerationJob:
    kind: GenerationJobKind
    payload: dict[str, Any]
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    enqueued_at: float = field(default_factory=time.time)

    def to_json(self) -> str:
        return json.dumps(
            {
                "id": self.id,
                "kind": self.kind.value,
                "payload": self.payload,
                "enqueued_at": self.enqueued_at,
            },
            separators=(",", ":"),
        )

    @classmethod
    def from_json(cls, raw: str) -> GenerationJob | None:
        try:
            data = json.loads(raw)
            if not isinstance(data, dict):
                return None
            kind = GenerationJobKind(str(data.get("kind") or "").strip())
            payload = data.get("payload")
            if not isinstance(payload, dict):
                payload = {}
            return cls(
                id=str(data.get("id") or uuid.uuid4().hex),
                kind=kind,
                payload=payload,
                enqueued_at=float(data.get("enqueued_at") or time.time()),
            )
        except Exception:
            return None


_semaphore: asyncio.Semaphore | None = None
_local_job_queue: asyncio.Queue[GenerationJob] | None = None
_redis_client: Any | None = None
_redis_unavailable = False


def get_generation_semaphore() -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        n = max(1, int(settings.max_concurrent_generations or 3))
        _semaphore = asyncio.Semaphore(n)
    return _semaphore


@asynccontextmanager
async def generation_slot():
    """Limit concurrent OpenAI + persistence work (shared by API routes and worker)."""
    sem = get_generation_semaphore()
    await sem.acquire()
    try:
        yield
    finally:
        sem.release()


def _get_local_job_queue() -> asyncio.Queue[GenerationJob]:
    global _local_job_queue
    if _local_job_queue is None:
        _local_job_queue = asyncio.Queue(maxsize=5000)
    return _local_job_queue


def _redis():
    global _redis_client, _redis_unavailable
    if _redis_unavailable:
        return None
    if _redis_client is not None:
        return _redis_client
    try:
        import redis.asyncio as redis_async

        _redis_client = redis_async.from_url(
            (settings.redis_url or "").strip() or "redis://localhost:6379/0",
            decode_responses=True,
            socket_connect_timeout=2.0,
            socket_timeout=5.0,
        )
        return _redis_client
    except Exception as e:
        _redis_unavailable = True
        log.warning("Redis unavailable for generation queue; using in-process queue only: %s", e)
        return None


async def _set_dedup(dedup_key: str | None) -> bool:
    """Return True if this enqueue won the dedup race (False = duplicate skipped)."""
    if not dedup_key:
        return True
    key = f"{DEDUP_PREFIX}{dedup_key}"
    r = _redis()
    if r is not None:
        try:
            ok = await r.set(key, "1", nx=True, ex=DEDUP_TTL_SECONDS)
            return bool(ok)
        except Exception:
            pass
    # In-process: module-level set guarded by lock
    if not hasattr(_set_dedup, "_keys"):
        _set_dedup._keys = set()  # type: ignore[attr-defined]
    keys: set[str] = _set_dedup._keys  # type: ignore[attr-defined]
    if dedup_key in keys:
        return False
    keys.add(dedup_key)
    return True


async def clear_dedup(dedup_key: str | None) -> None:
    if not dedup_key:
        return
    key = f"{DEDUP_PREFIX}{dedup_key}"
    r = _redis()
    if r is not None:
        try:
            await r.delete(key)
        except Exception:
            pass
    if hasattr(_set_dedup, "_keys"):
        _set_dedup._keys.discard(dedup_key)  # type: ignore[attr-defined]


async def enqueue(job: GenerationJob, *, dedup_key: str | None = None) -> str | None:
    """
    Enqueue a generation job. Returns job id, or None if skipped as duplicate.
    """
    if not await _set_dedup(dedup_key):
        return None
    body = job.to_json()
    r = _redis()
    if r is not None:
        try:
            await r.lpush(QUEUE_KEY, body)
            return job.id
        except Exception as e:
            log.warning("Redis LPUSH failed; falling back to local queue: %s", e)
    try:
        _get_local_job_queue().put_nowait(job)
        return job.id
    except asyncio.QueueFull:
        await clear_dedup(dedup_key)
        raise RuntimeError("Generation queue is full; try again shortly.") from None


async def dequeue_blocking(*, timeout_seconds: float = 1.0) -> GenerationJob | None:
    """Worker: block until a job is available."""
    r = _redis()
    if r is not None:
        try:
            item = await r.brpop(QUEUE_KEY, timeout=max(1, int(timeout_seconds)))
            if item and len(item) >= 2:
                job = GenerationJob.from_json(item[1])
                if job:
                    return job
        except Exception as e:
            log.debug("Redis BRPOP failed: %s", e)
    try:
        return await asyncio.wait_for(_get_local_job_queue().get(), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        return None


async def queue_depth() -> int:
    r = _redis()
    if r is not None:
        try:
            n = await r.llen(QUEUE_KEY)
            return int(n or 0)
        except Exception:
            pass
    return _get_local_job_queue().qsize()


async def close_redis() -> None:
    global _redis_client
    if _redis_client is not None:
        try:
            await _redis_client.aclose()
        except Exception:
            pass
        _redis_client = None


def get_async_redis():
    """Shared asyncio Redis client for queue + pipeline SSE pub/sub."""
    return _redis()
