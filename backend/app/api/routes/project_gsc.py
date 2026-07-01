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
from app.core.project_lookup import require_project_access
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


def _require_project(*, st, user: dict, project_id: str, allow_collaborators: bool = False) -> dict:
    # allow_collaborators=True is for read-only content endpoints (status, sitemaps,
    # analytics, insights) that shared collaborators must be able to view. Connect-url,
    # property linking, and disconnect (GSC account setup) keep the default
    # (owner or global-admin only).
    return require_project_access(st=st, user=user, project_id=project_id, full=True, allow_collaborators=allow_collaborators)


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
    proj = _require_project(st=st, user=user, project_id=project_id, allow_collaborators=True)
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
async def connect_url(
    project_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
    frontend_origin: str | None = None,
) -> dict:
    """
    Return a Google OAuth authorization URL for this project.

    ``frontend_origin`` — the caller's ``window.location.origin`` (e.g. ``https://app.riviso.com``).
    When provided and validated, it is baked into the OAuth state token so the callback
    redirects back to the correct frontend host regardless of how FRONTEND_BASE_URL is set.
    """
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    if not gsc_service.oauth_configured():
        raise HTTPException(status_code=400, detail="Google OAuth client is not configured on the backend")
    uid = (user.get("id") or "").strip()

    # Validate the frontend origin against the same allowlist used by CORS.
    from app.api.routes.gsc import _validate_frontend_origin
    validated_origin = _validate_frontend_origin(frontend_origin)
    # Also try to read it from the Origin/Referer header as a fallback.
    if not validated_origin:
        for header_name in ("origin", "referer"):
            raw = (request.headers.get(header_name) or "").strip()
            if raw:
                validated_origin = _validate_frontend_origin(raw)
                if validated_origin:
                    break

    state = gsc_service.make_state_token(
        user_id=uid,
        project_id=(proj.get("id") or "").strip(),
        origin=validated_origin,
    )
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
    proj = _require_project(st=st, user=user, project_id=project_id, allow_collaborators=True)
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
    proj = _require_project(st=st, user=user, project_id=project_id, allow_collaborators=True)
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
    proj = _require_project(st=st, user=user, project_id=project_id, allow_collaborators=True)
    try:
        return await delete_sitemap_for_project(st=st, proj=proj, sitemap_url=sitemap_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e) or "Sitemap delete failed") from e


# ---------------------------------------------------------------------------
# Search Analytics — Feature 1: GSC ROI Dashboard
# ---------------------------------------------------------------------------


_ISO_DATE_RE = __import__("re").compile(r"^\d{4}-\d{2}-\d{2}$")


def _parse_iso_date_or_none(s: str | None) -> str | None:
    """Accept YYYY-MM-DD only; return ``None`` for empty / malformed input."""
    if not s:
        return None
    s = s.strip()
    if not _ISO_DATE_RE.match(s):
        return None
    try:
        from datetime import datetime as _dt
        _dt.strptime(s, "%Y-%m-%d")
    except Exception:
        return None
    return s


@router.get("/analytics")
async def analytics(
    project_id: str,
    days: int = 30,
    top_pages_limit: int = 25,
    start_date: str | None = None,
    end_date: str | None = None,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    ROI dashboard data: daily clicks/impressions, headline KPIs, top pages, and
    publication markers (one per Riviso article published inside the window whose
    live URL belongs to the linked Search Console property).

    Two ways to specify the window:

    - **Preset**: pass ``days=N`` (7-365). Window is ``[today - N, today]``.
    - **Custom**: pass ``start_date=YYYY-MM-DD`` AND ``end_date=YYYY-MM-DD``.
      When both are provided and well-formed, ``days`` is ignored and the
      custom window is used as-is. ``start_date`` must be <= ``end_date`` and
      the maximum window is capped at 16 months (Google's own retention limit).

    The frontend renders ``series`` as a continuous line and ``markers`` as vertical
    annotations to visualise the lift each new article delivered.
    """
    from datetime import datetime, timedelta
    from app.services.google_console_service import GoogleConsoleService, _normalise_property_for_query
    from app.services.to_thread import run_sync

    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id, allow_collaborators=True)

    if not (proj.get("gsc_property_url") or "").strip():
        raise HTTPException(status_code=400, detail="Search Console property is not linked for this project. Open Tools → Search Console.")

    try:
        svc = GoogleConsoleService(st=st, project=proj)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e) or "Analytics service is not available") from e

    # Resolve the effective window. Custom range wins when both ends are valid.
    sd = _parse_iso_date_or_none(start_date)
    ed = _parse_iso_date_or_none(end_date)
    if (start_date or end_date) and not (sd and ed):
        raise HTTPException(status_code=400, detail="start_date and end_date must both be YYYY-MM-DD")
    if sd and ed:
        if sd > ed:
            raise HTTPException(status_code=400, detail="start_date cannot be after end_date")
        # Sanity cap — GSC Search Analytics retains ~16 months max.
        try:
            span = (datetime.strptime(ed, "%Y-%m-%d") - datetime.strptime(sd, "%Y-%m-%d")).days
        except Exception:
            span = 0
        if span > 16 * 31:
            raise HTTPException(status_code=400, detail="Custom range cannot exceed 16 months (Search Console retention limit)")
        start_iso, end_iso = sd, ed
        d = span + 1
    else:
        d = max(7, min(int(days or 30), 365))
        start_iso = (datetime.utcnow() - timedelta(days=d)).strftime("%Y-%m-%d")
        end_iso = datetime.utcnow().strftime("%Y-%m-%d")

    try:
        raw_series = await svc.query_traffic_series(start_date=start_iso, end_date=end_iso)
        top_pages = await svc.query_top_pages(start_date=start_iso, end_date=end_iso, limit=top_pages_limit)
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


# ---------------------------------------------------------------------------
# Search Analytics — Feature 2: GSC Insights (pages, queries, countries, sources)
# ---------------------------------------------------------------------------

# ISO 3166-1 alpha-3 → (display name, alpha-2) for flag emoji derivation.
_COUNTRY_MAP: dict[str, tuple[str, str]] = {
    "gbr": ("United Kingdom", "GB"), "usa": ("United States", "US"),
    "ind": ("India", "IN"), "can": ("Canada", "CA"),
    "aus": ("Australia", "AU"), "deu": ("Germany", "DE"),
    "fra": ("France", "FR"), "irl": ("Ireland", "IE"),
    "pak": ("Pakistan", "PK"), "bel": ("Belgium", "BE"),
    "nld": ("Netherlands", "NL"), "sgp": ("Singapore", "SG"),
    "zaf": ("South Africa", "ZA"), "nga": ("Nigeria", "NG"),
    "ken": ("Kenya", "KE"), "esp": ("Spain", "ES"),
    "ita": ("Italy", "IT"), "phl": ("Philippines", "PH"),
    "nzl": ("New Zealand", "NZ"), "mys": ("Malaysia", "MY"),
    "bgd": ("Bangladesh", "BD"), "lka": ("Sri Lanka", "LK"),
    "are": ("UAE", "AE"), "sau": ("Saudi Arabia", "SA"),
    "bra": ("Brazil", "BR"), "mex": ("Mexico", "MX"),
    "arg": ("Argentina", "AR"), "jpn": ("Japan", "JP"),
    "chn": ("China", "CN"), "kor": ("South Korea", "KR"),
    "swe": ("Sweden", "SE"), "nor": ("Norway", "NO"),
    "dnk": ("Denmark", "DK"), "fin": ("Finland", "FI"),
    "pol": ("Poland", "PL"), "ukr": ("Ukraine", "UA"),
    "tur": ("Turkey", "TR"), "rus": ("Russia", "RU"),
    "idn": ("Indonesia", "ID"), "tha": ("Thailand", "TH"),
    "vnm": ("Vietnam", "VN"), "gha": ("Ghana", "GH"),
    "uga": ("Uganda", "UG"), "tza": ("Tanzania", "TZ"),
    "eth": ("Ethiopia", "ET"), "egy": ("Egypt", "EG"),
    "mar": ("Morocco", "MA"), "prt": ("Portugal", "PT"),
    "grc": ("Greece", "GR"), "cze": ("Czech Republic", "CZ"),
    "hun": ("Hungary", "HU"), "rou": ("Romania", "RO"),
    "bgr": ("Bulgaria", "BG"), "hrv": ("Croatia", "HR"),
    "svk": ("Slovakia", "SK"), "svn": ("Slovenia", "SI"),
    "est": ("Estonia", "EE"), "lva": ("Latvia", "LV"),
    "ltu": ("Lithuania", "LT"), "isl": ("Iceland", "IS"),
    "chl": ("Chile", "CL"), "col": ("Colombia", "CO"),
    "per": ("Peru", "PE"), "ven": ("Venezuela", "VE"),
    "ury": ("Uruguay", "UY"), "pry": ("Paraguay", "PY"),
}


def _alpha2_to_flag(code: str) -> str:
    """Convert ISO 3166-1 alpha-2 country code to Unicode flag emoji."""
    c = (code or "").strip().upper()
    if len(c) != 2 or not c.isalpha():
        return ""
    return chr(0x1F1E6 + ord(c[0]) - ord("A")) + chr(0x1F1E6 + ord(c[1]) - ord("A"))


def _normalise_country(raw: str) -> dict[str, str]:
    """Return display name and flag for a GSC alpha-3 country code."""
    key = (raw or "").strip().lower()
    name, alpha2 = _COUNTRY_MAP.get(key, (key.upper(), ""))
    return {"country_code": key, "country_name": name, "flag": _alpha2_to_flag(alpha2)}


def _change_pct(current: float, previous: float) -> float | None:
    """Percentage change; None when there is no previous baseline."""
    if previous <= 0:
        return None
    return round((current - previous) / previous * 100, 1)


def _build_comparison_rows(
    current_rows: list[dict],
    prev_rows: list[dict],
    key_field: str,
    limit: int = 25,
) -> list[dict]:
    """
    Merge current-period and previous-period rows on ``key_field`` and annotate
    each row with ``prev_clicks``, ``change_pct``, and ``trend``.
    """
    prev_map = {r.get(key_field, ""): int(r.get("clicks") or 0) for r in prev_rows}
    out = []
    for r in current_rows[:limit]:
        key = r.get(key_field, "")
        cur_clicks = int(r.get("clicks") or 0)
        prv_clicks = prev_map.get(key, 0)
        chg = _change_pct(cur_clicks, prv_clicks)
        trend = "neutral"
        if chg is not None:
            trend = "up" if chg > 0 else ("down" if chg < 0 else "neutral")
        out.append({
            key_field: key,
            "clicks": cur_clicks,
            "impressions": int(r.get("impressions") or 0),
            "ctr": float(r.get("ctr") or 0.0),
            "position": float(r.get("position") or 0.0),
            "prev_clicks": prv_clicks,
            "change_pct": chg,
            "trend": trend,
        })
    return out


@router.get("/insights")
async def insights(
    project_id: str,
    days: int = 28,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    GSC Insights panel data — comparable to Google's own Insights page.

    Returns headline click/impression totals for the current window and the
    immediately preceding window of the same length, plus:
    - ``pages``  — top pages by clicks with change vs previous period
    - ``queries`` — top search queries with change vs previous period
    - ``countries`` — clicks by country (current period)
    - ``traffic_sources`` — web vs image vs video vs news search types
    """
    from datetime import datetime, timedelta
    from app.services.google_console_service import GoogleConsoleService, _normalise_property_for_query
    from app.services.to_thread import run_sync

    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id, allow_collaborators=True)

    if not (proj.get("gsc_property_url") or "").strip():
        raise HTTPException(
            status_code=400,
            detail="Search Console property is not linked for this project. Open Tools → Search Console.",
        )

    try:
        svc = GoogleConsoleService(st=st, project=proj)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e) or "Analytics service is not available") from e

    d = max(7, min(int(days or 28), 365))
    today = datetime.utcnow()
    end_iso = today.strftime("%Y-%m-%d")
    start_iso = (today - timedelta(days=d)).strftime("%Y-%m-%d")
    prev_end = (today - timedelta(days=d + 1)).strftime("%Y-%m-%d")
    prev_start = (today - timedelta(days=d * 2 + 1)).strftime("%Y-%m-%d")

    try:
        # All queries fire concurrently via asyncio
        import asyncio
        (
            cur_series,
            prev_series,
            cur_pages,
            prev_pages,
            cur_queries,
            prev_queries,
            cur_countries,
            image_rows,
        ) = await asyncio.gather(
            svc.query_traffic_totals(start_date=start_iso, end_date=end_iso),
            svc.query_traffic_totals(start_date=prev_start, end_date=prev_end),
            svc.query_by_dimension(start_date=start_iso, end_date=end_iso, dimension="page", limit=50),
            svc.query_by_dimension(start_date=prev_start, end_date=prev_end, dimension="page", limit=50),
            svc.query_by_dimension(start_date=start_iso, end_date=end_iso, dimension="query", limit=50),
            svc.query_by_dimension(start_date=prev_start, end_date=prev_end, dimension="query", limit=50),
            svc.query_by_dimension(start_date=start_iso, end_date=end_iso, dimension="country", limit=10),
            svc.query_by_dimension(
                start_date=start_iso, end_date=end_iso, dimension="page",
                limit=10, search_type="IMAGE"
            ),
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e) or "Insights query failed") from e

    # Headline comparison
    headline = {
        "clicks": {
            "value": int(cur_series.get("clicks") or 0),
            "prev": int(prev_series.get("clicks") or 0),
            "change_pct": _change_pct(
                float(cur_series.get("clicks") or 0),
                float(prev_series.get("clicks") or 0),
            ),
        },
        "impressions": {
            "value": int(cur_series.get("impressions") or 0),
            "prev": int(prev_series.get("impressions") or 0),
            "change_pct": _change_pct(
                float(cur_series.get("impressions") or 0),
                float(prev_series.get("impressions") or 0),
            ),
        },
    }

    # Pages with comparison
    pages = _build_comparison_rows(cur_pages, prev_pages, "page", limit=25)

    # Queries with comparison
    queries = _build_comparison_rows(cur_queries, prev_queries, "query", limit=25)

    # Countries — add display name + flag + share %
    total_clicks = max(1, sum(int(r.get("clicks") or 0) for r in cur_countries))
    countries = []
    for r in cur_countries[:10]:
        c = _normalise_country(r.get("country", ""))
        clicks = int(r.get("clicks") or 0)
        countries.append({
            **c,
            "clicks": clicks,
            "share_pct": round(clicks / total_clicks * 100, 1),
        })

    # Additional traffic sources — image search
    image_clicks = sum(int(r.get("clicks") or 0) for r in image_rows)
    traffic_sources = []
    if image_clicks > 0:
        traffic_sources.append({"source": "Image search", "source_type": "image", "clicks": image_clicks})

    return {
        "property_url": (proj.get("gsc_property_url") or "").strip() or None,
        "period": {"start_date": start_iso, "end_date": end_iso, "days": d},
        "prev_period": {"start_date": prev_start, "end_date": prev_end, "days": d},
        "headline": headline,
        "pages": pages,
        "queries": queries,
        "countries": countries,
        "traffic_sources": traffic_sources,
    }
