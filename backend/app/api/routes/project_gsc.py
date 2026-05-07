"""
Per-project Google Search Console connection routes.

Each project can connect to its own Google account. The OAuth state token carries
``pid`` so the global ``/api/gsc/oauth/callback`` writes the resulting tokens to
the project record (see :mod:`app.api.routes.gsc`). The endpoints below expose:

- ``GET /api/projects/{project_id}/gsc/status``       — connection status for this project
- ``GET /api/projects/{project_id}/gsc/connect-url``  — kick off OAuth (pid baked into state)
- ``GET /api/projects/{project_id}/gsc/sites``        — list available Search Console properties
- ``POST /api/projects/{project_id}/gsc/property``    — link a property + indexing toggle
- ``POST /api/projects/{project_id}/gsc/disconnect``  — clear the project's GSC tokens
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.deps import get_current_user
from app.core.ids import user_ids_equal
from app.legacy.storage import get_legacy_storage_module
from app.services import gsc as gsc_service


router = APIRouter(prefix="/projects/{project_id}/gsc", tags=["gsc-project"])


def _public_api_url(path: str) -> str:
    base = (str(settings.public_base_url) if settings.public_base_url else "").strip().rstrip("/")
    if not base:
        return (path or "").strip()
    from urllib.parse import urlparse, urlunparse

    p0 = (path or "").strip()
    b = urlparse(base)
    u = urlparse(p0)
    if u.scheme and u.netloc:
        return urlunparse((b.scheme, b.netloc, u.path, u.params, u.query, u.fragment))
    p = p0 if p0.startswith("/") else f"/{p0}"
    return f"{base}{p}"


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


# ---------------------------------------------------------------------------


class ProjectGscStatus(BaseModel):
    configured: bool
    connected: bool
    email: str | None = None
    connected_at: str | None = None
    property_url: str | None = None
    index_on_publish: bool = True


@router.get("/status", response_model=ProjectGscStatus)
async def status(project_id: str, user: dict = Depends(get_current_user)) -> ProjectGscStatus:
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    rt = (proj.get("gsc_refresh_token") or "").strip()
    return ProjectGscStatus(
        configured=gsc_service.oauth_configured(),
        connected=bool(rt),
        email=(proj.get("gsc_email") or "").strip() or None,
        connected_at=(proj.get("gsc_connected_at") or "").strip() or None,
        property_url=(proj.get("gsc_property_url") or "").strip() or None,
        index_on_publish=bool(proj.get("gsc_index_on_publish", True)),
    )


@router.get("/connect-url")
async def connect_url(project_id: str, request: Request, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    if not gsc_service.oauth_configured():
        raise HTTPException(status_code=400, detail="Google OAuth client is not configured on the backend")
    uid = (user.get("id") or "").strip()
    state = gsc_service.make_state_token(user_id=uid, project_id=(proj.get("id") or "").strip())
    redirect_uri = _public_api_url(str(request.url_for("gsc_oauth_callback")))
    url = gsc_service.build_auth_url(redirect_uri=redirect_uri, state=state)
    return {"url": url}


@router.post("/disconnect")
async def disconnect(project_id: str, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    if hasattr(st, "update_project_fields"):
        st.update_project_fields(
            (proj.get("id") or "").strip(),
            {
                "gsc_access_token": "",
                "gsc_refresh_token": "",
                "gsc_token_expires_at": "",
                "gsc_scope": "",
                "gsc_email": "",
                "gsc_connected_at": "",
                "gsc_property_url": "",
            },
        )
    return {"ok": True, "disconnected_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")}


@router.get("/sites")
async def list_sites(project_id: str, user: dict = Depends(get_current_user)) -> list[dict]:
    """List Search Console properties available to the project's connected Google account."""
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    if not gsc_service.oauth_configured():
        raise HTTPException(status_code=400, detail="Google OAuth client is not configured on the backend")

    # Resolve a token: project first, fallback to owner user, similar to gsc_actions.
    from app.services.gsc_actions import _get_valid_access_token_for_project  # local import to avoid cycles

    try:
        access_token, _src = await _get_valid_access_token_for_project(st=st, proj=proj)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e) or "Search Console is not connected for this project") from e
    return await gsc_service.list_search_console_sites(access_token=access_token)


class GscPropertyUpdate(BaseModel):
    property_url: str | None = Field(default=None, max_length=2048)
    index_on_publish: bool | None = None


@router.post("/property")
async def set_property(project_id: str, payload: GscPropertyUpdate, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    updates: dict = {}
    if payload.property_url is not None:
        updates["gsc_property_url"] = (payload.property_url or "").strip()[:2048]
    if payload.index_on_publish is not None:
        updates["gsc_index_on_publish"] = bool(payload.index_on_publish)
    if updates and hasattr(st, "update_project_fields"):
        st.update_project_fields((proj.get("id") or "").strip(), updates)
    return {
        "ok": True,
        "property_url": (updates.get("gsc_property_url") or proj.get("gsc_property_url") or "") or None,
        "index_on_publish": bool(updates.get("gsc_index_on_publish", proj.get("gsc_index_on_publish", True))),
    }
