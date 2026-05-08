"""
Per-project Google Search Console connection routes.

Each project can connect to its own Google account. The OAuth state token carries
``pid`` so the global ``/api/gsc/oauth/callback`` writes the resulting tokens to
the project record (see :mod:`app.api.routes.gsc`). The endpoints below expose:

- ``GET    /api/projects/{project_id}/gsc/status``      — connection status for this project
- ``GET    /api/projects/{project_id}/gsc/connect-url`` — kick off OAuth (pid baked into state)
- ``GET    /api/projects/{project_id}/gsc/sites``       — list available Search Console properties
- ``POST   /api/projects/{project_id}/gsc/property``    — link a property + indexing toggle
- ``POST   /api/projects/{project_id}/gsc/disconnect``  — clear the project's GSC tokens
- ``GET    /api/projects/{project_id}/gsc/sitemaps``    — list sitemaps registered with the property
- ``POST   /api/projects/{project_id}/gsc/sitemaps``    — submit / re-submit a sitemap URL
- ``DELETE /api/projects/{project_id}/gsc/sitemaps``    — unregister a sitemap URL
- ``GET    /api/projects/{project_id}/gsc/analytics``   — ROI dashboard data (Feature 1)
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


# ---------------------------------------------------------------------------
# Sitemap registration (Google Sitemaps API via per-project OAuth)
# ---------------------------------------------------------------------------


class SitemapSubmitPayload(BaseModel):
    """Optional explicit sitemap URL. Falls back to ``<wp_site_url>/sitemap.xml`` when omitted."""

    sitemap_url: str | None = Field(default=None, max_length=2048)


@router.get("/sitemaps")
async def list_sitemaps(project_id: str, user: dict = Depends(get_current_user)) -> dict:
    """List sitemaps registered against the project's linked Search Console property."""
    from app.services.gsc_actions import list_sitemaps_for_project  # local import to avoid cycles

    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    try:
        sitemaps = await list_sitemaps_for_project(st=st, proj=proj)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e) or "Failed to list sitemaps") from e
    # Surface a sensible default for the UI's "submit" form even before the user types.
    base_site = (proj.get("wp_site_url") or "").strip().rstrip("/")
    suggested = f"{base_site}/sitemap.xml" if base_site else ""
    return {
        "property_url": (proj.get("gsc_property_url") or "").strip() or None,
        "suggested_sitemap_url": suggested or None,
        "sitemaps": sitemaps,
    }


@router.post("/sitemaps")
async def submit_sitemap(
    project_id: str,
    payload: SitemapSubmitPayload,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Register/resubmit a sitemap URL on the project's linked Search Console property.

    With a sitemap registered Google will recrawl it on its own schedule, which means new
    articles get discovered without the user having to click "Index now" per post.
    """
    from app.services.gsc_actions import submit_sitemap_for_project  # local import to avoid cycles

    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    try:
        return await submit_sitemap_for_project(
            st=st,
            proj=proj,
            sitemap_url=(payload.sitemap_url or "").strip(),
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e) or "Sitemap submission failed") from e


@router.delete("/sitemaps")
async def delete_sitemap(
    project_id: str,
    sitemap_url: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """Unregister a previously submitted sitemap URL."""
    from app.services.gsc_actions import delete_sitemap_for_project  # local import to avoid cycles

    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    try:
        return await delete_sitemap_for_project(st=st, proj=proj, sitemap_url=sitemap_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e) or "Sitemap delete failed") from e


# ---------------------------------------------------------------------------
# Search Analytics — Feature 1: GSC ROI Dashboard
# ---------------------------------------------------------------------------


@router.get("/analytics")
async def analytics(
    project_id: str,
    days: int = 30,
    top_pages_limit: int = 25,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    ROI dashboard data: daily clicks/impressions, headline KPIs, top pages, and
    publication markers (one per Riviso article published inside the window whose
    live URL belongs to the linked Search Console property).

    The frontend renders ``series`` as a continuous line and ``markers`` as vertical
    annotations to visualise the lift each new article delivered.
    """
    from datetime import datetime, timedelta
    from app.services.google_console_service import GoogleConsoleService, _normalise_property_for_query
    from app.services.to_thread import run_sync

    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)

    if not (proj.get("gsc_property_url") or "").strip():
        raise HTTPException(status_code=400, detail="Search Console property is not linked for this project. Open Tools → Search Console.")

    try:
        svc = GoogleConsoleService(st=st, project=proj)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e) or "Analytics service is not available") from e

    d = max(7, min(int(days or 30), 365))
    start_iso = (datetime.utcnow() - timedelta(days=d)).strftime("%Y-%m-%d")
    end_iso = datetime.utcnow().strftime("%Y-%m-%d")

    try:
        raw_series = await svc.query_traffic_series(days=d)
        top_pages = await svc.query_top_pages(days=d, limit=top_pages_limit)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e) or "Search Analytics query failed") from e

    series = svc.fill_zero_days(raw_series, start_date=start_iso, end_date=end_iso)
    totals = svc.aggregate_totals(raw_series)

    # Pull article rows once (listing projection — cheap) and compute publication markers.
    articles: list[dict] = []
    if hasattr(st, "load_articles_listing_for_project"):
        try:
            articles = await run_sync(st.load_articles_listing_for_project, project_id, limit=5000)
        except Exception:
            articles = []
    _site, host = _normalise_property_for_query(proj.get("gsc_property_url") or "")
    markers = svc.collect_publication_markers(
        articles, property_host=host, start_date=start_iso, end_date=end_iso,
    )

    return {
        "property_url": (proj.get("gsc_property_url") or "").strip() or None,
        "range": {"start_date": start_iso, "end_date": end_iso, "days": d},
        "totals": totals,
        "series": series,
        "top_pages": top_pages,
        "markers": markers,
    }
