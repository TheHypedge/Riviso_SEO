"""
Background refresh loop for the shared cross-project SERP index (serp_index.py, Phase A).

Runs in a dedicated worker container (ENABLE_SERP_REFRESH_WORKER=1), disabled elsewhere.
Two jobs per cycle, both going through the same get_or_fetch_serp entry point live requests
use, so the shared rate limiter governs both consistently:

1. Refresh the stalest known entries (keeps existing coverage current).
2. Expand coverage from related_searches already stored on those entries -- a handful of
   candidate queries nobody has explicitly searched yet get indexed too, so the index grows
   outward from real usage instead of needing a fixed crawl list maintained by hand.
"""

from __future__ import annotations

import asyncio
import logging

from app.legacy.storage import get_legacy_storage_module
from app.services.serp_index import _normalize_query, get_or_fetch_serp
from app.services.to_thread import run_sync

log = logging.getLogger(__name__)

_MAX_AGE_DAYS = 14
_REFRESH_BATCH = 15
_EXPANSION_BATCH = 5


async def _refresh_stale_entries(st, stale: list[dict]) -> int:
    refreshed = 0
    for entry in stale or []:
        if not isinstance(entry, dict):
            continue
        try:
            await get_or_fetch_serp(
                query=str(entry.get("query") or ""),
                gl=str(entry.get("gl") or "US"),
                hl=str(entry.get("hl") or "en"),
                max_age_days=_MAX_AGE_DAYS,
                source="bulk",
            )
            refreshed += 1
        except RuntimeError:
            # Shared rate budget exhausted for this window -- stop early rather than
            # keep contending with live traffic; the rest picks up next cycle.
            break
        except Exception:
            log.debug("serp_refresh_worker: stale refresh failed for %r", entry.get("query"), exc_info=True)
    return refreshed


async def _expand_from_related_searches(st, seed_entries: list[dict]) -> int:
    candidates: list[tuple[str, str, str]] = []  # (query, gl, hl)
    seen: set[str] = set()
    for entry in seed_entries or []:
        if not isinstance(entry, dict):
            continue
        gl = str(entry.get("gl") or "US")
        hl = str(entry.get("hl") or "en")
        for rq in (entry.get("related_searches") or [])[:5]:
            q = str(rq or "").strip()
            if not q:
                continue
            qn = _normalize_query(q)
            key = f"{gl}:{hl}:{qn}"
            if not qn or key in seen:
                continue
            seen.add(key)
            candidates.append((q, gl, hl))
            if len(candidates) >= _EXPANSION_BATCH * 3:
                break

    expanded = 0
    for q, gl, hl in candidates:
        if expanded >= _EXPANSION_BATCH:
            break
        qn = _normalize_query(q)
        existing = await run_sync(st.get_serp_index_entry, query_norm=qn, gl=gl, hl=hl)
        if existing:
            continue  # already covered -- not a genuinely new candidate
        try:
            await get_or_fetch_serp(query=q, gl=gl, hl=hl, max_age_days=_MAX_AGE_DAYS, source="bulk")
            expanded += 1
        except RuntimeError:
            break
        except Exception:
            log.debug("serp_refresh_worker: expansion fetch failed for %r", q, exc_info=True)
    return expanded


async def serp_refresh_loop(*, poll_seconds: float = 300.0) -> None:
    """In-process loop; run only inside the dedicated serp-refresh worker container."""
    consecutive_failures = 0
    while True:
        try:
            st = get_legacy_storage_module()
            stale = await run_sync(st.load_stale_serp_index_entries, max_age_days=_MAX_AGE_DAYS, limit=_REFRESH_BATCH)
            refreshed = await _refresh_stale_entries(st, stale or [])
            expanded = await _expand_from_related_searches(st, stale or [])
            consecutive_failures = 0
            if refreshed or expanded:
                log.info("serp_refresh_worker: refreshed=%s expanded=%s", refreshed, expanded)
        except Exception as e:
            consecutive_failures += 1
            log.warning("serp_refresh_worker cycle failed (failures=%s): %s", consecutive_failures, e)

        delay = poll_seconds if consecutive_failures == 0 else min(1800.0, poll_seconds * (2 ** min(consecutive_failures, 4)))
        await asyncio.sleep(delay)
