"""
Topic-cluster routes — Feature 2 (Topical Authority Cluster Mapping).

v1 surface (CRUD + listing only — generator skeleton):

- ``GET  /api/projects/{project_id}/topic-clusters``           — list saved clusters
- ``GET  /api/projects/{project_id}/topic-clusters/{id}``      — fetch one
- ``POST /api/projects/{project_id}/topic-clusters/plan``      — generate a draft cluster (stub)
- ``POST /api/projects/{project_id}/topic-clusters/{id}/generate-all`` — fan-out (stub)

The two generator endpoints return ``501`` with a friendly message until the SERP
analyzer + LLM decomposition lands. Listing/fetching is fully wired so a
client-side draft (e.g. shipped from local state) can already be persisted via
:meth:`TopicClusterService.persist`.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

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


@router.get("/{cluster_id}")
async def get_cluster(project_id: str, cluster_id: str, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    svc = TopicClusterService(project=proj, owner_user_id=(user.get("id") or "").strip())
    row = svc.get(cluster_id)
    if not row:
        raise HTTPException(status_code=404, detail="Topic cluster not found")
    return row


class TopicClusterPlanPayload(BaseModel):
    """Request body for the (currently stubbed) cluster planner."""

    seed_intent: str = Field(min_length=3, max_length=500)
    country_code: str = Field(default="IN", min_length=2, max_length=8)
    tone: str = Field(default="informative", max_length=32)


@router.post("/plan")
async def plan_cluster(
    project_id: str,
    payload: TopicClusterPlanPayload,
    user: dict = Depends(get_current_user),
) -> dict:
    """Generate a draft cluster (Pillar + 4-6 sub-topics). v1 stub."""
    st = get_legacy_storage_module()
    _require_project(st=st, user=user, project_id=project_id)
    raise HTTPException(
        status_code=501,
        detail=(
            "Topic-cluster planner ships in the next iteration. The schema, persistence layer, "
            "and listing endpoints are already in place — this endpoint will return a saved "
            "cluster row with one Pillar + 4-6 cluster topics once the SERP analyzer is wired."
        ),
    )


@router.post("/{cluster_id}/generate-all")
async def generate_all(
    project_id: str,
    cluster_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """Fan-out generation for the whole cluster. v1 stub."""
    raise HTTPException(
        status_code=501,
        detail=(
            "Cluster fan-out generation ships in the next iteration. Existing per-article generation "
            "remains available via the Articles tab; the bulk path lands once the planner endpoint goes live."
        ),
    )
