"""
Background SEO Audit crawl worker.

Runs in a dedicated worker container (ENABLE_SEO_CRAWL_WORKER=1), disabled
elsewhere -- mirrors serp_refresh_worker.py's poll-loop shape exactly, but polls
Mongo directly (`claim_next_queued_seo_audit`) rather than a Redis job queue: a
crawl is a rare, heavy, long-running job, not a high-throughput stream, so an
atomic find-and-claim on the `seo_audits` collection is simpler and avoids
entangling with the OpenAI-generation queue's very different concurrency model.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from app.core.config import settings
from app.legacy.storage import get_legacy_storage_module
from app.services.seo_crawler import analysis as analysis_mod
from app.services.seo_crawler import issues as issues_mod
from app.services.seo_crawler import scoring as scoring_mod
from app.services.seo_crawler.crawler import incremental_crawl, resume_crawl, run_crawl
from app.services.seo_crawler.url_utils import normalize_url
from app.services.storage_db import call_storage
from app.services.to_thread import run_sync

log = logging.getLogger(__name__)


async def _storage(fn, /, *args, **kwargs):
    """Run a blocking storage call off the event loop with Mongo-transient-error
    retries -- same helper generation_worker.py/article_pipeline.py/scheduler.py
    use, applied here so post-crawl writes get the same resilience as the crawl
    loop itself (crawler.py's own `_storage`)."""
    return await run_sync(call_storage, fn, *args, **kwargs)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _make_progress_writer(st, audit_id: str, stage: str, total: int | None):
    """Returns a sync callback (safe to pass as `on_progress` to the chunked storage
    loaders, which call it from inside a worker thread) that persists real "N of M
    loaded" progress to the audit doc -- time-throttled to roughly once per second so
    a fast local run doesn't turn every batch_size-sized chunk into its own Mongo
    write. This is the frontend's only view into "analysis" phase progress, so it
    genuinely reflects how many records have been pulled off the cursor so far, never
    a fabricated/estimated percentage."""
    last_write = {"t": 0.0}

    def _write(loaded: int) -> None:
        now = time.monotonic()
        done = total is not None and loaded >= total
        if not done and now - last_write["t"] < 1.0:
            return
        last_write["t"] = now
        try:
            st.update_seo_audit_fields(audit_id, {"analysis_progress": {"stage": stage, "loaded": loaded, "total": total}})
        except Exception:
            pass  # progress reporting is best-effort; never let it fail the audit

    return _write


def _severity_counts(issues: list[dict]) -> dict[str, int]:
    out = {"issue": 0, "warning": 0, "opportunity": 0}
    for i in issues:
        sev = i.get("severity")
        if sev in out:
            out[sev] += 1
    return out


def _summary_stats(urls: list[dict]) -> dict:
    """Overview-tab aggregates (KPI strip, indexability donut, depth chart), all
    computed from the same `urls` list already loaded for issue evaluation --
    no extra storage round-trip. Every field here is a real count/mean over
    stored data, never a placeholder (Riviso-SEO-Audit-Master-Spec.md §2.1/§124)."""
    indexability_breakdown = {"indexable": 0, "non_indexable": 0, "blocked": 0, "unknown": 0}
    depth_distribution: dict[str, int] = {}
    redirects_count = 0
    broken_links_count = 0
    response_times: list[int] = []

    for u in urls:
        idx = u.get("indexability") or "unknown"
        if idx in indexability_breakdown:
            indexability_breakdown[idx] += 1
        else:
            indexability_breakdown["unknown"] += 1

        depth = u.get("crawl_depth")
        if isinstance(depth, int):
            key = str(depth)
            depth_distribution[key] = depth_distribution.get(key, 0) + 1

        if u.get("redirect_url"):
            redirects_count += 1

        status_code = u.get("status_code")
        if isinstance(status_code, int) and status_code >= 400:
            broken_links_count += 1

        rt = u.get("response_time_ms")
        if isinstance(rt, (int, float)):
            response_times.append(int(rt))

    avg_response_time_ms = round(sum(response_times) / len(response_times)) if response_times else None

    return {
        "indexability_breakdown": indexability_breakdown,
        "depth_distribution": depth_distribution,
        "redirects_count": redirects_count,
        "broken_links_count": broken_links_count,
        "avg_response_time_ms": avg_response_time_ms,
    }


async def _run_one_audit(st, audit: dict) -> None:
    audit_id = audit["id"]
    seed_url = audit.get("website_url") or ""
    config = audit.get("config") or {}
    started = time.monotonic()

    def _should_cancel() -> bool:
        try:
            row = st.load_seo_audit_by_id(audit_id)
        except Exception:
            # Transient Mongo hiccup checking a cancel flag shouldn't abort an
            # otherwise-healthy in-progress crawl -- fail open, try again next cycle.
            return False
        return bool(row and row.get("cancel_requested"))

    is_resume = bool(audit.get("resume_requested"))
    previous_audit_id = (audit.get("previous_audit_id") or "").strip() or None
    crawl_kwargs: dict = dict(
        audit_id=audit_id,
        seed_url=seed_url,
        max_urls=int(config.get("max_urls") or settings.seo_crawl_default_max_urls),
        respect_robots=bool(config.get("respect_robots", True)),
        user_agent=settings.seo_crawl_user_agent,
        timeout_seconds=settings.seo_crawl_request_timeout_seconds,
        concurrency_per_host=settings.seo_crawl_concurrency_per_host,
        max_duration_seconds=settings.seo_crawl_max_duration_seconds,
        should_cancel=_should_cancel,
    )
    if is_resume:
        crawl_fn, crawl_mode = resume_crawl, "resume"
    elif previous_audit_id:
        crawl_fn, crawl_mode = incremental_crawl, "incremental"
        crawl_kwargs["previous_audit_id"] = previous_audit_id
    else:
        crawl_fn, crawl_mode = run_crawl, "crawl"
    try:
        counts = await crawl_fn(st, **crawl_kwargs)
    except Exception as e:
        log.warning("seo_crawl_worker: %s failed for audit %s (%s): %s", crawl_mode, audit_id, seed_url, e)
        # run_crawl() writes `counts` incrementally as it goes (see crawler.py's
        # periodic progress write), so even when it raises partway through, the
        # audit doc may already hold real fetched pages -- surface those as a
        # partial result instead of the generic "failed" message, which reads as
        # "nothing usable happened" when real data was in fact captured.
        has_partial_data = False
        try:
            row = st.load_seo_audit_by_id(audit_id)
            has_partial_data = int((row or {}).get("counts", {}).get("fetched") or 0) > 0
        except Exception:
            pass
        if has_partial_data:
            await _storage(
                st.update_seo_audit_fields,
                audit_id,
                {
                    "status": "partial",
                    "completed_at": _now_iso(),
                    "error": "The crawl was interrupted before finishing. Results below are partial -- continue crawling to pick up where it left off.",
                },
            )
        else:
            await _storage(
                st.update_seo_audit_fields,
                audit_id,
                {"status": "failed", "completed_at": _now_iso(), "error": "The crawl could not complete. Check the website URL and try again."},
            )
        return

    cancelled = _should_cancel()
    seed_normalized = normalize_url(seed_url) or seed_url

    # Distinct "analyzing" status (added to _IN_PROGRESS_STATUSES) so the frontend can
    # tell "still crawling" apart from "crawl done, now reading it back to find
    # issues" instead of the UI going silent between "100% crawled" and a finished
    # result -- exactly the gap that made large-site analysis look hung.
    await _storage(st.update_seo_audit_fields, audit_id, {"status": "analyzing", "counts": counts})

    try:
        urls_progress = _make_progress_writer(st, audit_id, "loading_pages", counts.get("fetched"))
        analysis_result = await run_sync(
            analysis_mod.run_post_crawl_analysis,
            st,
            audit_id=audit_id,
            seed_normalized_url=seed_normalized,
            on_progress=urls_progress,
        )
        urls = analysis_result["urls"]  # already loaded (+ inlink counts merged) inside run_post_crawl_analysis -- no second fetch

        estimated_links_total = (counts.get("internal") or 0) + (counts.get("external") or 0)
        links_progress = _make_progress_writer(st, audit_id, "mapping_links", estimated_links_total or None)
        links = await _storage(st.load_all_seo_audit_links, audit_id, on_progress=links_progress)

        await _storage(st.update_seo_audit_fields, audit_id, {"analysis_progress": {"stage": "evaluating_issues", "loaded": None, "total": None}})
        found_issues = issues_mod.evaluate(audit_id, urls, links, orphan_urls=analysis_result.get("orphan_urls"))
        if found_issues:
            await _storage(st.insert_seo_audit_issues_bulk, found_issues)
        health_score = scoring_mod.compute_health_score(urls, found_issues, counts)
    except Exception as e:
        log.warning("seo_crawl_worker: post-crawl analysis failed for audit %s: %s", audit_id, e)
        await _storage(
            st.update_seo_audit_fields,
            audit_id,
            {
                "status": "partial",
                "completed_at": _now_iso(),
                "counts": counts,
                "error": "The crawl finished but analysis could not complete.",
            },
        )
        return

    duration_ms = int((time.monotonic() - started) * 1000)
    await _storage(
        st.update_seo_audit_fields,
        audit_id,
        {
            "status": "cancelled" if cancelled else "completed",
            "completed_at": _now_iso(),
            "duration_ms": duration_ms,
            "counts": counts,
            "health_score": health_score,
            "severity_counts": _severity_counts(found_issues),
            "orphan_count": analysis_result.get("orphan_count", 0),
            **_summary_stats(urls),
        },
    )
    log.info("seo_crawl_worker: audit %s %s (%s URLs, %s issues, %sms)", audit_id, "cancelled" if cancelled else "completed", len(urls), len(found_issues), duration_ms)


async def seo_crawl_loop(*, poll_seconds: float = 5.0) -> None:
    """In-process loop; run only inside the dedicated seo-crawl worker container."""
    consecutive_failures = 0
    while True:
        claimed = None
        try:
            st = get_legacy_storage_module()
            claimed = await _storage(st.claim_next_queued_seo_audit, _now_iso())
            if claimed:
                await _run_one_audit(st, claimed)
            consecutive_failures = 0
        except Exception as e:
            consecutive_failures += 1
            log.warning("seo_crawl_worker cycle failed (failures=%s): %s", consecutive_failures, e)

        if claimed:
            continue  # immediately check for another queued audit
        delay = poll_seconds if consecutive_failures == 0 else min(120.0, poll_seconds * (2 ** min(consecutive_failures, 4)))
        await asyncio.sleep(delay)
