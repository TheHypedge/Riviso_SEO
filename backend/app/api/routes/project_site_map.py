"""
Per-project site-map routes — Feature 3 (Automated Internal Linking).

The site map is a project-scoped mirror of every published WordPress URL plus
its title and focus keyphrase. It's used by :class:`InternalLinkService` to inject
contextual ``<a>`` tags into newly-generated articles.

In v1 only ingestion + listing are exposed; the link-injection runtime hooks land
together with the matching algorithm in the next iteration.

- ``GET  /api/projects/{project_id}/site-map``       — list current site-map rows
- ``POST /api/projects/{project_id}/site-map/sync``  — re-pull from WordPress REST
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.deps import get_current_user
from app.core.ids import user_ids_equal
from app.legacy.storage import get_legacy_storage_module
from app.services.internal_link_service import InternalLinkService


router = APIRouter(prefix="/projects/{project_id}/site-map", tags=["site-map"])


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
async def list_site_map(project_id: str, user: dict = Depends(get_current_user)) -> dict:
    """List the project's stored site-map rows. ``count`` is the total in storage."""
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    svc = InternalLinkService(project=proj)
    rows = svc.list_site_map(limit=5000)
    return {
        "count": len(rows),
        "entries": rows,
        "wp_site_url": (proj.get("wp_site_url") or proj.get("website_url") or "").strip() or None,
    }


@router.post("/sync")
async def sync_site_map(project_id: str, user: dict = Depends(get_current_user)) -> dict:
    """
    Re-pull the project's published WordPress posts and replace the stored site map.

    Requires the project's WordPress credentials (Settings tab). Falls back to a
    descriptive 400 if anything along the way fails — credentials, network, or REST schema.
    """
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    if not (proj.get("wp_site_url") or proj.get("website_url") or "").strip():
        raise HTTPException(status_code=400, detail="Connect a WordPress site (Settings tab) before syncing the site map.")
    if not (proj.get("wp_username") or "").strip() or not (proj.get("wp_app_password") or "").strip():
        raise HTTPException(status_code=400, detail="WordPress credentials are missing. Add them in Settings before syncing.")

    svc = InternalLinkService(project=proj)
    try:
        return await svc.sync_site_map_from_wp()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e) or "Site-map sync failed") from e
