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
from app.core.project_lookup import require_project_access
from app.legacy.storage import get_legacy_storage_module
from app.services.internal_link_service import InternalLinkService


router = APIRouter(prefix="/projects/{project_id}/site-map", tags=["site-map"])


def _require_project(*, st, user: dict, project_id: str) -> dict:
    # Site-map listing/sync is a content operation — active project collaborators may use it.
    return require_project_access(st=st, user=user, project_id=project_id, full=True, allow_collaborators=True)


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
