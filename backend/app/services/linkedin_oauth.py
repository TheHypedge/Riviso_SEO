"""
LinkedIn OAuth2 + identity resolution -- mirrors gsc.py's shape exactly (state token,
build_auth_url, exchange_code_for_tokens, one userinfo fetch), the established template
in this codebase for a standard OAuth2 authorization-code provider.

Two products, requested in one consent screen: "Sign In with LinkedIn using OpenID
Connect" (self-serve, member identity + w_member_social) and "Share on LinkedIn"
(w_member_social itself) -- both self-serve, no waiting.

Company-Page posting (w_organization_social) is deliberately NOT requested by default:
LinkedIn refuses the *entire* authorization request if any requested scope isn't
granted to the app (confirmed: "unauthorized_scope_error"), it does not silently drop
just that one scope and proceed. w_organization_social requires a separate LinkedIn
Developer Program partner approval most self-serve apps don't have. Once an app has
that approval, add "w_organization_social" to LINKEDIN_SCOPES to enable the Company
Page picker (see fetch_administered_organizations, already wired to degrade to
member-only posting when it finds nothing).
"""

from __future__ import annotations

import secrets
import time
from typing import Any
from urllib.parse import urlencode

import httpx
from jose import jwt

from app.core.config import settings

LINKEDIN_AUTH_BASE = "https://www.linkedin.com/oauth/v2/authorization"
LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"
LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo"
LINKEDIN_ORG_ACLS_URL = "https://api.linkedin.com/rest/organizationAcls"
LINKEDIN_API_VERSION = "202609"  # required "Linkedin-Version" header, YYYYMM -- LinkedIn
# sunsets each version roughly a year after release and returns 426 Upgrade Required
# (NONEXISTENT_VERSION) once it does; bump this periodically to a currently-supported
# month rather than letting it go stale again.

LINKEDIN_SCOPES = ["openid", "profile", "email", "w_member_social"]


def oauth_configured() -> bool:
    return settings.linkedin_oauth_configured


def make_state_token(*, user_id: str, project_id: str, origin: str | None = None) -> str:
    uid = (user_id or "").strip()
    pid = (project_id or "").strip()
    if not uid or not pid:
        raise ValueError("Missing user_id or project_id")
    now = int(time.time())
    payload: dict[str, Any] = {
        "uid": uid,
        "pid": pid,
        "nonce": secrets.token_hex(16),
        "iat": now,
        "exp": now + 15 * 60,
    }
    o = (origin or "").strip()
    if o:
        payload["origin"] = o
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")


def parse_state_token(state: str) -> dict[str, str | None]:
    raw = (state or "").strip()
    if not raw:
        raise ValueError("Missing state")
    payload = jwt.decode(raw, settings.secret_key, algorithms=["HS256"])
    uid = (payload.get("uid") or "").strip()
    pid = (payload.get("pid") or "").strip()
    if not uid or not pid:
        raise ValueError("Invalid state")
    origin = (payload.get("origin") or "").strip() or None
    return {"uid": uid, "pid": pid, "origin": origin}


def build_auth_url(*, redirect_uri: str, state: str) -> str:
    if not oauth_configured():
        raise RuntimeError("LinkedIn OAuth client is not configured")
    params = {
        "response_type": "code",
        "client_id": settings.linkedin_client_id.strip(),
        "redirect_uri": redirect_uri,
        "state": state,
        "scope": " ".join(LINKEDIN_SCOPES),
    }
    return f"{LINKEDIN_AUTH_BASE}?{urlencode(params)}"


async def exchange_code_for_token(*, code: str, redirect_uri: str) -> dict[str, Any]:
    """Returns LinkedIn's raw token payload: {access_token, expires_in, scope, ...}.
    No refresh_token in the standard 3-legged flow -- the connection needs full
    re-auth roughly every `expires_in` seconds (~60 days), not a silent refresh."""
    if not oauth_configured():
        raise RuntimeError("LinkedIn OAuth client is not configured")
    payload = {
        "grant_type": "authorization_code",
        "code": (code or "").strip(),
        "redirect_uri": redirect_uri,
        "client_id": settings.linkedin_client_id.strip(),
        "client_secret": settings.linkedin_client_secret.strip(),
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        res = await client.post(
            LINKEDIN_TOKEN_URL,
            data=payload,
            headers={"content-type": "application/x-www-form-urlencoded"},
        )
    data = res.json() if res.content else {}
    if res.status_code != 200:
        raise RuntimeError(f"LinkedIn token exchange failed ({res.status_code}): {data}")
    if not isinstance(data, dict):
        raise RuntimeError("LinkedIn token exchange returned invalid payload")
    return data


async def fetch_member_identity(*, access_token: str) -> dict[str, Any]:
    """OpenID Connect userinfo -- {sub, name, email, picture, ...}. `sub` is the member
    id used to build the author URN `urn:li:person:{sub}`."""
    tok = (access_token or "").strip()
    if not tok:
        return {}
    async with httpx.AsyncClient(timeout=15.0) as client:
        res = await client.get(LINKEDIN_USERINFO_URL, headers={"authorization": f"Bearer {tok}"})
    if res.status_code != 200:
        return {}
    data = res.json() if res.content else {}
    return data if isinstance(data, dict) else {}


async def fetch_administered_organizations(*, access_token: str) -> list[dict[str, str]]:
    """Company Pages the connected member can post to, if w_organization_social was
    granted -- empty list (not an error) when it wasn't, so the caller just falls back
    to member-only posting."""
    tok = (access_token or "").strip()
    if not tok:
        return []
    params = {"q": "roleAssignee"}
    headers = {
        "authorization": f"Bearer {tok}",
        "Linkedin-Version": LINKEDIN_API_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        res = await client.get(LINKEDIN_ORG_ACLS_URL, params=params, headers=headers)
    if res.status_code != 200:
        return []
    data = res.json() if res.content else {}
    elements = (data.get("elements") if isinstance(data, dict) else None) or []
    out: list[dict[str, str]] = []
    for e in elements:
        if not isinstance(e, dict):
            continue
        org_urn = (e.get("organization") or "").strip()
        if not org_urn:
            continue
        out.append({"urn": org_urn, "role": (e.get("role") or "").strip()})
    return out


async def fetch_organization_name(*, access_token: str, org_urn: str) -> str | None:
    """Best-effort display name for an org URN (organizationAcls doesn't return one) --
    a picker showing a raw urn:li:organization:12345 isn't usable, so this fills it in.
    Returns None on any failure; caller falls back to the raw URN."""
    tok = (access_token or "").strip()
    org_id = (org_urn or "").rsplit(":", 1)[-1].strip()
    if not tok or not org_id.isdigit():
        return None
    headers = {
        "authorization": f"Bearer {tok}",
        "Linkedin-Version": LINKEDIN_API_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        res = await client.get(
            f"https://api.linkedin.com/rest/organizations/{org_id}",
            params={"projection": "(id,localizedName)"},
            headers=headers,
        )
    if res.status_code != 200:
        return None
    data = res.json() if res.content else {}
    if not isinstance(data, dict):
        return None
    return (data.get("localizedName") or "").strip() or None
