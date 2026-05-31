"""
Topic-cluster routes — Feature 2 (Topical Authority Cluster Mapping).

- ``GET  /api/projects/{project_id}/topic-clusters``           — list saved clusters
- ``GET  /api/projects/{project_id}/topic-clusters/{id}``      — fetch one
- ``POST /api/projects/{project_id}/topic-clusters/plan``      — SERP + LLM plan → persisted cluster
- ``POST /api/projects/{project_id}/topic-clusters/{id}/generate-all`` — generate all articles
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.deps import get_current_user
from app.core.project_lookup import require_project_access
from app.legacy.storage import get_legacy_storage_module
from app.schemas.articles import MappedShopifyProductInput
from app.services.async_operation_dispatch import (
    enqueue_cluster_generate_all_job,
    enqueue_topic_cluster_plan_job,
    new_cluster_plan_id,
    should_use_async_queue,
)
from app.services.plan_gatekeeper import PlanAction, require_plan_action
from app.services.topic_cluster_service import TopicClusterService


router = APIRouter(prefix="/projects/{project_id}/topic-clusters", tags=["topic-clusters"])


def _require_project(*, st, user: dict, project_id: str, full: bool = False) -> dict:
    return require_project_access(st=st, user=user, project_id=project_id, full=full)


def _plan_for_user(*, st, user: dict) -> tuple[str, dict]:
    plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
    try:
        plans = st.load_plans() or {}
        plan = plans.get(plan_key) if isinstance(plans, dict) else {}
        if not isinstance(plan, dict):
            plan = {}
    except Exception:
        plan = {}
    return plan_key, plan


def _enforce_cluster_plan_quota(*, st, user: dict) -> None:
    if (user.get("role") or "").strip().lower() == "admin":
        return
    plan_key, plan = _plan_for_user(st=st, user=user)
    if not hasattr(st, "consume_cluster_plan_usage"):
        return
    ok, msg = st.consume_cluster_plan_usage(
        (user.get("id") or "").strip(),
        month_limit=plan.get("max_cluster_plans_per_month"),
        amount=1,
    )
    if not ok:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "quota_exceeded",
                "feature": "cluster_planner",
                "plan_key": plan_key,
                "message": msg or "Monthly Cluster Planner limit reached for your plan.",
            },
        )


@router.get("")
async def list_clusters(project_id: str, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id, full=False)
    svc = TopicClusterService(project=proj, owner_user_id=(user.get("id") or "").strip())
    return {"clusters": svc.list_for_project()}


class TopicClusterPlanPayload(BaseModel):
    """Request body for the cluster planner."""

    seed_intent: str = Field(min_length=3, max_length=500)
    country_code: str = Field(default="IN", min_length=2, max_length=8)
    tone: str = Field(default="informative", max_length=32)
    language: str = Field(default="en", min_length=2, max_length=8)


@router.post("/plan", response_model=None)
async def plan_cluster(
    project_id: str,
    payload: TopicClusterPlanPayload,
    user: dict = Depends(require_plan_action(PlanAction.CLUSTER_PLAN, consume=False)),
) -> dict | JSONResponse:
    """SERP snapshot + LLM topical map → saved cluster (draft)."""
    if not (settings.openai_api_key or "").strip():
        raise HTTPException(status_code=501, detail="OPENAI_API_KEY is not configured on the backend")
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id, full=True)
    _enforce_cluster_plan_quota(st=st, user=user)
    uid = (user.get("id") or "").strip()
    raw = (payload.seed_intent or "").strip()

    plan_payload = {
        "seed_intent": raw,
        "country_code": payload.country_code,
        "tone": payload.tone,
        "language": payload.language,
    }

    if should_use_async_queue() and hasattr(st, "save_topic_cluster"):
        cluster_id = new_cluster_plan_id()
        now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        st.save_topic_cluster(
            {
                "id": cluster_id,
                "project_id": project_id,
                "owner_user_id": uid,
                "seed_intent": raw[:500],
                "country_code": (payload.country_code or "IN").strip().upper()[:8],
                "tone": (payload.tone or "informative").strip()[:32],
                "status": "planning",
                "pillar": {"id": "pillar", "title": raw[:300], "intent": "informational", "keywords": []},
                "clusters": [],
                "created_at": now,
                "updated_at": now,
            }
        )
        job_id = enqueue_topic_cluster_plan_job(
            project_id=project_id,
            cluster_id=cluster_id,
            user_id=uid,
            payload=plan_payload,
        )
        return JSONResponse(
            status_code=202,
            content={
                "status": "queued",
                "job_id": job_id,
                "cluster_id": cluster_id,
                "message": "Cluster planning queued.",
            },
        )

    svc = TopicClusterService(project=proj, owner_user_id=uid)
    try:
        return await svc.plan_and_persist(
            seed_intent=raw,
            country_code=payload.country_code,
            tone=payload.tone,
            language=payload.language,
        )
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cluster planning failed: {e}") from e


@router.get("/{cluster_id}")
async def get_cluster(project_id: str, cluster_id: str, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id, full=False)
    svc = TopicClusterService(project=proj, owner_user_id=(user.get("id") or "").strip())
    row = svc.get(cluster_id)
    if not row:
        raise HTTPException(status_code=404, detail="Topic cluster not found")
    return row


class TopicClusterGenerateAllPayload(BaseModel):
    generate_image: bool = Field(
        default=True,
        description="Whether to generate a featured image per article (slower).",
    )
    writing_prompt_id: str | None = Field(default=None, max_length=64)
    image_prompt_id: str | None = Field(default=None, max_length=64)
    topic_ids: list[str] | None = Field(default=None, max_length=20)
    mapped_products: list[MappedShopifyProductInput] | None = Field(
        default=None,
        max_length=12,
        description="Shopify only: products to weave into each generated article in this batch.",
    )


@router.post("/{cluster_id}/generate-all", response_model=None)
async def generate_all(
    project_id: str,
    cluster_id: str,
    payload: TopicClusterGenerateAllPayload | None = Body(default=None),
    user: dict = Depends(get_current_user),
) -> dict | JSONResponse:
    """Create + generate articles for pillar and clusters missing ``imported_article_id``."""
    if not (settings.openai_api_key or "").strip():
        raise HTTPException(status_code=501, detail="OPENAI_API_KEY is not configured on the backend")
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id, full=True)
    body = payload or TopicClusterGenerateAllPayload()
    cid = (cluster_id or "").strip()
    uid = (user.get("id") or "").strip()

    gen_payload = {
        "generate_image": bool(body.generate_image),
        "writing_prompt_id": (body.writing_prompt_id or "").strip() or None,
        "image_prompt_id": (body.image_prompt_id or "").strip() or None,
        "topic_ids": body.topic_ids,
        "mapped_products": [p.model_dump() for p in body.mapped_products] if body.mapped_products else None,
    }

    if should_use_async_queue():
        if hasattr(st, "update_topic_cluster_fields"):
            st.update_topic_cluster_fields(cid, {"status": "generating"})
        job_id = enqueue_cluster_generate_all_job(
            project_id=project_id,
            cluster_id=cid,
            user_id=uid,
            payload=gen_payload,
        )
        return JSONResponse(
            status_code=202,
            content={
                "status": "queued",
                "job_id": job_id,
                "cluster_id": cid,
                "message": "Cluster batch generation queued.",
            },
        )

    svc = TopicClusterService(project=proj, owner_user_id=uid)
    try:
        return await svc.generate_all(
            user=user,
            cluster_id=cid,
            generate_image=bool(body.generate_image),
            writing_prompt_id=(body.writing_prompt_id or "").strip() or None,
            image_prompt_id=(body.image_prompt_id or "").strip() or None,
            topic_ids=body.topic_ids,
            mapped_products=gen_payload["mapped_products"],
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cluster generation failed: {e}") from e


class TopicClusterImportPayload(BaseModel):
    """Body for ``POST /topic-clusters/{cluster_id}/import``."""

    topic_ids: list[str] | None = Field(
        default=None,
        max_length=20,
        description="Pillar+cluster slot ids to import. ``null`` = every pending topic.",
    )
    schedule_at: str | None = Field(default=None, max_length=64)
    post_type: str | None = Field(default=None, max_length=64)
    wp_status: str = Field(default="draft", max_length=16)
    writing_prompt_id: str | None = Field(default=None, max_length=64)
    image_prompt_id: str | None = Field(default=None, max_length=64)
    generate_image: bool = Field(default=True)


@router.post("/{cluster_id}/import")
async def import_topics(
    project_id: str,
    cluster_id: str,
    payload: TopicClusterImportPayload | None = Body(default=None),
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Insert *pending* article rows for the selected (or all-pending) topics in
    the cluster. Optionally schedule them via ``schedule_at`` (UTC ISO or a
    ``YYYY-MM-DDTHH:mm`` value in the user's timezone).
    """
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id, full=True)
    svc = TopicClusterService(project=proj, owner_user_id=(user.get("id") or "").strip())
    body = payload or TopicClusterImportPayload()
    try:
        return await svc.import_topics(
            user=user,
            cluster_id=(cluster_id or "").strip(),
            topic_ids=body.topic_ids,
            schedule_at=(body.schedule_at or "").strip() or None,
            post_type=(body.post_type or "").strip() or None,
            wp_status=(body.wp_status or "draft").strip().lower(),
            writing_prompt_id=(body.writing_prompt_id or "").strip() or None,
            image_prompt_id=(body.image_prompt_id or "").strip() or None,
            generate_image=bool(body.generate_image),
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cluster import failed: {e}") from e
