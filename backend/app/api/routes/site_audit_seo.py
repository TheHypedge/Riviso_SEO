"""
Site Audit — SEO Audit (Riviso crawler), Phase 1 (Crawl Foundation + Core SEO).

- ``POST /api/projects/{project_id}/site-audit/seo/run``            — enqueue a crawl, returns immediately
- ``POST /api/projects/{project_id}/site-audit/seo/{audit_id}/resume`` — continue an interrupted (partial) crawl from where it left off
- ``GET  /api/projects/{project_id}/site-audit/seo/latest``         — most recent audit (any status) + website info
- ``GET  /api/projects/{project_id}/site-audit/seo/history``        — recent audit runs (summary only)
- ``GET  /api/projects/{project_id}/site-audit/seo/{audit_id}``     — one audit's full summary
- ``GET  /api/projects/{project_id}/site-audit/seo/{audit_id}/urls``          — paginated URL Explorer
- ``GET  /api/projects/{project_id}/site-audit/seo/{audit_id}/urls/{url_id}`` — one URL's full detail + in/outlinks
- ``GET  /api/projects/{project_id}/site-audit/seo/{audit_id}/issues``        — grouped issue summary, or one rule's URLs
- ``POST /api/projects/{project_id}/site-audit/seo/{audit_id}/cancel``        — request cancellation

Crawling happens out-of-process in the dedicated seo-crawl-worker container
(app/services/seo_crawl_worker.py); this route only enqueues a `seo_audits` row
and reads results back. The frontend polls `/latest` for `status`, mirroring the
already-proven Technical Audit polling pattern (see site_audit_technical.py) rather
than a new SSE mechanism.
"""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.config import settings
from app.core.deps import get_current_user
from app.core.project_lookup import async_require_project_access
from app.legacy.storage import get_legacy_storage_module
from app.services.plan_gatekeeper import PlanAction, require_plan_action_for_project
from app.services.site_audit.website import resolve_project_website_url
from app.services.to_thread import run_sync

log = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/site-audit/seo", tags=["site-audit"])

_IN_PROGRESS_STATUSES = ("queued", "running", "analyzing")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _website_block(proj: dict) -> dict[str, Any]:
    url = resolve_project_website_url(proj)
    return {"url": url, "connected": bool(url)}


@router.get("/latest")
async def get_latest_seo_audit(project_id: str, user: dict = Depends(get_current_user)) -> dict[str, Any]:
    st = get_legacy_storage_module()
    proj = await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)
    latest = await run_sync(st.load_latest_seo_audit, project_id)
    return {
        "website": _website_block(proj),
        "audit": latest,
        "running": bool(latest and latest.get("status") in _IN_PROGRESS_STATUSES),
    }


@router.get("/history")
async def get_seo_audit_history(project_id: str, user: dict = Depends(get_current_user)) -> dict[str, Any]:
    st = get_legacy_storage_module()
    await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)
    rows = await run_sync(st.load_seo_audit_history, project_id, limit=20)
    return {"runs": rows or []}


@router.get("/{audit_id}")
async def get_seo_audit(project_id: str, audit_id: str, user: dict = Depends(get_current_user)) -> dict[str, Any]:
    st = get_legacy_storage_module()
    await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)
    audit = await run_sync(st.load_seo_audit_by_id, audit_id)
    if not audit or audit.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="Audit not found")
    return audit


@router.get("/{audit_id}/urls/recent")
async def get_seo_audit_recent_urls(
    project_id: str,
    audit_id: str,
    limit: int = Query(20, ge=1, le=100),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    """Most-recently-crawled URLs -- powers the live "crawling now" feed while an
    audit is running. Cheap poll target (small, indexed, no full-page payload)."""
    st = get_legacy_storage_module()
    await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)
    audit = await run_sync(st.load_seo_audit_by_id, audit_id)
    if not audit or audit.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="Audit not found")
    rows = await run_sync(st.load_recent_seo_audit_urls, audit_id, limit)
    return {"items": rows}


@router.get("/{audit_id}/urls")
async def get_seo_audit_urls(
    project_id: str,
    audit_id: str,
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=500),
    q: str | None = None,
    status_code: str | None = None,
    indexability: str | None = None,
    sort: str = "crawl_depth",
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    st = get_legacy_storage_module()
    await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)
    audit = await run_sync(st.load_seo_audit_by_id, audit_id)
    if not audit or audit.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="Audit not found")
    result = await run_sync(
        st.load_seo_audit_urls_page,
        audit_id,
        page=page,
        per_page=per_page,
        q=q,
        status_filter=status_code,
        indexability_filter=indexability,
        sort=sort,
    )
    return {"items": result.get("items", []), "total": result.get("total", 0), "page": page, "per_page": per_page}


@router.get("/{audit_id}/urls/{url_id}")
async def get_seo_audit_url_detail(project_id: str, audit_id: str, url_id: str, user: dict = Depends(get_current_user)) -> dict[str, Any]:
    st = get_legacy_storage_module()
    await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)
    url_doc = await run_sync(st.load_seo_audit_url_by_id, url_id)
    if not url_doc or url_doc.get("audit_id") != audit_id:
        raise HTTPException(status_code=404, detail="URL not found in this audit")
    inlinks = await run_sync(st.load_seo_audit_inlinks_for_url, audit_id, url_doc.get("normalized_url") or "", 200)
    outlinks = await run_sync(st.load_seo_audit_outlinks_for_url, audit_id, url_id, 200)
    issues = await run_sync(st.load_seo_audit_issues, audit_id, rule_id=None, limit=5000)
    url_issues = [i for i in issues if i.get("url_id") == url_id]
    return {"url": url_doc, "inlinks": inlinks, "outlinks": outlinks, "issues": url_issues}


@router.get("/{audit_id}/issues")
async def get_seo_audit_issues(
    project_id: str,
    audit_id: str,
    rule_id: str | None = None,
    severity: str | None = None,
    limit: int = Query(200, ge=1, le=2000),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    st = get_legacy_storage_module()
    await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)
    if rule_id:
        rows = await run_sync(st.load_seo_audit_issues, audit_id, severity=severity, rule_id=rule_id, limit=limit)
        return {"issues": rows}
    groups = await run_sync(st.aggregate_seo_audit_issue_groups, audit_id)
    return {"groups": groups}


@router.post("/run")
async def run_seo_audit(
    project_id: str,
    full: bool = Query(False, description="Force a full re-crawl even if a previous audit exists to build on incrementally."),
    user: dict = Depends(require_plan_action_for_project(PlanAction.SEO_AUDIT, consume=False)),
) -> dict[str, Any]:
    st = get_legacy_storage_module()
    proj = await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)

    url = resolve_project_website_url(proj)
    if not url:
        raise HTTPException(
            status_code=400,
            detail={"code": "website_not_connected", "message": "Connect a website in Project Settings before running an SEO Audit."},
        )

    existing = await run_sync(st.load_latest_seo_audit, project_id)
    if existing and existing.get("status") in _IN_PROGRESS_STATUSES:
        return {"website": _website_block(proj), "running": True, "audit": existing}

    # Default to an incremental re-crawl once a previous audit already has real
    # crawled pages to build on: only the homepage + genuinely new links get
    # fetched, everything else is carried forward (see crawler.py's
    # incremental_crawl for the full reasoning). `full=true` bypasses this for
    # an explicit complete re-verification ("Start Fresh Audit" in the UI).
    previous_audit_id = None
    if not full and existing and int((existing.get("counts") or {}).get("fetched") or 0) > 0:
        previous_audit_id = existing.get("id")

    plans = await run_sync(st.load_plans) if hasattr(st, "load_plans") else {}
    plan_key = (user.get("subscription_type") or "").strip().lower() or "beta"
    plan = (plans or {}).get(plan_key) if isinstance(plans, dict) else {}
    max_urls = int((plan or {}).get("max_seo_audit_urls_per_crawl") or settings.seo_crawl_default_max_urls)

    if (user.get("role") or "").strip().lower() != "admin":
        ok, msg = await run_sync(
            st.consume_seo_audit_usage,
            (user.get("id") or "").strip(),
            month_limit=(plan or {}).get("max_seo_audits_per_month"),
            amount=1,
        )
        if not ok:
            raise HTTPException(
                status_code=403,
                detail={"code": "quota_exceeded", "feature": "seo_audit", "message": msg or "Monthly SEO Audit limit reached for your plan."},
            )

    now = _now_iso()
    audit = {
        "id": secrets.token_hex(16),
        "project_id": project_id,
        "website_url": url,
        "status": "queued",
        "config": {"max_urls": max_urls, "respect_robots": True},
        "crawler_version": "2026.08.1",
        "queued_at": now,
        "started_at": now,  # provisional -- the worker overwrites this on actual claim
        "completed_at": None,
        "counts": {"discovered": 0, "fetched": 0, "queued": 0, "blocked": 0, "failed": 0, "internal": 0, "external": 0},
        "health_score": None,
        "severity_counts": None,
        "indexability_breakdown": None,
        "depth_distribution": None,
        "redirects_count": None,
        "broken_links_count": None,
        "avg_response_time_ms": None,
        "analysis_progress": None,
        "cancel_requested": False,
        "previous_audit_id": previous_audit_id,
    }
    await run_sync(st.create_seo_audit, audit)
    log.info(
        "seo_audit: queued %s audit %s for project %s (%s)",
        "incremental" if previous_audit_id else "full",
        audit["id"],
        project_id,
        url,
    )
    return {"website": _website_block(proj), "running": True, "audit": audit}


@router.post("/{audit_id}/resume")
async def resume_seo_audit(project_id: str, audit_id: str, user: dict = Depends(get_current_user)) -> dict[str, Any]:
    """Continue an interrupted crawl from where it left off, rather than the user
    having to burn quota and time re-crawling everything from scratch. Only valid
    from `status: "partial"` -- that status specifically means "the crawl was
    interrupted after fetching real pages" (see seo_crawl_worker.py's failure
    classification), so there's always a durable frontier to resume from. Doesn't
    consume monthly SEO Audit quota: this is the same audit continuing, not a new
    run."""
    st = get_legacy_storage_module()
    proj = await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)
    audit = await run_sync(st.load_seo_audit_by_id, audit_id)
    if not audit or audit.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="Audit not found")
    if audit.get("status") in _IN_PROGRESS_STATUSES:
        return {"website": _website_block(proj), "running": True, "audit": audit}
    if audit.get("status") != "partial":
        raise HTTPException(
            status_code=400,
            detail={"code": "not_resumable", "message": "Only an interrupted crawl with partial results can be continued."},
        )
    now = _now_iso()
    await run_sync(
        st.update_seo_audit_fields,
        audit_id,
        {"status": "queued", "queued_at": now, "completed_at": None, "error": None, "resume_requested": True, "cancel_requested": False},
    )
    updated = await run_sync(st.load_seo_audit_by_id, audit_id)
    log.info("seo_audit: resume requested for audit %s (project %s)", audit_id, project_id)
    return {"website": _website_block(proj), "running": True, "audit": updated}


@router.post("/{audit_id}/cancel")
async def cancel_seo_audit(project_id: str, audit_id: str, user: dict = Depends(get_current_user)) -> dict[str, Any]:
    st = get_legacy_storage_module()
    await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)
    audit = await run_sync(st.load_seo_audit_by_id, audit_id)
    if not audit or audit.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="Audit not found")
    if audit.get("status") not in _IN_PROGRESS_STATUSES:
        return {"ok": True, "already_finished": True}
    await run_sync(st.update_seo_audit_fields, audit_id, {"cancel_requested": True})
    return {"ok": True}
