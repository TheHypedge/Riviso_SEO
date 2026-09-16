"""
AI Citation Tracking -- periodically asks AI answer engines (ChatGPT, Perplexity,
Gemini, Google AI Overview) brand/topic prompts derived from the project's
existing keywords, and records whether the project's brand/domain got cited.

- ``POST /api/projects/{project_id}/ai-citations/run``      -- enqueue a check run, returns immediately
- ``GET  /api/projects/{project_id}/ai-citations/latest``   -- most recent run's cells + website info
- ``GET  /api/projects/{project_id}/ai-citations/history``  -- recent runs (summary only)
- ``GET  /api/projects/{project_id}/ai-citations/trend``    -- week x engine citation-rate aggregation
- ``GET  /api/projects/{project_id}/ai-citations/checks``   -- paginated, filterable checks across ALL runs (the full accumulated history, not just the latest run)

Checks happen out-of-process in the dedicated ai-citation-worker container
(app/services/ai_citation_worker.py); this route only enqueues queued cell docs
and reads results back -- same polling pattern as Site Audit
(site_audit_seo.py).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.deps import get_current_user
from app.core.project_lookup import async_require_project_access
from app.legacy.storage import get_legacy_storage_module
from app.services.ai_citation.prompt_builder import build_check_prompts, expand_prompts_for_keywords
from app.services.ai_citation.runner import build_queued_cells, enabled_engines
from app.services.ai_citation.topic_expansion import expand_keywords
from app.services.plan_gatekeeper import PlanAction, require_plan_action_for_project
from app.services.site_audit.website import resolve_project_website_url
from app.services.to_thread import run_sync

log = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/ai-citations", tags=["ai-citation"])

_IN_PROGRESS_STATUSES = ("queued", "running")

_DEFAULT_MAX_KEYWORDS = 50


def _website_block(proj: dict) -> dict[str, Any]:
    url = resolve_project_website_url(proj)
    return {"url": url, "connected": bool(url)}


def _run_status(cells: list[dict[str, Any]] | None) -> bool:
    return bool(cells) and any((c.get("status") in _IN_PROGRESS_STATUSES) for c in cells)


@router.get("/latest")
async def get_latest_ai_citation_run(project_id: str, user: dict = Depends(get_current_user)) -> dict[str, Any]:
    st = get_legacy_storage_module()
    proj = await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)
    latest = await run_sync(st.load_latest_ai_citation_run, project_id)
    cells = (latest or {}).get("checks") or []
    return {
        "website": _website_block(proj),
        "run_id": (latest or {}).get("run_id"),
        "checks": cells,
        "running": _run_status(cells),
        "engines_configured": enabled_engines(),
    }


@router.get("/history")
async def get_ai_citation_history(project_id: str, user: dict = Depends(get_current_user)) -> dict[str, Any]:
    st = get_legacy_storage_module()
    await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)
    rows = await run_sync(st.load_ai_citation_history, project_id, limit=20)
    return {"runs": rows or []}


@router.get("/trend")
async def get_ai_citation_trend(
    project_id: str,
    weeks: int = Query(12, ge=1, le=52),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    st = get_legacy_storage_module()
    await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)
    points = await run_sync(st.load_ai_citation_trend, project_id, weeks=weeks)
    return {"points": points or []}


@router.get("/checks")
async def get_ai_citation_checks(
    project_id: str,
    page: int = Query(1, ge=1),
    per_page: int = Query(30, ge=1, le=200),
    q: str | None = None,
    status: str | None = Query(None, description="cited | not_cited | checking | error"),
    engine: str | None = None,
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    st = get_legacy_storage_module()
    await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)
    res = await run_sync(
        st.load_ai_citation_checks_page,
        project_id,
        page=page,
        per_page=per_page,
        q=q,
        status_filter=status,
        engine_filter=engine,
    )
    return {"items": (res or {}).get("items") or [], "total": (res or {}).get("total") or 0}


@router.post("/run")
async def run_ai_citation_check(
    project_id: str,
    user: dict = Depends(require_plan_action_for_project(PlanAction.AI_CITATION_CHECK, consume=False)),
) -> dict[str, Any]:
    st = get_legacy_storage_module()
    proj = await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)

    url = resolve_project_website_url(proj)
    if not url:
        raise HTTPException(
            status_code=400,
            detail={"code": "website_not_connected", "message": "Connect a website in Project Settings before running an AI Citation check."},
        )

    engines = enabled_engines()
    if not engines:
        raise HTTPException(
            status_code=400,
            detail={"code": "no_engines_configured", "message": "No AI engines are configured yet for AI Citation Tracking."},
        )

    latest = await run_sync(st.load_latest_ai_citation_run, project_id)
    existing_cells = (latest or {}).get("checks") or []
    if _run_status(existing_cells):
        return {"website": _website_block(proj), "running": True, "run_id": (latest or {}).get("run_id")}

    plans = await run_sync(st.load_plans) if hasattr(st, "load_plans") else {}
    plan_key = (user.get("subscription_type") or "").strip().lower() or "beta"
    plan = (plans or {}).get(plan_key) if isinstance(plans, dict) else {}
    max_keywords = int((plan or {}).get("max_ai_citation_keywords_per_run") or _DEFAULT_MAX_KEYWORDS)

    # "Continue more" instead of re-checking the same top keywords every run: exclude
    # whatever this project has already been checked for, and cover new ground from
    # the project's own content first (free -- no extra LLM call).
    already_checked = await run_sync(st.load_ai_citation_checked_keywords, project_id) if hasattr(st, "load_ai_citation_checked_keywords") else set()
    prompts = await run_sync(build_check_prompts, project_id, st, max_keywords=max_keywords, exclude_keywords=already_checked)

    # The project's own articles/clusters are a finite pool -- once they can't fill a
    # full batch, top up with LLM-generated topics in the same niche (seeded from real
    # existing keywords) instead of plateauing at whatever the project happened to
    # write about. Only called for the actual shortfall, never unconditionally, so a
    # project with plenty of its own keywords left never pays for this extra call.
    natural_keywords_used = {p["keyword"].casefold() for p in prompts}
    shortfall = max_keywords - len(natural_keywords_used)
    if shortfall > 0:
        seed = list(already_checked)[:15] or [p["keyword"] for p in prompts[:15]]
        expanded = await expand_keywords(
            brand_name=proj.get("name") or "",
            website_domain=url,
            seed_keywords=seed,
            exclude=already_checked | natural_keywords_used,
            count=shortfall,
        )
        if expanded:
            prompts.extend(expand_prompts_for_keywords([(kw, "llm_expanded") for kw in expanded]))

    is_refresh = False
    if not prompts and already_checked:
        prompts = await run_sync(build_check_prompts, project_id, st, max_keywords=max_keywords)
        is_refresh = True
    if not prompts:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "no_keywords",
                "message": "No keywords to check yet -- add a focus keyphrase to an article, or a keyword to a topic cluster, first.",
            },
        )

    cells_count = len(prompts) * len(engines)
    if (user.get("role") or "").strip().lower() != "admin":
        ok, msg = await run_sync(
            st.consume_ai_citation_usage,
            (user.get("id") or "").strip(),
            month_limit=(plan or {}).get("max_ai_citation_checks_per_month"),
            amount=cells_count,
        )
        if not ok:
            raise HTTPException(
                status_code=403,
                detail={"code": "quota_exceeded", "feature": "ai_citations", "message": msg or "Monthly AI Citation Tracking limit reached for your plan."},
            )

    run_id, cells = build_queued_cells(project_id=project_id, prompts=prompts, engines=engines)
    await run_sync(st.create_ai_citation_checks_bulk, cells)
    log.info(
        "ai_citation: queued run %s (%s cells, %s) for project %s",
        run_id,
        len(cells),
        "refresh" if is_refresh else "new keywords",
        project_id,
    )
    return {"website": _website_block(proj), "running": True, "run_id": run_id, "is_refresh": is_refresh}
