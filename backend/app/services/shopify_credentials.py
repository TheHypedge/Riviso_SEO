"""Shopify Developer Dashboard client-credentials token exchange."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

import httpx

from app.services.shopify_oauth import normalize_shop_domain

AUTH_FAILED_MESSAGE = (
    "Authentication failed. Please check that your Client ID and Secret match your Shopify Developer App settings."
)

_TOKEN_REFRESH_BUFFER_SECONDS = 300


class ShopifyCredentialsError(Exception):
    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


async def exchange_client_credentials(
    *,
    shop: str,
    client_id: str,
    client_secret: str,
) -> dict[str, Any]:
    """
    Exchange app Client ID + Secret for an Admin API access token (client_credentials grant).
    See https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
    """
    shop_norm = normalize_shop_domain(shop)
    cid = (client_id or "").strip()
    secret = (client_secret or "").strip()
    if not shop_norm:
        raise ShopifyCredentialsError("Invalid Shopify store URL.")
    if not cid or not secret:
        raise ShopifyCredentialsError("Client ID and Client Secret are required.")

    url = f"https://{shop_norm}/admin/oauth/access_token"
    body = {
        "grant_type": "client_credentials",
        "client_id": cid,
        "client_secret": secret,
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.post(
            url,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data=body,
        )

    if res.status_code in (400, 401, 403):
        raise ShopifyCredentialsError(AUTH_FAILED_MESSAGE, status_code=res.status_code)

    try:
        data = res.json()
    except Exception as exc:
        raise ShopifyCredentialsError(
            f"Invalid response from Shopify token endpoint: {exc}",
            status_code=res.status_code,
        ) from exc

    if not res.is_success:
        detail = ""
        if isinstance(data, dict):
            detail = (data.get("error_description") or data.get("error") or "").strip()
        msg = AUTH_FAILED_MESSAGE if res.status_code in (400, 401, 403) else (
            detail or f"Shopify token request failed ({res.status_code})."
        )
        raise ShopifyCredentialsError(msg, status_code=res.status_code)

    token = (data.get("access_token") or "").strip() if isinstance(data, dict) else ""
    if not token:
        raise ShopifyCredentialsError(AUTH_FAILED_MESSAGE, status_code=res.status_code)

    expires_in = 0
    if isinstance(data, dict):
        try:
            expires_in = int(data.get("expires_in") or 0)
        except (TypeError, ValueError):
            expires_in = 0

    scope = (data.get("scope") or "").strip() if isinstance(data, dict) else ""

    expires_at = ""
    if expires_in > 0:
        expires_at = (datetime.utcnow() + timedelta(seconds=expires_in)).strftime("%Y-%m-%d %H:%M:%S")

    return {
        "access_token": token,
        "scope": scope,
        "expires_in": expires_in,
        "expires_at": expires_at,
        "shop": shop_norm,
    }


def token_expired(proj: dict) -> bool:
    """True when stored client-credentials token should be refreshed."""
    expires_at = (proj.get("shopify_token_expires_at") or "").strip()
    if not expires_at:
        return False
    try:
        exp = datetime.strptime(expires_at, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return True
    return datetime.utcnow() >= exp - timedelta(seconds=_TOKEN_REFRESH_BUFFER_SECONDS)


async def refresh_project_token_if_needed(
    *,
    st: Any,
    project_id: str,
    proj: dict,
    force: bool = False,
) -> dict:
    """Refresh client-credentials token when expired or ``force``; returns updated project dict."""
    pid = (project_id or "").strip()
    if not force and not token_expired(proj):
        return proj
    shop = (proj.get("shopify_shop") or "").strip()
    client_id = (proj.get("shopify_client_id") or "").strip()
    client_secret = (proj.get("shopify_client_secret") or "").strip()
    if not shop or not client_id or not client_secret or not hasattr(st, "update_project_fields"):
        return proj

    exchanged = await exchange_client_credentials(
        shop=shop,
        client_id=client_id,
        client_secret=client_secret,
    )
    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    scope_raw = (exchanged.get("scope") or "").strip()
    updates = {
        "shopify_access_token": (exchanged.get("access_token") or "").strip(),
        "shopify_scope": scope_raw[:2000] if scope_raw else "client_credentials",
        "shopify_token_expires_at": (exchanged.get("expires_at") or "").strip()[:32],
    }
    st.update_project_fields(pid, updates)
    merged = dict(proj)
    merged.update(updates)
    return merged


async def resolve_project_access_token(proj: dict) -> str:
    """
    Return a valid Admin API access token for the project.
    Refreshes via client credentials when client ID/secret are stored and token is expired.
    """
    token = (proj.get("shopify_access_token") or "").strip()
    shop = (proj.get("shopify_shop") or "").strip()
    client_id = (proj.get("shopify_client_id") or "").strip()
    client_secret = (proj.get("shopify_client_secret") or "").strip()

    if not token or not shop:
        return ""
    if not client_id or not client_secret or not token_expired(proj):
        return token

    exchanged = await exchange_client_credentials(
        shop=shop,
        client_id=client_id,
        client_secret=client_secret,
    )
    return (exchanged.get("access_token") or "").strip()


def credential_update_fields(
    *,
    shop: str,
    public_url: str,
    client_id: str,
    client_secret: str,
    exchanged: dict[str, Any],
    shop_name: str,
    now_str: str,
) -> dict[str, Any]:
    """Project fields to persist after a successful connect or refresh."""
    msg = f"Connected to {shop_name or shop}."
    return {
        "platform": "shopify",
        "shopify_shop": shop,
        "website_url": public_url or f"https://{shop}",
        "shopify_client_id": client_id,
        "shopify_client_secret": client_secret,
        "shopify_access_token": (exchanged.get("access_token") or "").strip(),
        "shopify_scope": (exchanged.get("scope") or "client_credentials").strip()[:2000],
        "shopify_token_expires_at": (exchanged.get("expires_at") or "").strip()[:32],
        "shopify_connected_at": now_str,
        "shopify_verified_at": now_str,
        "shopify_verified_status": "connected",
        "shopify_verified_message": msg[:1000],
        "shopify_sync_status": "",
        "shopify_sync_message": msg[:500],
    }
