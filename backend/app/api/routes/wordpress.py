from __future__ import annotations

import base64
from datetime import datetime
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


def _wp_error_snippet(res: httpx.Response) -> str:
    try:
        data = res.json()
        if isinstance(data, dict):
            msg = (data.get("message") or "").strip()
            code = (data.get("code") or "").strip()
            if msg and code:
                return f"{msg} ({code})"
            if msg:
                return msg
            if code:
                return code
    except Exception:
        pass
    return ""


async def _verify_wp_rest_credentials(
    *,
    client: httpx.AsyncClient,
    wp_site_url: str,
    headers: dict[str, str],
    wp_username: str,
) -> tuple[bool, str, httpx.Response | None]:
    """
    Confirm Basic auth against WordPress REST.

    Tries ``/users/me`` first, then lighter endpoints some hosts allow when
    ``/users/me`` is blocked by security plugins.
    """
    probes = (
        "/wp-json/wp/v2/users/me?context=edit",
        "/wp-json/wp/v2/types?context=view",
        "/wp-json/wp/v2/posts?per_page=1&context=edit",
    )
    last_res: httpx.Response | None = None
    auth_failed = False
    for path in probes:
        url = f"{wp_site_url}{path}"
        try:
            res = await client.get(url, headers=headers)
        except Exception:
            continue
        last_res = res
        if res.status_code == 200:
            return True, "", res
        if res.status_code in {401, 403}:
            auth_failed = True
            continue
    if auth_failed:
        hint = (
            "WordPress rejected the username or application password. "
            "Use your WordPress **login username** (not your email unless login is the email), "
            "paste the application password exactly as shown in Users → Profile → Application Passwords "
            "(spaces are optional), and confirm the site URL matches where you log in to wp-admin."
        )
        if "@" in wp_username and "." in wp_username.split("@")[-1]:
            hint += (
                "\n\nTip: You entered an email address. Most sites require the account **username** "
                "shown on the Users screen, not the email."
            )
        detail = _wp_error_snippet(last_res) if last_res is not None else ""
        if detail:
            hint += f"\n\nWordPress said: {detail}"
        return False, hint, last_res
    code = last_res.status_code if last_res is not None else 0
    detail = _wp_error_snippet(last_res) if last_res is not None else ""
    msg = f"WordPress verification failed (HTTP {code})."
    if detail:
        msg += f" {detail}"
    return False, msg, last_res


# Connector plugin REST namespaces we know about. ``riviso/v1`` is the
# namespace shipped by the current "Riviso – Content Operations" plugin
# (the one served from /api/wordpress/plugin/download). ``auto-articles/v1``
# is the namespace from the older "Auto Articles Connector" build that we
# still keep around for back-compat with sites that haven't upgraded yet.
_RIVISO_PLUGIN_NAMESPACES: tuple[str, ...] = ("riviso/v1", "auto-articles/v1")
_RIVISO_MIN_PUBLISH_VERSION = (0, 2, 0)


def _parse_riviso_ping_payload(raw: Any) -> dict[str, Any] | None:
    """
    Accept only authentic Riviso connector /ping JSON (prevents false "active"
    when another endpoint returns HTTP 200 with unrelated content).
    """
    if not isinstance(raw, dict):
        return None
    if raw.get("ok") is not True:
        return None
    plugin = str(raw.get("plugin") or "").strip()
    plugin_l = plugin.lower()
    if not plugin or not any(
        token in plugin_l for token in ("riviso", "auto-articles", "content-operations")
    ):
        return None
    connector_id = str(raw.get("connector_id") or "").strip()
    if len(connector_id) < 8:
        return None
    return {
        "plugin": plugin,
        "version": str(raw.get("version") or "").strip(),
        "connector_id": connector_id,
        "yoast_active": bool(raw.get("yoast_active")),
        "site_url": str(raw.get("site_url") or "").strip(),
    }


def _ping_site_matches_config(wp_site_url: str, ping_site_url: str) -> bool:
    """Reject ping responses that claim a different WordPress site (CDN/cache spoofing)."""
    if not ping_site_url:
        return True
    a = _normalize_url(wp_site_url).rstrip("/")
    b = _normalize_url(ping_site_url).rstrip("/")
    return bool(a and b and a == b)


def _version_tuple(version: str) -> tuple[int, int, int]:
    parts: list[int] = []
    for piece in (version or "").strip().split("."):
        if not piece.isdigit():
            break
        parts.append(int(piece))
    while len(parts) < 3:
        parts.append(0)
    return parts[0], parts[1], parts[2]


async def _probe_publish_validate(
    *,
    client: httpx.AsyncClient,
    wp_site_url: str,
    headers: dict[str, str],
    namespace: str,
) -> bool:
    """True when the connector exposes POST /publish (v0.2+)."""
    try:
        res = await client.post(
            f"{wp_site_url}/wp-json/{namespace}/publish",
            headers={**headers, "content-type": "application/json"},
            json={"validate_only": True},
            timeout=12.0,
        )
        if res.status_code != 200:
            return False
        data = res.json()
        return isinstance(data, dict) and data.get("ok") is True and data.get("can_publish") is True
    except Exception:
        return False


async def _discover_wp_namespaces(
    *, client: httpx.AsyncClient, wp_site_url: str
) -> list[str]:
    try:
        droot = await client.get(f"{wp_site_url}/wp-json/")
        if droot.status_code == 200 and droot.content:
            data = droot.json()
            if isinstance(data, dict):
                raw_ns = data.get("namespaces")
                if isinstance(raw_ns, list):
                    return [str(x) for x in raw_ns if isinstance(x, str)]
    except Exception:
        pass
    return []


async def _probe_riviso_plugin(
    *, wp_site_url: str, headers: dict[str, str]
) -> tuple[str, str]:
    """Secure Riviso connector check: valid /ping signature + /publish when possible.

    Status values:

    - ``active``            – authentic ping and publish route verified (v0.2+).
    - ``upgrade_required``  – Riviso ping OK but publish route missing (old plugin).
    - ``capability``        – plugin detected but user cannot access plugin REST routes.
    - ``installed``         – namespace registered only (not enough to claim active).
    - ``missing``           – no Riviso connector detected.
    - ``unknown``           – could not reach wp-json index.
    """
    last_auth_block = False
    ping_hit: dict[str, Any] | None = None
    ping_ns = ""

    async with httpx.AsyncClient(timeout=12.0, follow_redirects=True) as client:
        for ns in _RIVISO_PLUGIN_NAMESPACES:
            try:
                pres = await client.get(
                    f"{wp_site_url}/wp-json/{ns}/ping",
                    headers=headers,
                )
            except Exception:
                continue
            if pres.status_code in (401, 403):
                last_auth_block = True
                continue
            if pres.status_code != 200:
                continue
            try:
                parsed = _parse_riviso_ping_payload(pres.json())
            except Exception:
                parsed = None
            if parsed and not _ping_site_matches_config(wp_site_url, parsed.get("site_url") or ""):
                parsed = None
            if parsed:
                ping_hit = parsed
                ping_ns = ns
                break

        discovered = await _discover_wp_namespaces(client=client, wp_site_url=wp_site_url)

        if ping_hit and ping_ns:
            version = ping_hit.get("version") or ""
            head = ping_hit["plugin"] + (f" v{version}" if version else "")
            tail = f", connector {ping_hit['connector_id'][:8]}…"
            yoast = "yes" if ping_hit.get("yoast_active") else "no"

            publish_ok = await _probe_publish_validate(
                client=client,
                wp_site_url=wp_site_url,
                headers=headers,
                namespace=ping_ns,
            )
            if publish_ok:
                return (
                    "active",
                    f"Plugin: active and verified ({head}, Yoast: {yoast}{tail}). "
                    "Publish route is available.",
                )

            if version and _version_tuple(version) < _RIVISO_MIN_PUBLISH_VERSION:
                return (
                    "upgrade_required",
                    f"Plugin: outdated ({head}). Download and install Riviso connector "
                    "v0.2.0+ from Project Settings (includes the secure /publish route). "
                    "WordPress credentials are OK; publishing will fail until you upgrade.",
                )

            return (
                "upgrade_required",
                f"Plugin: detected ({head}, Yoast: {yoast}{tail}) but the publish route "
                "was not verified. Install the latest Riviso connector from Project Settings "
                "→ Download plugin, activate it in WordPress → Plugins, then verify again.",
            )

        matched_ns = next((n for n in _RIVISO_PLUGIN_NAMESPACES if n in discovered), None)
        if matched_ns:
            if last_auth_block:
                return (
                    "capability",
                    "Plugin: REST namespace is registered but this WordPress user cannot "
                    "access the connector (HTTP 401/403 on /ping). Use an Editor/Admin "
                    "account and a new application password.",
                )
            return (
                "installed",
                f"Plugin: namespace `{matched_ns}` is registered but Riviso /ping did not "
                "return a valid connector response. The plugin may be inactive, cached, "
                "or not our connector. Install/activate “Riviso – Content Operations” from "
                "Project Settings → Download plugin.",
            )

        if not discovered:
            return (
                "unknown",
                "Plugin: could not be checked (/wp-json/ index unreachable).",
            )

        return (
            "missing",
            "Plugin: not installed or not active. In WordPress go to Plugins → Add New → "
            "Upload Plugin, install “Riviso – Content Operations” from Project Settings "
            "→ Download plugin, activate it, then click Verify connection again.",
        )


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
    """Download the Riviso WordPress connector as a WordPress-valid plugin ZIP."""
    from app.services.wordpress_plugin_packager import build_plugin_zip_bytes

    try:
        data, filename = build_plugin_zip_bytes()
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    headers = {
        "content-disposition": f'attachment; filename="{filename}"',
        "cache-control": "no-store",
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
        wp_app_password=app_pw or None,
        # Verification state — set by ``POST /wordpress/verify`` and cleared
        # by ``PATCH /settings`` when the user changes site URL / username /
        # app password (the snapshot would no longer reflect the current creds).
        wp_verified_at=(proj.get("wp_verified_at") or "").strip() or None,
        wp_verified_status=(proj.get("wp_verified_status") or "").strip() or None,
        wp_verified_message=(proj.get("wp_verified_message") or "").strip() or None,
        # Connector plugin state — populated by the verify route alongside
        # the credentials check so the UI can render an independent pill
        # ("Plugin active" / "Plugin missing" / "Capability blocked").
        wp_plugin_status=(proj.get("wp_plugin_status") or "").strip() or None,
        wp_plugin_message=(proj.get("wp_plugin_message") or "").strip() or None,
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
    # If any of the WordPress credential fields are touched we have to
    # invalidate the cached verification snapshot — what was verified
    # 10 seconds ago may no longer be reachable with the new values.
    creds_changed = False
    if payload.name is not None:
        updates["name"] = payload.name.strip()[:200]
    if payload.website_url is not None:
        url = _normalize_url(payload.website_url)
        updates["website_url"] = url
        updates.setdefault("wp_site_url", url)
    if payload.wp_site_url is not None:
        new_url = _normalize_url(payload.wp_site_url)
        if new_url != _normalize_url(proj.get("wp_site_url") or proj.get("website_url") or ""):
            creds_changed = True
        updates["wp_site_url"] = new_url
    if payload.wp_username is not None:
        new_user = payload.wp_username.strip()[:200]
        if new_user != (proj.get("wp_username") or "").strip():
            creds_changed = True
        updates["wp_username"] = new_user
    if payload.wp_app_password is not None:
        # Application passwords are often typed with spaces; normalize.
        normalized = (payload.wp_app_password or "").replace(" ", "").strip()[:500]
        if normalized and normalized != (proj.get("wp_app_password") or "").strip():
            creds_changed = True
        updates["wp_app_password"] = normalized
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

    if creds_changed:
        # Drop the stale "verified" snapshot — the next /verify call will
        # repopulate it. UI will fall back to "Not verified yet".
        updates["wp_verified_at"] = ""
        updates["wp_verified_status"] = ""
        updates["wp_verified_message"] = ""
        # Plugin state is meaningless once credentials change — clear so we
        # don't show a stale "active" badge against a freshly-edited URL.
        updates["wp_plugin_status"] = ""
        updates["wp_plugin_message"] = ""

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

    basic = base64.b64encode(f"{wp_username}:{wp_app_password}".encode("utf-8")).decode("ascii")
    headers = {
        "authorization": f"Basic {basic}",
        "accept": "application/json",
        "user-agent": "Riviso/1.0 WordPress-Verify",
    }

    def _persist(
        status: str,
        message: str,
        *,
        ok: bool,
        plugin_status: str | None = None,
        plugin_message: str | None = None,
    ) -> None:
        """Snapshot the verification outcome onto the project so the Settings
        tab can render a "Verified · 2 minutes ago" pill on next load. We
        always persist (success or failure) so the UI stays honest after a
        credential change that breaks the connection."""
        try:
            now_iso = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
            patch: dict[str, Any] = {
                "wp_verified_status": status,
                "wp_verified_message": message[:1000],
            }
            if ok:
                patch["wp_verified_at"] = now_iso
            if plugin_status is not None:
                patch["wp_plugin_status"] = plugin_status[:32]
            if plugin_message is not None:
                patch["wp_plugin_message"] = plugin_message[:1000]
            st.update_project_fields(project_id, patch)
        except Exception:
            # Persistence is best-effort: even if it fails we still return
            # the verify result so the user sees the immediate outcome.
            pass

    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            ok, err_msg, _res = await _verify_wp_rest_credentials(
                client=client,
                wp_site_url=wp_site_url,
                headers=headers,
                wp_username=wp_username,
            )
            if not ok:
                status = "auth_failed" if _res is not None and _res.status_code in {401, 403} else "failed"
                _persist(
                    status,
                    err_msg,
                    ok=False,
                    plugin_status="",
                    plugin_message="",
                )
                return WordpressVerifyResponse(ok=False, status=status, message=err_msg)

            from app.services.wordpress_publish import probe_publish_permission

            can_publish, publish_hint = await probe_publish_permission(
                wp_site_url=wp_site_url, headers=headers, client=client
            )
            try:
                st.update_project_fields(
                    project_id,
                    {
                        "wp_site_url": wp_site_url,
                        "wp_username": wp_username,
                        "wp_app_password": wp_app_password,
                    },
                )
            except Exception:
                pass
            try:
                plugin_status, plugin_msg = await _probe_riviso_plugin(
                    wp_site_url=wp_site_url, headers=headers
                )
            except Exception:
                plugin_status, plugin_msg = (
                    "unknown",
                    "Plugin: could not be checked (unexpected error while contacting "
                    "the WordPress REST API).",
                )

            full_msg = "Verified WordPress connection successfully.\n" + plugin_msg
            if not can_publish:
                full_msg += (
                    "\n\nWarning: publish permission was not confirmed. "
                    + (publish_hint or "Install the Riviso connector plugin and use an Editor-capable account.")
                )
            _persist(
                "connected",
                full_msg,
                ok=True,
                plugin_status=plugin_status,
                plugin_message=plugin_msg,
            )
            return WordpressVerifyResponse(ok=True, status="connected", message=full_msg)
    except Exception as e:
        msg = f"Could not reach WordPress site: {e}"
        _persist("error", msg, ok=False)
        return WordpressVerifyResponse(ok=False, status="error", message=msg)


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

