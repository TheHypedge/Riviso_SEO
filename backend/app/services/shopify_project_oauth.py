"""OAuth install / scope update for per-project Developer Dashboard apps."""
from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

import httpx

from app.services.shopify_api_errors import RECOMMENDED_SCOPES, REQUIRED_SYNC_SCOPES, scopes_missing_for_sync
from app.services.shopify_client import ShopifyClient
from app.services.shopify_oauth import normalize_shop_domain

# Scopes requested when merchant (re)installs the app — must match Dev Dashboard version.
PROJECT_INSTALL_SCOPES = ",".join(RECOMMENDED_SCOPES)

REINSTALL_MESSAGE = (
    "Your store token is missing required Shopify Admin API scopes for this action. "
    "Releasing a new app version does not update existing installs — click Update app permissions "
    "in Riviso to run OAuth once, then Refresh connection and Sync from Shopify."
)


async def exchange_project_code_for_token(
    *,
    shop: str,
    code: str,
    client_id: str,
    client_secret: str,
) -> dict[str, Any]:
    shop_norm = normalize_shop_domain(shop)
    cid = (client_id or "").strip()
    secret = (client_secret or "").strip()
    if not shop_norm or not cid or not secret:
        raise ValueError("Shop, Client ID, and Client Secret are required for OAuth.")
    url = f"https://{shop_norm}/admin/oauth/access_token"
    payload = {
        "client_id": cid,
        "client_secret": secret,
        "code": (code or "").strip(),
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.post(url, json=payload)
        res.raise_for_status()
        data = res.json()
    if not isinstance(data, dict) or not (data.get("access_token") or "").strip():
        raise ValueError("Shopify token response missing access_token")
    return data


def build_project_authorize_url(
    *,
    shop: str,
    client_id: str,
    redirect_uri: str,
    state: str,
    scopes: str | None = None,
) -> str:
    shop_norm = normalize_shop_domain(shop)
    cid = (client_id or "").strip()
    if not shop_norm or not cid:
        raise ValueError("Shop and Client ID are required.")
    scope_str = (scopes or PROJECT_INSTALL_SCOPES).strip()
    params = {
        "client_id": cid,
        "scope": scope_str,
        "redirect_uri": redirect_uri,
        "state": state,
    }
    return f"https://{shop_norm}/admin/oauth/authorize?{urlencode(params)}"


async def live_token_scopes(*, shop: str, access_token: str) -> set[str]:
    client = ShopifyClient(shop=shop, access_token=access_token)
    try:
        handles = await client.fetch_access_scopes()
        return set(handles)
    except Exception:
        return set()


async def catalog_scopes_ready(*, shop: str, access_token: str) -> tuple[bool, list[str], set[str]]:
    """Return (ready, missing_required, live_scopes)."""
    granted = await live_token_scopes(shop=shop, access_token=access_token)
    missing = scopes_missing_for_sync(granted)
    return (len(missing) == 0, missing, granted)


def missing_scopes_message(*, missing: list[str], granted: set[str]) -> str:
    if not missing:
        return ""
    have = ", ".join(sorted(granted)[:12]) if granted else "none"
    need = ", ".join(f"`{s}`" for s in missing)
    return f"{REINSTALL_MESSAGE} Missing on token: {need}. Currently granted: {have}."
