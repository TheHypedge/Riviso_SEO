
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from app.core.ratelimit import limiter

from app.core.deps import get_current_user
from app.core.project_lookup import async_require_project_access, require_project_access
from app.legacy.storage import get_legacy_storage_module
from app.schemas.research import ResearchIdeasRequest, ResearchIdeasResponse
from app.services.async_operation_dispatch import should_use_async_queue  # retained for job-status polling path
from app.services.plan_gatekeeper import PlanAction, require_plan_action, require_plan_action_for_project
from app.services.research_job_runner import (
    build_research_cache_key,
    execute_research_ideas,
    persist_research_ideas_result,
)
from app.services.to_thread import run_sync

router = APIRouter(prefix="/projects/{project_id}/research", tags=["research"])


def _plan_for_user(*, st, user: dict) -> tuple[str, dict[str, Any]]:
    plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
    try:
        plans = st.load_plans() or {}
        plan = plans.get(plan_key) if isinstance(plans, dict) else {}
        if not isinstance(plan, dict):
            plan = {}
    except Exception:
        plan = {}
    return plan_key, plan


def _enforce_custom_research_quota(*, st, user: dict) -> None:
    if (user.get("role") or "").strip().lower() == "admin":
        return
    plan_key, plan = _plan_for_user(st=st, user=user)
    if not hasattr(st, "consume_custom_research_usage"):
        return
    ok, msg = st.consume_custom_research_usage(
        (user.get("id") or "").strip(),
        month_limit=plan.get("max_custom_research_per_month"),
        amount=1,
    )
    if not ok:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "quota_exceeded",
                "feature": "custom_research",
                "plan_key": plan_key,
                "message": msg or "Monthly Custom Curations limit reached for your plan.",
            },
        )


def _ideas_response_from_cache(cached: dict[str, Any]) -> ResearchIdeasResponse:
    return ResearchIdeasResponse(
        ok=True,
        ideas=cached.get("ideas") or [],
        keyword_analysis=cached.get("keyword_analysis") if isinstance(cached.get("keyword_analysis"), dict) else None,
        scraped_queries=cached.get("scraped_queries") if isinstance(cached.get("scraped_queries"), list) else [],
        used_history_count=int(cached.get("used_history_count") or 0),
    )


@router.get("/ideas/jobs/{cache_key}")
async def research_ideas_job_status(
    project_id: str,
    cache_key: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """Poll async research curation status or fetch a completed cached result."""
    st = get_legacy_storage_module()
    await async_require_project_access(user=user, project_id=project_id, full=False)
    key = (cache_key or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="cache_key is required")

    if hasattr(st, "get_research_cache"):
        try:
            cached = st.get_research_cache(cache_key=key, max_age_s=6 * 60 * 60)
        except Exception:
            cached = None
        if isinstance(cached, dict) and isinstance(cached.get("ideas"), list):
            return {"status": "complete", "result": _ideas_response_from_cache(cached).model_dump()}

    if hasattr(st, "get_research_job_status"):
        inflight = st.get_research_job_status(cache_key=key)
        if isinstance(inflight, dict):
            status = (inflight.get("status") or "queued").strip().lower()
            out: dict[str, Any] = {"status": status, "poll_cache_key": key}
            if inflight.get("message"):
                out["message"] = inflight.get("message")
            return out

    raise HTTPException(status_code=404, detail="Research job not found")


@router.post("/ideas", response_model=None)
@limiter.limit("20/minute")
async def research_ideas(
    request: Request,
    project_id: str,
    payload: ResearchIdeasRequest,
    user: dict = Depends(require_plan_action_for_project(PlanAction.CUSTOM_RESEARCH, consume=False)),
) -> ResearchIdeasResponse | JSONResponse:
    st = get_legacy_storage_module()
    await async_require_project_access(user=user, project_id=project_id, full=False)

    seeds = [str(x).strip() for x in (payload.seed_keywords or []) if str(x).strip()][:25]
    if not seeds:
        raise HTTPException(status_code=400, detail="seed_keywords is required")

    brand_niche = (payload.brand_niche or "").strip()
    intent = str(payload.intent or "informational")
    tone = str(payload.tone or "professional")
    gl = (payload.country or "US").strip()[:8] or "US"
    hl = (payload.language or "en").strip()[:8] or "en"
    max_ideas = int(payload.max_ideas or 30)

    cache_key = build_research_cache_key(
        project_id=project_id,
        brand_niche=brand_niche,
        intent=intent,
        tone=tone,
        seeds=seeds,
        gl=gl,
        hl=hl,
        max_ideas=max_ideas,
    )

    if hasattr(st, "get_research_cache"):
        try:
            cached = st.get_research_cache(cache_key=cache_key, max_age_s=6 * 60 * 60)
        except Exception:
            cached = None
        if isinstance(cached, dict) and isinstance(cached.get("ideas"), list):
            return _ideas_response_from_cache(cached)

    if hasattr(st, "get_research_job_status"):
        inflight = st.get_research_job_status(cache_key=cache_key)
        if isinstance(inflight, dict):
            status = (inflight.get("status") or "queued").strip().lower()
            return JSONResponse(
                status_code=202,
                content={
                    "ok": True,
                    "status": status,
                    "poll_cache_key": cache_key,
                    "message": "Research curation is already in progress.",
                },
            )

    _enforce_custom_research_quota(st=st, user=user)

    job_payload = {
        "project_id": project_id,
        "user_id": (user.get("id") or "").strip(),
        "brand_niche": brand_niche,
        "intent": intent,
        "tone": tone,
        "seed_keywords": seeds,
        "country": gl,
        "language": hl,
        "max_ideas": max_ideas,
    }

    # Research always runs synchronously — the user waits for results and the
    # SERP+LLM pipeline completes in ~10-30s (well within the 120s API timeout).
    # The async-queue path returned 202 which the frontend cannot poll, causing
    # ideas to never appear in the UI.
    result = await execute_research_ideas(job_payload)
    await persist_research_ideas_result(
        project_id=project_id,
        user_id=(user.get("id") or "").strip(),
        cache_key=cache_key,
        brand_niche=brand_niche,
        intent=intent,
        tone=tone,
        seeds=seeds,
        gl=gl,
        hl=hl,
        result=result,
    )
    return _ideas_response_from_cache(result)
