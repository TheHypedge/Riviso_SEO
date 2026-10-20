"""
Site Audit — Technical Audit (Google PageSpeed Insights), Phase 1.

- ``GET  /api/projects/{project_id}/site-audit/technical/latest``   — current result + running state
- ``GET  /api/projects/{project_id}/site-audit/technical/history``  — recent runs
- ``GET  /api/projects/{project_id}/site-audit/technical/runs/{id}`` — one full run
- ``POST /api/projects/{project_id}/site-audit/technical/run``      — start mobile + desktop, returns immediately

``/run`` used to run PSI's mobile+desktop calls inline and hold the HTTP connection open until
both finished (routinely 20-45s combined). In practice that's long enough for an intermediate
proxy (e.g. Next.js's dev rewrite) to give up and reset the connection before PSI ever responds
-- the request never reaches a clean success/failure outcome even though the backend eventually
finishes the work. Fix: kick the PSI calls off as a background task and return immediately;
the frontend polls ``/latest`` (which now reports ``running``) until it lands.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.core.deps import get_current_user
from app.core.project_lookup import async_require_project_access
from app.legacy.storage import get_legacy_storage_module
from app.services.cloudinary_storage import upload_image_bytes
from app.services.pagespeed_client import extract_final_screenshot, fetch_pagespeed_result, normalize_pagespeed_result, pagespeed_configured
from app.services.plan_gatekeeper import PlanAction, require_plan_action_for_project
from app.services.site_audit.website import resolve_project_website_url
from app.services.to_thread import run_sync

log = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/site-audit/technical", tags=["site-audit"])

# In-process run tracker, keyed by project_id -- same single-instance assumption already made
# by every other in-process cache/limiter in this codebase (e.g. serp_index.py's rate limiter).
# {"error": str | None} present in the dict means "still running"; entry removed on completion.
_running_audits: dict[str, dict[str, Any]] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _website_block(proj: dict) -> dict[str, Any]:
    url = resolve_project_website_url(proj)
    return {"url": url, "connected": bool(url)}


async def _timed_fetch(url: str, strategy: str) -> tuple[dict[str, Any], int]:
    """PSI result plus Riviso's own measured wall-clock duration of the call (ms)."""
    started = time.monotonic()
    raw = await fetch_pagespeed_result(url=url, strategy=strategy)  # type: ignore[arg-type]
    return raw, int((time.monotonic() - started) * 1000)


async def _store_screenshot(raw: dict[str, Any], *, project_id: str, run_id: str, strategy: str) -> dict[str, Any]:
    """Upload Lighthouse's final screenshot to image storage; only the URL is stored."""
    data = extract_final_screenshot(raw)
    if not data:
        return {"screenshot_url": None, "screenshot_status": "not_captured"}
    uploaded = await asyncio.to_thread(upload_image_bytes, data, folder=f"technical-audit/{project_id}", public_id=f"{run_id}-{strategy}")
    if not uploaded:
        return {"screenshot_url": None, "screenshot_status": "unavailable"}
    return {"screenshot_url": uploaded["secure_url"], "screenshot_status": "stored"}


async def _execute_technical_audit(*, project_id: str, url: str) -> None:
    st = get_legacy_storage_module()
    try:
        (mobile_raw, mobile_ms), (desktop_raw, desktop_ms) = await asyncio.gather(_timed_fetch(url, "mobile"), _timed_fetch(url, "desktop"))
        run_id = secrets.token_hex(16)
        strategies: dict[str, Any] = {}
        for strategy, raw, ms in (("mobile", mobile_raw, mobile_ms), ("desktop", desktop_raw, desktop_ms)):
            result = normalize_pagespeed_result(raw)
            result["run_duration_ms"] = ms
            try:
                result.update(await _store_screenshot(raw, project_id=project_id, run_id=run_id, strategy=strategy))
            except Exception:  # a screenshot must never fail the audit
                log.warning("Technical Audit screenshot upload failed for project %s", project_id, exc_info=True)
                result.update({"screenshot_url": None, "screenshot_status": "unavailable"})
            strategies[strategy] = result
        run = {
            "id": run_id,
            "project_id": project_id,
            "website_url": url,
            "created_at": _now_iso(),
            **strategies,
        }
        if hasattr(st, "save_technical_audit_run"):
            await run_sync(st.save_technical_audit_run, run)
    except Exception as e:
        log.warning("Technical Audit failed for project %s (%s): %s", project_id, url, e)
        _running_audits[project_id] = {
            "error": "Google PageSpeed Insights did not return a valid result. Your previous successful audit has been preserved."
        }
        return
    _running_audits.pop(project_id, None)


@router.get("/latest")
async def get_latest_technical_audit(project_id: str, user: dict = Depends(get_current_user)) -> dict[str, Any]:
    st = get_legacy_storage_module()
    proj = await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)
    latest = await run_sync(st.load_latest_technical_audit, project_id) if hasattr(st, "load_latest_technical_audit") else None
    tracked = _running_audits.get(project_id)
    return {
        "website": _website_block(proj),
        "pagespeed_configured": pagespeed_configured(),
        "audit": latest,
        "running": tracked is not None and not tracked.get("error"),
        "error": (tracked or {}).get("error"),
    }


@router.get("/history")
async def get_technical_audit_history(project_id: str, user: dict = Depends(get_current_user)) -> dict[str, Any]:
    st = get_legacy_storage_module()
    await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)
    rows = await run_sync(st.load_technical_audit_history, project_id, limit=20) if hasattr(st, "load_technical_audit_history") else []
    return {"runs": rows or []}


@router.get("/runs/{run_id}")
async def get_technical_audit_run(project_id: str, run_id: str, user: dict = Depends(get_current_user)) -> dict[str, Any]:
    """One full stored run (history rows omit the per-strategy audits index)."""
    st = get_legacy_storage_module()
    await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)
    run = await run_sync(st.load_technical_audit_run, project_id, run_id) if hasattr(st, "load_technical_audit_run") else None
    if not run:
        raise HTTPException(status_code=404, detail="That Technical Audit run was not found for this project.")
    return {"run": run}


@router.post("/run")
async def run_technical_audit(
    project_id: str,
    user: dict = Depends(require_plan_action_for_project(PlanAction.TECHNICAL_AUDIT, consume=False)),
) -> dict[str, Any]:
    st = get_legacy_storage_module()
    proj = await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)

    if not pagespeed_configured():
        raise HTTPException(status_code=501, detail="Google PageSpeed Insights is not configured on the backend.")

    url = resolve_project_website_url(proj)
    if not url:
        raise HTTPException(
            status_code=400,
            detail={"code": "website_not_connected", "message": "Connect a website in Project Settings before running Technical Audit."},
        )

    tracked = _running_audits.get(project_id)
    if tracked is not None and not tracked.get("error"):
        # Already in flight -- don't double-charge quota or start a second concurrent run.
        return {"website": _website_block(proj), "pagespeed_configured": True, "running": True}

    # Quota consumed only after validating the request has a real website to audit,
    # matching the check-then-consume shape used by cluster planning (project_topic_cluster.py).
    if (user.get("role") or "").strip().lower() != "admin" and hasattr(st, "consume_technical_audit_usage"):
        plans = await run_sync(st.load_plans) if hasattr(st, "load_plans") else {}
        plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
        plan = (plans or {}).get(plan_key) if isinstance(plans, dict) else {}
        ok, msg = await run_sync(
            st.consume_technical_audit_usage,
            (user.get("id") or "").strip(),
            month_limit=(plan or {}).get("max_technical_audits_per_month"),
            amount=1,
        )
        if not ok:
            raise HTTPException(
                status_code=403,
                detail={"code": "quota_exceeded", "feature": "technical_audit", "message": msg or "Monthly Technical Audit limit reached for your plan."},
            )

    _running_audits[project_id] = {"error": None}
    asyncio.create_task(_execute_technical_audit(project_id=project_id, url=url))
    return {"website": _website_block(proj), "pagespeed_configured": True, "running": True}
