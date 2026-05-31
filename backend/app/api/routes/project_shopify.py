"""Per-project Shopify connection and catalog routes."""
from __future__ import annotations

from datetime import datetime
from urllib.parse import urlparse, urlunparse

from fastapi import APIRouter, Depends, HTTPException, Request

from app.core.config import settings
from app.core.project_lookup import require_project_access
from app.core.deps import get_current_user
from app.legacy.storage import get_legacy_storage_module
from app.schemas.shopify import (
    ShopifyCatalog,
    ShopifyConnectRequest,
    ShopifyConnectResponse,
    ShopifyConnectUrlRequest,
    ShopifyManualConnectRequest,
    ShopifyManualConnectResponse,
    ShopifyReauthorizeUrlRequest,
    ShopifyReauthorizeUrlResponse,
    ShopifyResolveShopRequest,
    ShopifyResolveShopResponse,
    ShopifyStatus,
    ShopifySyncWarning,
    ShopifyVerifyRequest,
    ShopifyVerifyResponse,
)
from app.services.shopify_api_errors import (
    RECOMMENDED_SCOPES,
    REQUIRED_PUBLISH_SCOPES,
    REQUIRED_SYNC_SCOPES,
    build_scope_setup_hint,
    parse_granted_scopes,
    resource_scope_satisfied,
    scopes_missing_for_publish,
    scopes_missing_for_sync,
)
from app.services import shopify_oauth
from app.services.shopify_client import ShopifyClient
from app.services.shopify_credentials import (
    AUTH_FAILED_MESSAGE,
    ShopifyCredentialsError,
    credential_update_fields,
    exchange_client_credentials,
    refresh_project_token_if_needed,
)
from app.services.shopify_project_oauth import (
    REINSTALL_MESSAGE,
    build_project_authorize_url,
    catalog_scopes_ready,
    missing_scopes_message,
)
from app.services.shopify_sync import sync_shopify_catalog
from app.services.shopify_catalog_persistence import persist_shopify_catalog_sync

router = APIRouter(prefix="/projects/{project_id}/shopify", tags=["shopify-project"])
connect_router = APIRouter(prefix="/projects/{project_id}", tags=["shopify-project"])


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


def _require_project(*, st, user: dict, project_id: str) -> dict:
    return require_project_access(st=st, user=user, project_id=project_id, full=False)


def _platform(proj: dict) -> str:
    return ((proj.get("platform") or "wordpress").strip().lower() or "wordpress")


def _warnings_from_catalog(catalog: dict) -> list[ShopifySyncWarning]:
    raw = catalog.get("warnings") if isinstance(catalog.get("warnings"), list) else []
    out: list[ShopifySyncWarning] = []
    for w in raw:
        if isinstance(w, dict):
            out.append(
                ShopifySyncWarning(
                    resource=(w.get("resource") or "").strip(),
                    code=(w.get("code") or "").strip(),
                    required_scope=(w.get("required_scope") or "").strip(),
                    message=(w.get("message") or "").strip(),
                )
            )
    return out


def _scope_connect_note(scope_str: str) -> str:
    missing = scopes_missing_for_sync(parse_granted_scopes(scope_str))
    if "read_products" not in missing:
        return ""
    return (
        " Your token is missing read_products — release the app version, then use Update app permissions "
        "in Riviso (OAuth reinstall), not only Refresh connection."
    )


def _build_project_reauthorize_url(
    *,
    request: Request,
    user: dict,
    proj: dict,
    shop: str,
    return_origin: str = "",
) -> str:
    uid = (user.get("id") or "").strip()
    pid = (proj.get("id") or "").strip()
    client_id = (proj.get("shopify_client_id") or "").strip()
    if not client_id:
        raise ValueError("Save Client ID before updating permissions.")
    ret = return_origin.strip()
    if not ret and request.headers.get("origin"):
        ret = request.headers.get("origin") or ""
    state = shopify_oauth.make_state_token(
        user_id=uid,
        project_id=pid,
        shop=shop,
        return_origin=ret,
    )
    redirect_uri = _public_api_url(str(request.url_for("shopify_oauth_callback")))
    return build_project_authorize_url(
        shop=shop,
        client_id=client_id,
        redirect_uri=redirect_uri,
        state=state,
    )


async def _shopify_client_for_project(
    *,
    st,
    proj: dict,
    force_token_refresh: bool = False,
) -> tuple[dict, ShopifyClient]:
    """Load project with refreshed client-credentials token (always on sync)."""
    pid = (proj.get("id") or "").strip()
    fresh = await refresh_project_token_if_needed(
        st=st,
        project_id=pid,
        proj=proj,
        force=force_token_refresh,
    )
    shop = (fresh.get("shopify_shop") or "").strip()
    token = (fresh.get("shopify_access_token") or "").strip()
    if not shop or not token:
        raise ValueError("Shopify is not connected")
    return fresh, ShopifyClient(shop=shop, access_token=token)


@connect_router.post("/connect-shopify", response_model=ShopifyConnectResponse)
async def connect_shopify(
    project_id: str,
    payload: ShopifyConnectRequest,
    request: Request,
    user: dict = Depends(get_current_user),
) -> ShopifyConnectResponse:
    """
    Exchange Developer Dashboard Client ID + Secret for an Admin API access token
    and attach the store to this project.
    """
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    pid = (proj.get("id") or "").strip()
    if not hasattr(st, "update_project_fields"):
        raise HTTPException(status_code=500, detail="Storage missing update_project_fields")

    shop, public_url, err = await shopify_oauth.resolve_shop_domain(payload.shop)
    if err or not shop:
        return ShopifyConnectResponse(ok=False, status="failed", message=err or "Invalid shop domain.", shop=None)

    client_id = (payload.client_id or "").strip()
    client_secret = (payload.client_secret or "").strip()

    try:
        exchanged = await exchange_client_credentials(
            shop=shop,
            client_id=client_id,
            client_secret=client_secret,
        )
    except ShopifyCredentialsError as exc:
        status = "auth_failed" if exc.status_code in (400, 401, 403) else "error"
        return ShopifyConnectResponse(ok=False, status=status, message=str(exc), shop=shop)

    token = (exchanged.get("access_token") or "").strip()
    try:
        client = ShopifyClient(shop=shop, access_token=token)
        shop_json = await client.get_json("/shop.json")
        shop_name = ""
        if isinstance(shop_json.get("shop"), dict):
            shop_name = (shop_json["shop"].get("name") or "").strip()
    except Exception as exc:
        return ShopifyConnectResponse(
            ok=False,
            status="error",
            message=f"Token received but Shopify API check failed: {exc}",
            shop=shop,
        )

    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    st.update_project_fields(
        pid,
        credential_update_fields(
            shop=shop,
            public_url=public_url or f"https://{shop}",
            client_id=client_id,
            client_secret=client_secret,
            exchanged=exchanged,
            shop_name=shop_name,
            now_str=now_str,
        ),
    )

    scope_str = (exchanged.get("scope") or "").strip()
    scopes_ok, missing_scopes, live_scopes = await catalog_scopes_ready(shop=shop, access_token=token)
    if not scopes_ok:
        try:
            reauth_url = _build_project_reauthorize_url(
                request=request,
                user=user,
                proj={**proj, "shopify_client_id": client_id, "id": pid},
                shop=shop,
                return_origin=request.headers.get("origin") or "",
            )
        except Exception as exc:
            reauth_url = ""
        msg = missing_scopes_message(missing=missing_scopes, granted=live_scopes)
        return ShopifyConnectResponse(
            ok=False,
            status="needs_reauthorize",
            message=msg,
            shop=shop,
            needs_reauthorize=True,
            reauthorize_url=reauth_url or None,
            granted_scopes=sorted(live_scopes),
            missing_scopes=missing_scopes,
        )

    try:
        catalog = await sync_shopify_catalog(
            shop=shop,
            access_token=token,
            granted_scope=scope_str,
        )
        persist_shopify_catalog_sync(st, project_id=pid, catalog=catalog)
    except Exception:
        pass

    msg = f"Connected to {shop_name or shop}."
    return ShopifyConnectResponse(
        ok=True,
        status="connected",
        message=msg,
        shop=shop,
        granted_scopes=sorted(live_scopes),
    )


@router.post("/reauthorize-url", response_model=ShopifyReauthorizeUrlResponse)
async def reauthorize_url(
    project_id: str,
    request: Request,
    payload: ShopifyReauthorizeUrlRequest | None = None,
    user: dict = Depends(get_current_user),
) -> ShopifyReauthorizeUrlResponse:
    """
    Build Shopify OAuth authorize URL for this project's Developer Dashboard app.
    Required after releasing new scopes — client-credentials refresh alone cannot add them.
    """
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    raw = (
        (payload.shop if payload and payload.shop else None)
        or proj.get("shopify_shop")
        or proj.get("website_url")
        or ""
    )
    shop, public_url, err = await shopify_oauth.resolve_shop_domain(raw)
    if err or not shop:
        return ShopifyReauthorizeUrlResponse(ok=False, message=err or "Invalid shop domain.")

    client_id = (proj.get("shopify_client_id") or "").strip()
    client_secret = (proj.get("shopify_client_secret") or "").strip()
    if not client_id or not client_secret:
        return ShopifyReauthorizeUrlResponse(
            ok=False,
            message="Save Client ID and Client Secret in Project Settings first.",
            shop=shop,
        )

    ret = (payload.return_origin if payload and payload.return_origin else "") or (
        request.headers.get("origin") or ""
    )
    try:
        url = _build_project_reauthorize_url(
            request=request,
            user=user,
            proj=proj,
            shop=shop,
            return_origin=ret,
        )
    except Exception as exc:
        return ShopifyReauthorizeUrlResponse(ok=False, message=str(exc), shop=shop)

    if hasattr(st, "update_project_fields"):
        st.update_project_fields(
            (proj.get("id") or "").strip(),
            {"shopify_shop": shop, "website_url": public_url or f"https://{shop}"},
        )

    return ShopifyReauthorizeUrlResponse(
        ok=True,
        url=url,
        shop=shop,
        message=REINSTALL_MESSAGE,
    )


@router.get("/status", response_model=ShopifyStatus)
async def status(project_id: str, user: dict = Depends(get_current_user)) -> ShopifyStatus:
    st = get_legacy_storage_module()
    require_project_access(st=st, user=user, project_id=project_id, full=False)
    proj = (
        st.get_project_shopify_status_doc(project_id)
        if hasattr(st, "get_project_shopify_status_doc")
        else _require_project(st=st, user=user, project_id=project_id)
    )
    if not isinstance(proj, dict):
        raise HTTPException(status_code=404, detail="Project not found")
    token = (proj.get("shopify_access_token") or "").strip()
    shop = (proj.get("shopify_shop") or "").strip()
    catalog = proj.get("shopify_catalog") if isinstance(proj.get("shopify_catalog"), dict) else {}
    counts = catalog.get("counts") if isinstance(catalog.get("counts"), dict) else {}

    verified = (proj.get("shopify_verified_status") or "").strip().lower() == "connected" and bool(
        (proj.get("shopify_verified_at") or "").strip()
    )
    connected = bool(token and shop and verified)
    setup_hint: str | None = None
    sync_status = (proj.get("shopify_sync_status") or "").strip() or None
    sync_message = (proj.get("shopify_sync_message") or "").strip() or None
    if token and shop and not verified:
        connected = False
        sync_status = sync_status or "error"
        sync_message = sync_message or "Shopify connection not verified. Re-verify in Project Settings."
        setup_hint = (
            "Shopify token is invalid or revoked. Create a new custom app token in Shopify Admin "
            "and paste it into Riviso below."
        )

    cat_warnings = _warnings_from_catalog(catalog)
    granted = catalog.get("granted_scopes") if isinstance(catalog.get("granted_scopes"), list) else []
    granted_set = {str(s).strip() for s in granted if str(s).strip()}
    missing = scopes_missing_for_sync(granted_set)
    missing_publish = scopes_missing_for_publish(granted_set) if granted_set else list(REQUIRED_PUBLISH_SCOPES)
    has_products = resource_scope_satisfied(granted_set, "products") if granted_set else False
    needs_reauth = bool((missing or missing_publish) and bool((proj.get("shopify_client_id") or "").strip()))
    if needs_reauth and not setup_hint:
        setup_hint = build_scope_setup_hint(
            missing_sync=missing,
            missing_publish=missing_publish,
            granted=granted_set,
        ) or REINSTALL_MESSAGE
    can_publish = connected and not missing_publish
    return ShopifyStatus(
        configured=True,
        connect_ready=True,
        connected=connected,
        setup_hint=setup_hint,
        shop=shop or None,
        connected_at=(proj.get("shopify_connected_at") or "").strip() or None,
        sync_at=(proj.get("shopify_sync_at") or "").strip() or None,
        sync_status=sync_status,
        sync_message=sync_message,
        counts={k: int(v) for k, v in counts.items() if isinstance(v, (int, float))},
        warnings=cat_warnings,
        granted_scopes=sorted(granted_set),
        required_scopes=list(REQUIRED_SYNC_SCOPES),
        recommended_scopes=list(RECOMMENDED_SCOPES),
        needs_reauthorize=needs_reauth,
        can_publish=can_publish,
        missing_publish_scopes=missing_publish,
        has_product_catalog_scope=has_products,
    )


@router.post("/verify", response_model=ShopifyVerifyResponse)
async def verify_connection(
    project_id: str,
    request: Request,
    payload: ShopifyVerifyRequest | None = None,
    user: dict = Depends(get_current_user),
) -> ShopifyVerifyResponse:
    """Verify Shopify credentials (same flow as WordPress verify + settings save)."""
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    pid = (proj.get("id") or "").strip()
    raw = (
        (payload.shop if payload and payload.shop else None)
        or proj.get("shopify_shop")
        or proj.get("website_url")
        or ""
    )
    shop, public_url, err = await shopify_oauth.resolve_shop_domain(raw)
    if err or not shop:
        return ShopifyVerifyResponse(
            ok=False,
            status="failed",
            message=err or "Enter your Shopify shop URL.",
            needs_oauth=False,
        )

    client_id = (
        (payload.client_id if payload and payload.client_id else None)
        or proj.get("shopify_client_id")
        or ""
    ).strip()
    client_secret = (
        (payload.client_secret if payload and payload.client_secret else None)
        or proj.get("shopify_client_secret")
        or ""
    ).strip()
    legacy_token = (
        (payload.access_token if payload and payload.access_token is not None else None)
        or proj.get("shopify_access_token")
        or ""
    ).strip()

    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    token = legacy_token
    granted_scope = (proj.get("shopify_scope") or "").strip()

    if client_id and client_secret:
        try:
            exchanged = await exchange_client_credentials(
                shop=shop,
                client_id=client_id,
                client_secret=client_secret,
            )
            token = (exchanged.get("access_token") or "").strip()
            granted_scope = (exchanged.get("scope") or "client_credentials").strip()
            cred_updates: dict = {
                "shopify_shop": shop,
                "website_url": public_url or f"https://{shop}",
                "shopify_access_token": token,
                "shopify_scope": granted_scope[:2000],
                "shopify_token_expires_at": (exchanged.get("expires_at") or "").strip()[:32],
            }
            if client_id:
                cred_updates["shopify_client_id"] = client_id
            if client_secret:
                cred_updates["shopify_client_secret"] = client_secret
            st.update_project_fields(pid, cred_updates)
        except ShopifyCredentialsError as exc:
            return ShopifyVerifyResponse(
                ok=False,
                status="auth_failed",
                message=str(exc),
                needs_oauth=False,
                shop=shop,
            )
    elif not token:
        return ShopifyVerifyResponse(
            ok=False,
            status="not_connected",
            message="Enter your Client ID and Client Secret from the Shopify Developer Dashboard, then connect.",
            needs_oauth=False,
            shop=shop,
        )

    def _persist(*, ok: bool, status: str, message: str, catalog: dict | None = None) -> None:
        if not hasattr(st, "update_project_fields"):
            return
        scope_persist = (
            granted_scope[:2000]
            if client_id and client_secret and granted_scope
            else ("manual" if legacy_token and not (client_id and client_secret) else granted_scope[:2000])
        )
        fields: dict = {
            "platform": "shopify",
            "shopify_shop": shop,
            "website_url": public_url or f"https://{shop}",
            "shopify_access_token": token,
            "shopify_scope": scope_persist or "manual",
            "shopify_verified_at": now_str if ok else "",
            "shopify_verified_status": status,
            "shopify_verified_message": message[:1000],
        }
        if ok:
            fields["shopify_connected_at"] = now_str
            if catalog is not None:
                fields["shopify_sync_status"] = (catalog.get("sync_status") or "ok")[:32]
                fields["shopify_sync_message"] = (catalog.get("sync_message") or message)[:500]
                fields["shopify_sync_at"] = catalog.get("synced_at") or now_str
            else:
                fields["shopify_sync_status"] = "ok"
                fields["shopify_sync_message"] = message[:500]
        else:
            fields["shopify_sync_status"] = "error"
            fields["shopify_sync_message"] = message[:500]
        st.update_project_fields(pid, fields)

    try:
        client = ShopifyClient(shop=shop, access_token=token)
        shop_json = await client.get_json("/shop.json")
        shop_name = ""
        if isinstance(shop_json.get("shop"), dict):
            shop_name = (shop_json["shop"].get("name") or "").strip()

        scopes_ok, missing_scopes, live_scopes = await catalog_scopes_ready(shop=shop, access_token=token)
        if not scopes_ok and client_id and client_secret:
            try:
                reauth_url = _build_project_reauthorize_url(
                    request=request,
                    user=user,
                    proj={**proj, "shopify_client_id": client_id, "id": pid},
                    shop=shop,
                    return_origin=request.headers.get("origin") or "",
                )
            except Exception:
                reauth_url = ""
            msg = missing_scopes_message(missing=missing_scopes, granted=live_scopes)
            _persist(ok=False, status="needs_reauthorize", message=msg)
            return ShopifyVerifyResponse(
                ok=False,
                status="needs_reauthorize",
                message=msg,
                needs_reauthorize=True,
                reauthorize_url=reauth_url or None,
                granted_scopes=sorted(live_scopes),
                missing_scopes=missing_scopes,
                shop=shop,
            )

        catalog = await sync_shopify_catalog(
            shop=shop,
            access_token=token,
            granted_scope=granted_scope,
        )
        msg = (catalog.get("sync_message") or f"Connected to {shop_name or shop}.")[:500]
        _persist(ok=True, status="connected", message=msg, catalog=catalog)
        persist_shopify_catalog_sync(st, project_id=pid, catalog=catalog)
        return ShopifyVerifyResponse(ok=True, status="connected", message=msg, shop=shop, needs_oauth=False)
    except Exception as exc:
        err_msg = f"Shopify credentials failed: {exc}"
        status_key = "auth_failed" if "401" in str(exc) or "403" in str(exc) else "error"
        _persist(ok=False, status=status_key, message=err_msg)
        return ShopifyVerifyResponse(
            ok=False,
            status=status_key,
            message=AUTH_FAILED_MESSAGE if status_key == "auth_failed" else err_msg,
            needs_oauth=False,
            shop=shop,
        )


@router.post("/resolve-shop", response_model=ShopifyResolveShopResponse)
async def resolve_shop(
    project_id: str,
    payload: ShopifyResolveShopRequest,
    user: dict = Depends(get_current_user),
) -> ShopifyResolveShopResponse:
    _require_project(st=get_legacy_storage_module(), user=user, project_id=project_id)
    myshopify, public_url, err = await shopify_oauth.resolve_shop_domain(payload.shop)
    if err or not myshopify:
        return ShopifyResolveShopResponse(ok=False, public_url=public_url or None, message=err)
    return ShopifyResolveShopResponse(
        ok=True,
        myshopify_domain=myshopify,
        public_url=public_url,
        message=f"Store found: {myshopify}",
    )


@router.post("/connect-url")
async def connect_url(
    project_id: str,
    request: Request,
    payload: ShopifyConnectUrlRequest | None = None,
    user: dict = Depends(get_current_user),
) -> dict:
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    misconfig = shopify_oauth.oauth_misconfiguration_reason()
    if misconfig:
        raise HTTPException(status_code=503, detail=misconfig)
    if not shopify_oauth.oauth_configured():
        raise HTTPException(
            status_code=503,
            detail=(
                "Shopify login is not available on this Riviso server yet. "
                "Store owners do not enter API keys—ask your Riviso administrator to enable the Shopify app once."
            ),
        )

    raw = (payload.shop if payload and payload.shop else None) or proj.get("shopify_shop") or proj.get("website_url") or ""
    shop, public_url, err = await shopify_oauth.resolve_shop_domain(raw)
    if err or not shop:
        raise HTTPException(status_code=400, detail=err or "Enter your store website or Shopify address.")

    uid = (user.get("id") or "").strip()
    pid = (proj.get("id") or "").strip()
    return_origin = ""
    if payload and payload.return_origin:
        return_origin = payload.return_origin
    elif request.headers.get("origin"):
        return_origin = request.headers.get("origin") or ""
    state = shopify_oauth.make_state_token(
        user_id=uid,
        project_id=pid,
        shop=shop,
        return_origin=return_origin,
    )
    redirect_uri = _public_api_url(str(request.url_for("shopify_oauth_callback")))
    url = shopify_oauth.build_authorize_url(shop=shop, redirect_uri=redirect_uri, state=state)

    if hasattr(st, "update_project_fields"):
        st.update_project_fields(
            pid,
            {
                "platform": "shopify",
                "shopify_shop": shop,
                "website_url": public_url or f"https://{shop}",
            },
        )

    return {"url": url, "shop": shop, "public_url": public_url or f"https://{shop}"}


@router.post("/manual-connect", response_model=ShopifyManualConnectResponse)
async def manual_connect(
    project_id: str,
    payload: ShopifyManualConnectRequest,
    user: dict = Depends(get_current_user),
) -> ShopifyManualConnectResponse:
    """
    Connect a project to Shopify using a custom app Admin API access token.
    This is useful when the Partners OAuth app is not public-distributed.
    """
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    pid = (proj.get("id") or "").strip()
    if not hasattr(st, "update_project_fields"):
        raise HTTPException(status_code=500, detail="Storage missing update_project_fields")

    shop, public_url, err = await shopify_oauth.resolve_shop_domain(payload.shop)
    if err or not shop:
        return ShopifyManualConnectResponse(ok=False, status="failed", message=err or "Invalid shop domain.", shop=None)

    token = (payload.access_token or "").strip()
    try:
        client = ShopifyClient(shop=shop, access_token=token)
        shop_json = await client.get_json("/shop.json")
        shop_name = ""
        if isinstance(shop_json.get("shop"), dict):
            shop_name = (shop_json["shop"].get("name") or "").strip()
    except Exception as exc:
        return ShopifyManualConnectResponse(
            ok=False,
            status="error",
            message=f"Token verification failed: {exc}",
            shop=shop,
        )

    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    msg = f"Connected to {shop_name or shop}."
    st.update_project_fields(
        pid,
        {
            "platform": "shopify",
            "shopify_shop": shop,
            "website_url": public_url or f"https://{shop}",
            "shopify_access_token": token,
            "shopify_scope": "manual",
            "shopify_connected_at": now_str,
            "shopify_verified_at": now_str,
            "shopify_verified_status": "connected",
            "shopify_verified_message": msg[:1000],
            "shopify_sync_status": "",
            "shopify_sync_message": msg[:500],
        },
    )
    return ShopifyManualConnectResponse(
        ok=True,
        status="connected",
        message=f"Connected to {shop_name or shop}.",
        shop=shop,
    )


@router.post("/disconnect")
async def disconnect(project_id: str, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    if not hasattr(st, "update_project_fields"):
        raise HTTPException(status_code=500, detail="Storage missing update_project_fields")
    st.update_project_fields(
        (proj.get("id") or "").strip(),
        {
            "shopify_access_token": "",
            "shopify_scope": "",
            "shopify_connected_at": "",
            "shopify_sync_at": "",
            "shopify_sync_status": "",
            "shopify_sync_message": "",
            "shopify_catalog": {},
            "shopify_verified_at": "",
            "shopify_verified_status": "",
            "shopify_verified_message": "",
            "shopify_client_id": "",
            "shopify_client_secret": "",
            "shopify_token_expires_at": "",
        },
    )
    if hasattr(st, "delete_shopify_products_for_project"):
        st.delete_shopify_products_for_project((proj.get("id") or "").strip())
    return {"ok": True}


@router.post("/sync")
async def sync_catalog(project_id: str, user: dict = Depends(get_current_user)) -> ShopifyStatus:
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)
    try:
        proj, client = await _shopify_client_for_project(st=st, proj=proj, force_token_refresh=True)
    except ValueError:
        raise HTTPException(status_code=400, detail="Shopify is not connected for this project") from None
    shop = client.shop
    token = client.access_token

    pid = (proj.get("id") or "").strip()
    st.update_project_fields(pid, {"shopify_sync_status": "syncing", "shopify_sync_message": "Syncing…"})
    scope_str = (proj.get("shopify_scope") or "").strip()
    try:
        live_scopes = await client.fetch_access_scopes()
        if live_scopes:
            scope_str = " ".join(live_scopes)
            st.update_project_fields(pid, {"shopify_scope": scope_str[:2000]})
    except Exception:
        pass
    try:
        catalog = await sync_shopify_catalog(
            shop=shop,
            access_token=token,
            granted_scope=scope_str,
        )
        persist_shopify_catalog_sync(st, project_id=pid, catalog=catalog)
    except Exception as exc:
        st.update_project_fields(
            pid,
            {"shopify_sync_status": "error", "shopify_sync_message": str(exc)[:500]},
        )
        raise HTTPException(
            status_code=502,
            detail={
                "code": "shopify_sync_failed",
                "message": f"Shopify sync failed: {exc}",
            },
        ) from exc

    return await status(project_id=project_id, user=user)


@router.get("/catalog", response_model=ShopifyCatalog)
async def get_catalog(project_id: str, user: dict = Depends(get_current_user)) -> ShopifyCatalog:
    st = get_legacy_storage_module()
    _require_project(st=st, user=user, project_id=project_id)
    raw_doc = st.get_project_shopify_catalog_doc(project_id) if hasattr(st, "get_project_shopify_catalog_doc") else None
    if not isinstance(raw_doc, dict):
        raw_doc = _require_project(st=st, user=user, project_id=project_id)
    raw = raw_doc.get("shopify_catalog") if isinstance(raw_doc.get("shopify_catalog"), dict) else {}
    products: list[dict] = []
    if hasattr(st, "list_shopify_products"):
        products = st.list_shopify_products(project_id)
    if not products and isinstance(raw.get("products"), list):
        products = [p for p in raw.get("products") if isinstance(p, dict)]
    from app.services.shopify_api_errors import (
        PRODUCT_MAPPING_SCOPE_REFERENCE,
        RECOMMENDED_SCOPES,
        REQUIRED_SYNC_SCOPES,
    )

    granted = raw.get("granted_scopes") if isinstance(raw.get("granted_scopes"), list) else []
    return ShopifyCatalog(
        synced_at=(raw.get("synced_at") or raw_doc.get("shopify_sync_at") or "").strip() or None,
        sync_status=(raw.get("sync_status") or raw_doc.get("shopify_sync_status") or "").strip() or None,
        sync_message=(raw.get("sync_message") or raw_doc.get("shopify_sync_message") or "").strip() or None,
        counts=raw.get("counts") if isinstance(raw.get("counts"), dict) else {},
        shop=raw.get("shop") if isinstance(raw.get("shop"), dict) else {},
        products=products,
        collections=raw.get("collections") if isinstance(raw.get("collections"), list) else [],
        blogs=raw.get("blogs") if isinstance(raw.get("blogs"), list) else [],
        pages=raw.get("pages") if isinstance(raw.get("pages"), list) else [],
        warnings=_warnings_from_catalog(raw),
        granted_scopes=[str(s) for s in granted if str(s).strip()],
        required_scopes=list(REQUIRED_SYNC_SCOPES),
        recommended_scopes=list(RECOMMENDED_SCOPES),
        product_mapping_scopes=[dict(row) for row in PRODUCT_MAPPING_SCOPE_REFERENCE],
    )
