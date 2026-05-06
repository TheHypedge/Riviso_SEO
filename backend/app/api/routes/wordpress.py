from __future__ import annotations

import base64
import io
import os
import zipfile
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response

from app.core.deps import get_current_user
from app.core.ids import user_ids_equal
from app.legacy.storage import get_legacy_storage_module
from app.schemas.wordpress import WordpressCategory, WordpressPostType
from app.services.wordpress_client import WordpressClient
from app.schemas.project_settings import (
    ProjectSettingsPublic,
    ProjectSettingsUpdate,
    WordpressVerifyRequest,
    WordpressVerifyResponse,
)
from app.services import gsc

router = APIRouter(tags=["wordpress"])

_WP_REST_TIMEOUT_S = 45.0


def _wp_upstream_error_detail(exc: httpx.HTTPStatusError) -> str:
    """Human-readable reason from WordPress REST error responses."""
    code = exc.response.status_code
    suffix = ""
    try:
        data = exc.response.json()
        if isinstance(data, dict):
            msg = (data.get("message") or "").strip()
            if msg:
                suffix = f" {msg}"
            elif (data.get("code") or "").strip():
                suffix = f" ({(data.get('code') or '').strip()})"
    except Exception:
        pass
    if code in (401, 403):
        return (
            f"WordPress returned HTTP {code} (not authorized for the REST API).{suffix} "
            "Check the site URL, username, and Application Password in Project Settings (WordPress: Users → Profile → Application Passwords). "
            "Spaces in the app password are ignored; regenerate the password if unsure."
        )
    return (f"WordPress returned HTTP {code}.{suffix}").strip()


async def _wp_get_json(wp: WordpressClient, path: str) -> Any:
    """Fetch WP REST JSON; never crash the ASGI worker on timeouts / network errors."""
    try:
        return await wp.get_json(path, timeout=_WP_REST_TIMEOUT_S)
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504,
            detail="WordPress REST API timed out (slow or overloaded site). Retry in a moment.",
        ) from None
    except httpx.HTTPStatusError as e:
        code = e.response.status_code
        detail = _wp_upstream_error_detail(e)
        # Do not map WP 401 to HTTP 401 here: our SPA treats any API 401 as JWT expiry and refreshes the session.
        if code in (401, 403):
            raise HTTPException(status_code=403, detail=detail) from None
        if code == 404:
            raise HTTPException(status_code=404, detail=detail) from None
        if code == 429:
            raise HTTPException(status_code=429, detail=detail) from None
        if code >= 500:
            raise HTTPException(status_code=502, detail=detail) from None
        raise HTTPException(status_code=400, detail=detail) from None
    except httpx.RequestError as e:
        raise HTTPException(status_code=503, detail=f"Could not reach WordPress: {e}") from None


def _normalize_url(raw: str | None) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    if not (s.startswith("http://") or s.startswith("https://")):
        s = "https://" + s
    return s[:2048].rstrip("/")


def _require_project_access(*, st, user: dict, project_id: str) -> dict:
    pid = (project_id or "").strip()
    proj = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role != "admin" and not user_ids_equal(proj.get("owner_user_id"), uid):
        raise HTTPException(status_code=404, detail="Project not found")
    return proj


def _get_wp_client_for_project(proj: dict) -> WordpressClient:
    wp_site_url = _normalize_url(proj.get("wp_site_url") or proj.get("website_url") or "")
    wp_username = (proj.get("wp_username") or "").strip()
    wp_app_password = (proj.get("wp_app_password") or "").replace(" ", "").strip()
    if not wp_site_url:
        raise HTTPException(status_code=400, detail="Missing WordPress site URL in project settings")
    if not wp_username or not wp_app_password:
        raise HTTPException(status_code=400, detail="Missing WordPress username/app password in project settings")
    try:
        return WordpressClient(site_url=wp_site_url, username=wp_username, app_password=wp_app_password)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/wordpress/plugin/download")
async def download_plugin() -> Response:
    """
    Download the WordPress connector plugin as a zip.
    """
    # Repo root: backend/app/api/routes/wordpress.py -> backend/app/api/routes -> backend/app/api -> backend/app -> backend -> repo
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(here, "..", "..", "..", ".."))
    # Production (Docker) includes `backend/` but may not include repo-root `wordpress_plugin/`.
    plugin_dir_candidates = [
        os.path.join(repo_root, "backend", "wordpress_plugin", "riviso-content-operations"),
        os.path.join(repo_root, "wordpress_plugin", "riviso-content-operations"),
    ]
    plugin_dir = next((p for p in plugin_dir_candidates if os.path.isdir(p)), "")
    if not plugin_dir:
        raise HTTPException(status_code=404, detail="Plugin directory not found on server")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for root, _dirs, files in os.walk(plugin_dir):
            for fn in files:
                abs_path = os.path.join(root, fn)
                rel = os.path.relpath(abs_path, os.path.dirname(plugin_dir))
                z.write(abs_path, rel)
    data = buf.getvalue()
    filename = "Riviso - Content Operations.zip"
    headers = {
        "content-disposition": f'attachment; filename="{filename}"; filename*=UTF-8\'\'Riviso%20-%20Content%20Operations.zip'
    }
    return Response(content=data, media_type="application/zip", headers=headers)


@router.get("/projects/{project_id}/settings", response_model=ProjectSettingsPublic)
async def get_project_settings(project_id: str, user: dict = Depends(get_current_user)) -> ProjectSettingsPublic:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    pid = (proj.get("id") or "").strip()
    wp_site_url = _normalize_url(proj.get("wp_site_url") or proj.get("website_url") or "")
    wp_user = (proj.get("wp_username") or "").strip() or None
    app_pw = (proj.get("wp_app_password") or "").strip()
    def_rest = (proj.get("default_wp_rest_base") or "").strip() or None
    def_status = (proj.get("default_wp_status") or "").strip().lower() or None
    cat_raw = (proj.get("wp_category_ids") or "").strip()
    cats: list[int] = []
    for part in cat_raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            cats.append(int(part))
        except (TypeError, ValueError):
            continue
    cats = list(dict.fromkeys([x for x in cats if x > 0]))[:50]
    gsc_prop = (proj.get("gsc_property_url") or "").strip() or None
    gsc_index = bool(proj.get("gsc_index_on_publish", True))
    return ProjectSettingsPublic(
        id=pid,
        name=(proj.get("name") or "").strip(),
        website_url=(proj.get("website_url") or "").strip() or None,
        wp_site_url=wp_site_url or None,
        wp_username=wp_user,
        wp_app_password_set=bool(app_pw),
        plugin_download_url="/api/wordpress/plugin/download",
        default_wp_rest_base=def_rest,
        default_wp_status=def_status,
        default_wp_category_ids=cats,
        gsc_property_url=gsc_prop,
        gsc_index_on_publish=gsc_index,
    )


@router.patch("/projects/{project_id}/settings", response_model=ProjectSettingsPublic)
async def update_project_settings(
    project_id: str,
    payload: ProjectSettingsUpdate,
    user: dict = Depends(get_current_user),
) -> ProjectSettingsPublic:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    pid = (proj.get("id") or "").strip()

    updates: dict = {}
    if payload.name is not None:
        updates["name"] = payload.name.strip()[:200]
    if payload.website_url is not None:
        url = _normalize_url(payload.website_url)
        updates["website_url"] = url
        updates.setdefault("wp_site_url", url)
    if payload.wp_site_url is not None:
        updates["wp_site_url"] = _normalize_url(payload.wp_site_url)
    if payload.wp_username is not None:
        updates["wp_username"] = payload.wp_username.strip()[:200]
    if payload.wp_app_password is not None:
        # Application passwords are often typed with spaces; normalize.
        updates["wp_app_password"] = (payload.wp_app_password or "").replace(" ", "").strip()[:500]
    if payload.default_wp_rest_base is not None:
        updates["default_wp_rest_base"] = (payload.default_wp_rest_base or "").strip()[:200]
    if payload.default_wp_status is not None:
        updates["default_wp_status"] = (payload.default_wp_status or "").strip().lower()[:16]
    if payload.default_wp_category_ids is not None:
        ids = []
        for x in payload.default_wp_category_ids:
            try:
                n = int(x)
            except (TypeError, ValueError):
                continue
            if n > 0:
                ids.append(n)
        ids = list(dict.fromkeys(ids))[:50]
        updates["wp_category_ids"] = ",".join(str(x) for x in ids)

    if payload.gsc_index_on_publish is not None:
        updates["gsc_index_on_publish"] = bool(payload.gsc_index_on_publish)

    if payload.gsc_property_url is not None:
        prop = (payload.gsc_property_url or "").strip()[:2048]
        if not prop:
            updates["gsc_property_url"] = ""
        else:
            # Best-effort validation: property must be visible in the user's connected account.
            # If Google isn't connected, allow saving anyway (user can connect later).
            try:
                uid = (user.get("id") or "").strip()
                if uid and hasattr(st, "get_user_by_id"):
                    u = st.get_user_by_id(uid) or {}
                    rt = (u.get("gsc_refresh_token") or "").strip()
                    if rt and gsc.oauth_configured():
                        # Use GSC routes helper to refresh token by reusing service functions directly.
                        # We accept property even if list fails, to avoid blocking settings saves.
                        pass
            except Exception:
                pass
            updates["gsc_property_url"] = prop

    if updates:
        st.update_project_fields(pid, updates)

    fresh = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    if not fresh:
        raise HTTPException(status_code=404, detail="Project not found")
    return await get_project_settings(project_id=pid, user=user)


@router.post("/projects/{project_id}/wordpress/verify", response_model=WordpressVerifyResponse)
async def verify_wordpress_connection(
    project_id: str,
    payload: WordpressVerifyRequest,
    user: dict = Depends(get_current_user),
) -> WordpressVerifyResponse:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)

    wp_site_url = _normalize_url(payload.wp_site_url) or _normalize_url(proj.get("wp_site_url") or proj.get("website_url") or "")
    wp_username = (payload.wp_username or "").strip() or (proj.get("wp_username") or "").strip()
    wp_app_password = ((payload.wp_app_password or "") if payload.wp_app_password is not None else (proj.get("wp_app_password") or "")).replace(" ", "").strip()

    if not wp_site_url:
        raise HTTPException(status_code=400, detail="Missing WordPress site URL")
    if not wp_username or not wp_app_password:
        raise HTTPException(status_code=400, detail="Missing WordPress username or application password")

    url = f"{wp_site_url}/wp-json/wp/v2/users/me?context=edit"
    basic = base64.b64encode(f"{wp_username}:{wp_app_password}".encode("utf-8")).decode("ascii")
    headers = {"authorization": f"Basic {basic}"}

    try:
        async with httpx.AsyncClient(timeout=12.0, follow_redirects=True) as client:
            res = await client.get(url, headers=headers)
    except Exception as e:
        return WordpressVerifyResponse(ok=False, status="error", message=f"Could not reach WordPress site: {e}")

    if res.status_code == 200:
        # Best-effort: verify that our connector plugin is installed (Yoast REST meta + ping endpoint).
        plugin_msg = ""
        try:
            ping_url = f"{wp_site_url}/wp-json/auto-articles/v1/ping"
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                pres = await client.get(ping_url, headers=headers)
            if pres.status_code == 200:
                pdata = pres.json() if pres.content else {}
                cid = (pdata.get("connector_id") or "").strip() if isinstance(pdata, dict) else ""
                yoast = None
                if isinstance(pdata, dict):
                    yoast = pdata.get("yoast_active")
                plugin_msg = f"\nPlugin: installed (connector_id={cid or '—'}, yoast_active={yoast})"
            else:
                plugin_msg = "\nPlugin: not detected (install Auto Articles Connector plugin, then verify again)."
        except Exception:
            plugin_msg = "\nPlugin: not detected (install Auto Articles Connector plugin, then verify again)."

        return WordpressVerifyResponse(ok=True, status="connected", message="Verified WordPress connection successfully." + plugin_msg)
    if res.status_code in {401, 403}:
        return WordpressVerifyResponse(ok=False, status="auth_failed", message="WordPress authentication failed. Check username/app password and site URL.")
    return WordpressVerifyResponse(ok=False, status="failed", message=f"WordPress verification failed ({res.status_code}).")


@router.get("/projects/{project_id}/wordpress/post-types", response_model=list[WordpressPostType])
async def wordpress_post_types(project_id: str, user: dict = Depends(get_current_user)) -> list[WordpressPostType]:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    wp = _get_wp_client_for_project(proj)
    data = await _wp_get_json(wp, "/wp-json/wp/v2/types?context=edit")
    out: list[WordpressPostType] = []
    if isinstance(data, dict):
        for _, t in data.items():
            if not isinstance(t, dict):
                continue
            # Some WP sites return `show_in_rest: null` here even for valid types (posts/pages).
            # Only exclude when it is explicitly False.
            if t.get("show_in_rest") is False:
                continue
            rest_base = (t.get("rest_base") or "").strip()
            if not rest_base:
                continue
            vis = t.get("visibility") or {}
            public = None
            if isinstance(vis, dict):
                public = vis.get("public")
            # Keep only public-facing types (and always keep posts/pages).
            if rest_base not in {"posts", "pages"} and public is False:
                continue
            out.append(
                WordpressPostType(
                    rest_base=rest_base,
                    name=(t.get("name") or "").strip(),
                    taxonomies=[str(x) for x in (t.get("taxonomies") or []) if str(x).strip()],
                )
            )
    out.sort(key=lambda x: x.name.lower() or x.rest_base.lower())
    return out


@router.get("/projects/{project_id}/wordpress/categories", response_model=list[WordpressCategory])
async def wordpress_categories(project_id: str, user: dict = Depends(get_current_user)) -> list[WordpressCategory]:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    wp = _get_wp_client_for_project(proj)
    data = await _wp_get_json(wp, "/wp-json/wp/v2/categories?per_page=100&context=edit")
    out: list[WordpressCategory] = []
    if isinstance(data, list):
        for c in data:
            if isinstance(c, dict) and isinstance(c.get("id"), int):
                out.append(WordpressCategory(id=int(c["id"]), name=(c.get("name") or "").strip()))
    out.sort(key=lambda x: x.name.lower())
    return out

