"""
Shared cross-project SERP index (Phase A of the keyword/SERP index plan).

``get_or_fetch_serp`` is the single entry point both live user-triggered research/cluster
routes and the background ``serp_refresh_worker`` call: a fresh-enough hit serves instantly
from ``storage.serp_index``; a miss or stale entry does a real live scrape
(``research_scraper.py``, unchanged) and writes the result back, so any real search anyone
does anywhere in the system permanently enriches the shared index for everyone else.

This does not replace ``research_cache`` (per-request-signature response cache) or
``research_serp`` (per-project history fed back into the LLM as context) -- both keep working
exactly as before. This module only changes where the live SERP fetch itself comes from.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from app.core.config import settings
from app.legacy.storage import get_legacy_storage_module
from app.services.research_scraper import SerpExtract, extract_serp, fetch_google_serp_html

log = logging.getLogger(__name__)

_DEFAULT_MAX_AGE_DAYS = 14

# Shared per-minute budget so the background bulk worker can never starve interactive
# live requests: live fetches always proceed (a user is waiting); bulk checks the same
# counter and skips its tick once the window is busy enough that headroom is thin.
_RATE_LIMIT_KEY = "aa:serp_index:rl"
_RATE_LIMIT_WINDOW_BUDGET = 40
_BULK_MAX_SHARE = 10  # bulk backs off once this many fetches (live or bulk) already happened this minute

_redis_client: Any | None = None
_redis_unavailable = False


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
        log.warning("Redis unavailable for serp_index rate limiter; scrapes are unthrottled: %s", e)
        return None


def _normalize_query(q: str) -> str:
    return " ".join((q or "").strip().split()).casefold()[:200]


async def _record_fetch_and_get_count() -> int:
    """Increment the shared per-minute fetch counter; returns the count including this fetch."""
    r = _redis()
    if r is None:
        return 0
    try:
        window = int(time.time() // 60)
        key = f"{_RATE_LIMIT_KEY}:{window}"
        count = await r.incr(key)
        if count == 1:
            await r.expire(key, 90)
        return int(count)
    except Exception:
        return 0


async def _bulk_may_proceed() -> bool:
    r = _redis()
    if r is None:
        return True  # no Redis -> no cross-process coordination possible; don't block bulk
    try:
        window = int(time.time() // 60)
        key = f"{_RATE_LIMIT_KEY}:{window}"
        current = await r.get(key)
        count = int(current) if current is not None else 0
        return count < _BULK_MAX_SHARE
    except Exception:
        return True


def _entry_to_extract(entry: dict[str, Any]) -> SerpExtract:
    return SerpExtract(
        query=str(entry.get("query") or ""),
        gl=str(entry.get("gl") or ""),
        hl=str(entry.get("hl") or ""),
        fetched_at=float(entry.get("fetched_at") or 0.0),
        html_sha256="",
        results=list(entry.get("results") or []),
        related_searches=list(entry.get("related_searches") or []),
    )


async def get_or_fetch_serp(
    *,
    query: str,
    gl: str,
    hl: str,
    max_age_days: int = _DEFAULT_MAX_AGE_DAYS,
    source: str = "live",
    timeout_s: float = 12.0,
) -> SerpExtract:
    """
    Serve a fresh-enough SERP snapshot from the shared cross-project index, or do a live
    scrape and write the result back for everyone.

    ``source="bulk"`` additionally respects the shared rate budget and raises (caller should
    treat this as "skip this tick") rather than risk starving live traffic; ``source="live"``
    (the default) always proceeds -- a user is actively waiting on it.
    """
    st = get_legacy_storage_module()

    gl2 = (gl or "US").strip()[:8] or "US"
    hl2 = (hl or "en").strip()[:8] or "en"
    qn = _normalize_query(query)
    if not qn:
        raise ValueError("query is required")

    entry = st.get_serp_index_entry(query_norm=qn, gl=gl2, hl=hl2)
    if entry:
        age_s = time.time() - float(entry.get("fetched_at") or 0.0)
        if age_s < max_age_days * 86400:
            return _entry_to_extract(entry)

    src = (source or "live").strip().lower()
    if src == "bulk":
        if not await _bulk_may_proceed():
            raise RuntimeError("shared SERP rate budget exhausted; bulk refresh backing off")

    await _record_fetch_and_get_count()

    html = await fetch_google_serp_html(query=query, gl=gl2, hl=hl2, timeout_s=timeout_s)
    ext = extract_serp(query=query, gl=gl2, hl=hl2, html=html)
    st.upsert_serp_index_entry(
        query=ext.query,
        query_norm=qn,
        gl=gl2,
        hl=hl2,
        results=ext.results,
        related_searches=ext.related_searches,
        source=src,
    )
    return ext
