"""Shopify OAuth callback (global) and shared helpers."""
from __future__ import annotations

from datetime import datetime
from urllib.parse import urlparse, urlunparse

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from app.core.config import settings
from app.legacy.storage import get_legacy_storage_module
from app.services import shopify_oauth
from app.services.shopify_sync import sync_shopify_catalog
from app.services.shopify_catalog_persistence import persist_shopify_catalog_sync

router = APIRouter(prefix="/shopify", tags=["shopify"])


def _public_api_url(path: str) -> str:
    base = (str(settings.public_base_url) if settings.public_base_url else "").strip().rstrip("/")
    if not base:
        return (path or "").strip()
    p0 = (path or "").strip()
    b = urlparse(base)
    u = urlparse(p0)
    if u.scheme and u.netloc:
        return urlunparse((b.scheme, b.netloc, u.path, u.params, u.query, u.fragment))
    p = p0 if p0.startswith("/") else f"/{p0}"
    return f"{base}{p}"


def _frontend_base_url(return_origin: str = "") -> str:
    from app.services.shopify_oauth import validate_return_origin

    ret = validate_return_origin(return_origin)
    if ret:
        return ret
    return (str(settings.frontend_base_url) if settings.frontend_base_url else "").strip().rstrip("/")


def _frontend_base(*, ok: bool, message: str = "", return_origin: str = "") -> str:
    base = _frontend_base_url(return_origin)
    path = f"/dashboard#shopify={'connected' if ok else 'error'}"
    if message:
        from urllib.parse import quote

        path += f"&msg={quote(message[:200])}"
    return f"{base}{path}" if base else path


def _frontend_redirect(*, project_id: str, ok: bool, message: str = "", return_origin: str = "") -> str:
    base = _frontend_base_url(return_origin)
    frag = f"shopify={'connected' if ok else 'error'}"
    if message:
        from urllib.parse import quote

        frag += f"&msg={quote(message[:200])}"
    target = f"/projects/{project_id}?tab=project_settings#{frag}"
    if not base:
        return target
    return f"{base}{target}"


@router.get("/oauth/callback", name="shopify_oauth_callback")
async def oauth_callback(request: Request) -> RedirectResponse:
    params = {k: (request.query_params.get(k) or "") for k in request.query_params.keys()}
    code = (params.get("code") or "").strip()
    state = (params.get("state") or "").strip()
    shop = shopify_oauth.normalize_shop_domain(params.get("shop") or "")

    if not code or not state or not shop:
        return RedirectResponse(_frontend_base(ok=False, message="Missing OAuth parameters"), status_code=302)

    try:
        parsed = shopify_oauth.parse_state_token(state)
    except Exception:
        return RedirectResponse(_frontend_base(ok=False, message="Invalid state"), status_code=302)

    pid = (parsed.get("pid") or "").strip()
    uid = (parsed.get("uid") or "").strip()
    ret_origin = (parsed.get("return_origin") or "").strip()

    st = get_legacy_storage_module()
    proj = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    proj_secret = (proj.get("shopify_client_secret") or "").strip() if isinstance(proj, dict) else ""
    proj_cid = (proj.get("shopify_client_id") or "").strip() if isinstance(proj, dict) else ""
    use_project_oauth = bool(proj_secret and proj_cid)

    if not shopify_oauth.verify_oauth_hmac(
        dict(request.query_params),
        client_secret=proj_secret if use_project_oauth else None,
    ):
        return RedirectResponse(
            _frontend_redirect(
                project_id=pid,
                ok=False,
                message=shopify_oauth.hmac_failure_hint(),
                return_origin=ret_origin,
            ),
            status_code=302,
        )
    state_shop = (parsed.get("shop") or "").strip()
    if state_shop and state_shop != shop:
        return RedirectResponse(
            _frontend_redirect(project_id=pid, ok=False, message="Shop mismatch", return_origin=ret_origin),
            status_code=302,
        )

    if not pid:
        return RedirectResponse(
            _frontend_redirect(project_id="", ok=False, message="Missing project", return_origin=ret_origin),
            status_code=302,
        )

    try:
        if use_project_oauth:
            from app.services.shopify_project_oauth import exchange_project_code_for_token

            tok = await exchange_project_code_for_token(
                shop=shop,
                code=code,
                client_id=proj_cid,
                client_secret=proj_secret,
            )
        else:
            tok = await shopify_oauth.exchange_code_for_token(shop=shop, code=code)
    except Exception as exc:
        return RedirectResponse(
            _frontend_redirect(
                project_id=pid,
                ok=False,
                message=f"Token exchange failed: {exc}",
                return_origin=ret_origin,
            ),
            status_code=302,
        )

    access_token = (tok.get("access_token") or "").strip()
    scope = (tok.get("scope") or shopify_oauth.SHOPIFY_SCOPES).strip()
    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    if not hasattr(st, "update_project_fields"):
        return RedirectResponse(
            _frontend_redirect(project_id=pid, ok=False, message="Storage error", return_origin=ret_origin),
            status_code=302,
        )

    if not isinstance(proj, dict):
        return RedirectResponse(
            _frontend_redirect(project_id=pid, ok=False, message="Project not found", return_origin=ret_origin),
            status_code=302,
        )
    owner = (proj.get("owner_user_id") or "").strip()
    if owner and owner != uid:
        return RedirectResponse(
            _frontend_redirect(project_id=pid, ok=False, message="Project owner mismatch", return_origin=ret_origin),
            status_code=302,
        )

    st.update_project_fields(
        pid,
        {
            "platform": "shopify",
            "shopify_shop": shop,
            "shopify_access_token": access_token,
            "shopify_scope": scope,
            "shopify_connected_at": now_str,
            "shopify_verified_at": now_str,
            "shopify_verified_status": "connected",
            "shopify_verified_message": "Shopify permissions updated.",
            "website_url": f"https://{shop}",
            "shopify_sync_status": "syncing",
            "shopify_sync_message": "Syncing catalog…",
        },
    )

    try:
        catalog = await sync_shopify_catalog(shop=shop, access_token=access_token, granted_scope=scope)
        persist_shopify_catalog_sync(
            st,
            project_id=pid,
            catalog=catalog,
            extra_project_fields={
                "shopify_sync_status": "ok",
                "shopify_sync_message": (
                    f"Synced {catalog.get('counts', {}).get('products', 0)} products, "
                    f"{catalog.get('counts', {}).get('collections', 0)} collections, "
                    f"{catalog.get('counts', {}).get('blogs', 0)} blogs, "
                    f"{catalog.get('counts', {}).get('pages', 0)} pages."
                )[:500],
            },
        )
    except Exception as exc:
        st.update_project_fields(
            pid,
            {
                "shopify_sync_status": "error",
                "shopify_sync_message": f"Connected, but sync failed: {exc}"[:500],
            },
        )

    return RedirectResponse(_frontend_redirect(project_id=pid, ok=True, return_origin=ret_origin), status_code=302)
