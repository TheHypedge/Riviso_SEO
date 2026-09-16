"""
Background AI Citation Tracking check worker.

Runs in a dedicated worker container (ENABLE_AI_CITATION_WORKER=1), disabled
elsewhere -- mirrors seo_crawl_worker.py's atomic-claim poll-loop shape for
claiming, and generation_worker.py's fan-out shape for throughput: the loop
claims a cell and immediately spawns a task for it rather than awaiting each
cell to completion before claiming the next one (a run can be dozens of
cells; processing them strictly one-at-a-time is what made a real check run
blow past the frontend's poll ceiling). Actual concurrency is bounded by a
semaphore acquired inside the task, not by the claim loop -- same split
generation_slot()/generation_worker_loop() uses.

Also has a per-engine Redis rate-limit budget copied from serp_index.py's
pattern (each external engine has its own budget key so one engine's traffic
can't starve or exhaust another's, and the AI Overview scraper -- the
riskiest, most block-prone engine -- gets its own conservative, isolated
budget so a block there can't degrade the other engines or the unrelated
organic-SERP scraper serp_index.py already relies on).
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any

from app.core.config import settings
from app.legacy.storage import get_legacy_storage_module
from app.services.ai_citation.runner import run_cell
from app.services.storage_db import call_storage
from app.services.to_thread import run_sync

log = logging.getLogger(__name__)

_RATE_LIMIT_KEY_PREFIX = "aa:ai_citation:rl"
_ENGINE_WINDOW_BUDGET = {
    "chatgpt": 20,
    "perplexity": 10,
    "gemini": 10,
    "google_ai_overview": 5,  # most conservative: newest/most block-prone target, own isolated budget
}
_DEFAULT_WINDOW_BUDGET = 5

_redis_client: Any | None = None
_redis_unavailable = False
_semaphore: asyncio.Semaphore | None = None
_inflight_tasks: set[asyncio.Task] = set()


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
        log.warning("Redis unavailable for ai_citation rate limiter; checks are unthrottled: %s", e)
        return None


async def _engine_budget_available(engine: str) -> bool:
    r = _redis()
    if r is None:
        return True  # no Redis -> no cross-process coordination possible; don't block
    budget = _ENGINE_WINDOW_BUDGET.get(engine, _DEFAULT_WINDOW_BUDGET)
    try:
        window = int(time.time() // 60)
        key = f"{_RATE_LIMIT_KEY_PREFIX}:{engine}:{window}"
        count = await r.incr(key)
        if count == 1:
            await r.expire(key, 90)
        return int(count) <= budget
    except Exception:
        return True


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


async def _storage(fn, /, *args, **kwargs):
    return await run_sync(call_storage, fn, *args, **kwargs)


def _get_semaphore() -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(max(1, int(settings.ai_citation_max_concurrent_checks or 5)))
    return _semaphore


async def _process_claimed_cell(st, claimed: dict) -> None:
    """Runs as its own task (fan-out) -- actual concurrency is bounded by the
    semaphore acquired here, not by the claim loop."""
    async with _get_semaphore():
        engine = (claimed.get("engine") or "").strip()
        if not await _engine_budget_available(engine):
            # Skip this tick for a rate-limited engine -- put the cell back so a
            # different engine's cells (or this one, next minute) get a turn.
            await _storage(st.update_ai_citation_check_fields, claimed["id"], {"status": "queued", "started_at": None})
            return
        try:
            proj = await _storage(st.get_project_by_id, claimed.get("project_id"))
            fields = await run_cell(claimed, proj or {})
            await _storage(st.update_ai_citation_check_fields, claimed["id"], fields)
        except Exception as e:
            log.warning("ai_citation_worker: cell %s failed: %s", claimed.get("id"), e)
            await _storage(st.update_ai_citation_check_fields, claimed["id"], {"status": "failed", "completed_at": _now_iso(), "error": str(e)})


async def ai_citation_check_loop(*, poll_seconds: float = 1.0) -> None:
    """In-process loop; run only inside the dedicated ai-citation worker container."""
    consecutive_failures = 0
    while True:
        claimed = None
        try:
            st = get_legacy_storage_module()
            claimed = await _storage(st.claim_next_queued_ai_citation_check, _now_iso())
            if claimed:
                task = asyncio.create_task(_process_claimed_cell(st, claimed))
                _inflight_tasks.add(task)
                task.add_done_callback(_inflight_tasks.discard)
            consecutive_failures = 0
        except asyncio.CancelledError:
            raise
        except Exception as e:
            consecutive_failures += 1
            log.warning("ai_citation_worker cycle failed (failures=%s): %s", consecutive_failures, e)

        if claimed:
            continue  # immediately check for another queued cell -- don't wait on the task just spawned
        delay = poll_seconds if consecutive_failures == 0 else min(120.0, poll_seconds * (2 ** min(consecutive_failures, 4)))
        await asyncio.sleep(delay)
