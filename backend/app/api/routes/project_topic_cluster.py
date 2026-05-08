"""
Topic-cluster routes — Feature 2 (Topical Authority Cluster Mapping).

- ``GET  /api/projects/{project_id}/topic-clusters``           — list saved clusters
- ``GET  /api/projects/{project_id}/topic-clusters/{id}``      — fetch one
- ``POST /api/projects/{project_id}/topic-clusters/plan``      — SERP + LLM plan → persisted cluster
- ``POST /api/projects/{project_id}/topic-clusters/{id}/generate-all`` — generate all articles
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.deps import get_current_user
from app.core.ids import user_ids_equal
from app.legacy.storage import get_legacy_storage_module
from app.services.topic_cluster_service import TopicClusterService


router = APIRouter(prefix="/projects/{project_id}/topic-clusters", tags=["topic-clusters"])


def _require_project(*, st, user: dict, project_id: str) -> dict:
    pid = (project_id or "").strip()
    if not pid:
        raise HTTPException(status_code=404, detail="Project not found")
    proj = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    if not isinstance(proj, dict):
        raise HTTPException(status_code=404, detail="Project not found")
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role != "admin" and not user_ids_equal(proj.get("owner_user_id"), uid):
        raise HTTPException(status_code=404, detail="Project not found")
    return proj


@router.get("")
async def list_clusters(project_id: str, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    svc = TopicClusterService(project=proj, owner_user_id=(user.get("id") or "").strip())
    return {"clusters": svc.list_for_project()}


class TopicClusterPlanPayload(BaseModel):
    """Request body for the cluster planner."""

    seed_intent: str = Field(min_length=3, max_length=500)
    country_code: str = Field(default="IN", min_length=2, max_length=8)
    tone: str = Field(default="informative", max_length=32)
    language: str = Field(default="en", min_length=2, max_length=8)


@router.post("/plan")
async def plan_cluster(
    project_id: str,
    payload: TopicClusterPlanPayload,
    user: dict = Depends(get_current_user),
) -> dict:
    """SERP snapshot + LLM topical map → saved cluster (draft)."""
    if not (settings.openai_api_key or "").strip():
        raise HTTPException(status_code=501, detail="OPENAI_API_KEY is not configured on the backend")
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    svc = TopicClusterService(project=proj, owner_user_id=(user.get("id") or "").strip())
    try:
        return await svc.plan_and_persist(
            seed_intent=payload.seed_intent,
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
    proj = _require_project(st=st, user=user, project_id=project_id)
    svc = TopicClusterService(project=proj, owner_user_id=(user.get("id") or "").strip())
    row = svc.get(cluster_id)
    if not row:
        raise HTTPException(status_code=404, detail="Topic cluster not found")
    return row


class TopicClusterGenerateAllPayload(BaseModel):
    generate_image: bool = Field(
        default=False,
        description="Whether to generate a featured image per article (slower).",
    )
    writing_prompt_id: str | None = Field(default=None, max_length=64)
    # ``None`` (omitted) means "every pending topic in the cluster". When
    # provided, only the pillar (slot id = pillar id) and cluster topic ids
    # listed here are generated; the rest stay pending.
    topic_ids: list[str] | None = Field(default=None, max_length=20)


@router.post("/{cluster_id}/generate-all")
async def generate_all(
    project_id: str,
    cluster_id: str,
    payload: TopicClusterGenerateAllPayload | None = Body(default=None),
    user: dict = Depends(get_current_user),
) -> dict:
    """Create + generate articles for pillar and clusters missing ``imported_article_id``."""
    if not (settings.openai_api_key or "").strip():
        raise HTTPException(status_code=501, detail="OPENAI_API_KEY is not configured on the backend")
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    svc = TopicClusterService(project=proj, owner_user_id=(user.get("id") or "").strip())
    body = payload or TopicClusterGenerateAllPayload()
    try:
        return await svc.generate_all(
            user=user,
            cluster_id=(cluster_id or "").strip(),
            generate_image=bool(body.generate_image),
            writing_prompt_id=(body.writing_prompt_id or "").strip() or None,
            topic_ids=body.topic_ids,
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
    # When set, the imported articles are also added to the scheduler so the
    # backend will generate + publish them at this UTC instant. Subsequent
    # imports in the batch are staggered 5 minutes apart.
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

    Cheap and **quota-free** when not scheduled (no LLM invocation), so users
    can stage drafts without burning generation credits. Scheduling each
    imported topic consumes the user's monthly schedule quota when their plan
    enforces one.
    """
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
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
