from __future__ import annotations

import secrets
import time
from typing import Any
from urllib.parse import urlencode

import httpx
from jose import jwt

from app.core.config import settings


GOOGLE_AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
GSC_SITES_LIST_URL = "https://www.googleapis.com/webmasters/v3/sites"
GSC_INSPECT_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"

GSC_SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    # needed for URL Inspection
    "https://www.googleapis.com/auth/webmasters",
]


def oauth_configured() -> bool:
    return bool((settings.google_oauth_client_id or "").strip() and (settings.google_oauth_client_secret or "").strip())


def make_state_token(*, user_id: str) -> str:
    uid = (user_id or "").strip()
    if not uid:
        raise ValueError("Missing user_id")
    now = int(time.time())
    payload = {"uid": uid, "nonce": secrets.token_hex(16), "iat": now, "exp": now + 15 * 60}
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")


def parse_state_token(state: str) -> str:
    raw = (state or "").strip()
    if not raw:
        raise ValueError("Missing state")
    payload = jwt.decode(raw, settings.secret_key, algorithms=["HS256"])
    uid = (payload.get("uid") or "").strip()
    if not uid:
        raise ValueError("Invalid state")
    return uid


def build_auth_url(*, redirect_uri: str, state: str) -> str:
    if not oauth_configured():
        raise RuntimeError("Google OAuth client is not configured")
    params = {
        "client_id": settings.google_oauth_client_id.strip(),
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(GSC_SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": state,
    }
    return f"{GOOGLE_AUTH_BASE}?{urlencode(params)}"


async def exchange_code_for_tokens(*, code: str, redirect_uri: str) -> dict[str, Any]:
    if not oauth_configured():
        raise RuntimeError("Google OAuth client is not configured")
    payload = {
        "client_id": settings.google_oauth_client_id.strip(),
        "client_secret": settings.google_oauth_client_secret.strip(),
        "code": (code or "").strip(),
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        res = await client.post(GOOGLE_TOKEN_URL, data=payload)
    data = res.json() if res.content else {}
    if res.status_code != 200:
        raise RuntimeError(f"Token exchange failed ({res.status_code}): {data}")
    if not isinstance(data, dict):
        raise RuntimeError("Token exchange returned invalid payload")
    return data


async def refresh_access_token(*, refresh_token: str) -> dict[str, Any]:
    if not oauth_configured():
        raise RuntimeError("Google OAuth client is not configured")
    rt = (refresh_token or "").strip()
    if not rt:
        raise RuntimeError("Missing refresh token")
    payload = {
        "client_id": settings.google_oauth_client_id.strip(),
        "client_secret": settings.google_oauth_client_secret.strip(),
        "refresh_token": rt,
        "grant_type": "refresh_token",
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        res = await client.post(GOOGLE_TOKEN_URL, data=payload)
    data = res.json() if res.content else {}
    if res.status_code != 200:
        raise RuntimeError(f"Token refresh failed ({res.status_code}): {data}")
    if not isinstance(data, dict):
        raise RuntimeError("Token refresh returned invalid payload")
    return data


async def fetch_user_email(*, access_token: str) -> str | None:
    tok = (access_token or "").strip()
    if not tok:
        return None
    async with httpx.AsyncClient(timeout=15.0) as client:
        res = await client.get(GOOGLE_USERINFO_URL, headers={"authorization": f"Bearer {tok}"})
    if res.status_code != 200:
        return None
    data = res.json() if res.content else {}
    if not isinstance(data, dict):
        return None
    return (data.get("email") or "").strip() or None


async def list_search_console_sites(*, access_token: str) -> list[dict[str, Any]]:
    tok = (access_token or "").strip()
    if not tok:
        return []
    async with httpx.AsyncClient(timeout=20.0) as client:
        res = await client.get(GSC_SITES_LIST_URL, headers={"authorization": f"Bearer {tok}"})
    if res.status_code != 200:
        return []
    data = res.json() if res.content else {}
    entries = (data.get("siteEntry") if isinstance(data, dict) else None) or []
    out: list[dict[str, Any]] = []
    if isinstance(entries, list):
        for e in entries:
            if not isinstance(e, dict):
                continue
            su = (e.get("siteUrl") or "").strip()
            if not su:
                continue
            out.append({"siteUrl": su, "permissionLevel": (e.get("permissionLevel") or "").strip()})
    out.sort(key=lambda x: (x.get("siteUrl") or "").lower())
    return out


async def request_url_inspection(*, access_token: str, site_url: str, inspection_url: str) -> dict[str, Any]:
    tok = (access_token or "").strip()
    su = (site_url or "").strip()
    iu = (inspection_url or "").strip()
    if not tok:
        raise RuntimeError("Missing access token")
    if not su or not iu:
        raise ValueError("site_url and inspection_url are required")
    body = {"inspectionUrl": iu, "siteUrl": su}
    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.post(GSC_INSPECT_URL, headers={"authorization": f"Bearer {tok}"}, json=body)
    data = res.json() if res.content else {}
    if res.status_code != 200:
        raise RuntimeError(f"URL Inspection failed ({res.status_code}): {data}")
    if not isinstance(data, dict):
        raise RuntimeError("URL Inspection returned invalid payload")
    return data


def inspection_response_accepted(api_response: dict[str, Any]) -> bool:
    if not isinstance(api_response, dict):
        return False
    ir = api_response.get("inspectionResult")
    return isinstance(ir, dict) and bool(ir)

