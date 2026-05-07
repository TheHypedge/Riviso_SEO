from __future__ import annotations

import secrets
import time
from typing import Any
from urllib.parse import quote, urlencode

import httpx
from jose import jwt

from app.core.config import settings


GOOGLE_AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
GSC_SITES_LIST_URL = "https://www.googleapis.com/webmasters/v3/sites"
GSC_INSPECT_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
GSC_INSPECT_PANEL_BASE = "https://search.google.com/search-console/inspect"
GSC_SITEMAPS_URL_TPL = "https://www.googleapis.com/webmasters/v3/sites/{site}/sitemaps"
GSC_SITEMAP_FEED_URL_TPL = "https://www.googleapis.com/webmasters/v3/sites/{site}/sitemaps/{feed}"


def build_inspection_panel_url(*, site_url: str, inspection_url: str) -> str:
    """
    Build the Google Search Console URL Inspection panel link, pre-filled with ``inspection_url``.

    ``REQUEST INDEXING`` is exclusively a web-UI action — it has no public API. We therefore
    expose this deep link in the product so users can complete the manual step in one click,
    and so we never falsely claim that a programmatic call submitted the URL for indexing.
    """
    su = (site_url or "").strip()
    iu = (inspection_url or "").strip()
    if not su or not iu:
        return ""
    return f"{GSC_INSPECT_PANEL_BASE}?resource_id={quote(su, safe='')}&id={quote(iu, safe='')}"

GSC_SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    # needed for URL Inspection
    "https://www.googleapis.com/auth/webmasters",
]


def oauth_configured() -> bool:
    return bool((settings.google_oauth_client_id or "").strip() and (settings.google_oauth_client_secret or "").strip())


def make_state_token(*, user_id: str, project_id: str | None = None) -> str:
    """
    Mint a short-lived signed state token. ``project_id`` (when provided) is encoded
    so the OAuth callback can route the resulting tokens to the per-project record
    instead of the legacy user-level GSC fields.
    """
    uid = (user_id or "").strip()
    if not uid:
        raise ValueError("Missing user_id")
    now = int(time.time())
    payload: dict[str, Any] = {
        "uid": uid,
        "nonce": secrets.token_hex(16),
        "iat": now,
        "exp": now + 15 * 60,
    }
    pid = (project_id or "").strip()
    if pid:
        payload["pid"] = pid
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")


def parse_state_token(state: str) -> dict[str, str]:
    """
    Decode a state token. Returns ``{"uid": str, "pid": str | None}``. Older callers
    that only need ``uid`` should read it from the returned dict.
    """
    raw = (state or "").strip()
    if not raw:
        raise ValueError("Missing state")
    payload = jwt.decode(raw, settings.secret_key, algorithms=["HS256"])
    uid = (payload.get("uid") or "").strip()
    if not uid:
        raise ValueError("Invalid state")
    pid = (payload.get("pid") or "").strip() or None
    return {"uid": uid, "pid": pid}


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


# ---------------------------------------------------------------------------
# Sitemaps API (https://www.googleapis.com/webmasters/v3/sites/{site}/sitemaps)
# ---------------------------------------------------------------------------


def _normalize_sitemap_entry(e: dict[str, Any]) -> dict[str, Any]:
    """
    Reduce a raw GSC ``WmxSitemap`` resource to the fields the UI needs.

    The Sitemaps API returns ``contents`` as ``[{type, submitted, indexed}]``;
    we keep just the totals (web pages bucket if present, else first row) so
    the UI can show "X submitted / Y indexed" without unpacking the array.
    """
    if not isinstance(e, dict):
        return {}
    contents = e.get("contents") if isinstance(e.get("contents"), list) else []
    submitted = ""
    indexed = ""
    if contents:
        # Prefer the "web" contentType bucket; some sitemaps only carry one row.
        web = next(
            (c for c in contents if isinstance(c, dict) and (c.get("type") or "").lower() == "web"),
            None,
        ) or (contents[0] if isinstance(contents[0], dict) else {})
        submitted = str(web.get("submitted") or "").strip()
        indexed = str(web.get("indexed") or "").strip()
    return {
        "path": (e.get("path") or "").strip(),
        "last_submitted": (e.get("lastSubmitted") or "").strip(),
        "is_pending": bool(e.get("isPending", False)),
        "is_sitemaps_index": bool(e.get("isSitemapsIndex", False)),
        "type": (e.get("type") or "").strip(),
        "last_downloaded": (e.get("lastDownloaded") or "").strip(),
        "warnings": int(e.get("warnings") or 0) if str(e.get("warnings") or "").isdigit() else 0,
        "errors": int(e.get("errors") or 0) if str(e.get("errors") or "").isdigit() else 0,
        "submitted_urls": submitted,
        "indexed_urls": indexed,
    }


async def list_sitemaps(*, access_token: str, site_url: str) -> list[dict[str, Any]]:
    """List sitemaps registered against the verified Search Console property."""
    tok = (access_token or "").strip()
    su = (site_url or "").strip()
    if not tok:
        raise RuntimeError("Missing access token")
    if not su:
        raise ValueError("site_url is required")
    url = GSC_SITEMAPS_URL_TPL.format(site=quote(su, safe=""))
    async with httpx.AsyncClient(timeout=20.0) as client:
        res = await client.get(url, headers={"authorization": f"Bearer {tok}"})
    if res.status_code == 404:
        # Property exists but has no sitemaps yet — surface as empty list.
        return []
    data = res.json() if res.content else {}
    if res.status_code != 200:
        raise RuntimeError(f"Sitemaps list failed ({res.status_code}): {data}")
    entries = (data.get("sitemap") if isinstance(data, dict) else None) or []
    out: list[dict[str, Any]] = []
    if isinstance(entries, list):
        for e in entries:
            normalised = _normalize_sitemap_entry(e)
            if normalised.get("path"):
                out.append(normalised)
    out.sort(key=lambda x: (x.get("path") or "").lower())
    return out


async def submit_sitemap(*, access_token: str, site_url: str, feedpath: str) -> None:
    """
    Register (or re-submit) ``feedpath`` against the verified property.

    Google's API uses ``PUT`` and returns ``200 OK`` (sometimes ``204 No Content``)
    with no body on success. Errors come back as ``{error: {message, errors[]}}``.
    """
    tok = (access_token or "").strip()
    su = (site_url or "").strip()
    fp = (feedpath or "").strip()
    if not tok:
        raise RuntimeError("Missing access token")
    if not su or not fp:
        raise ValueError("site_url and feedpath are required")
    url = GSC_SITEMAP_FEED_URL_TPL.format(site=quote(su, safe=""), feed=quote(fp, safe=""))
    async with httpx.AsyncClient(timeout=20.0) as client:
        res = await client.put(url, headers={"authorization": f"Bearer {tok}"})
    if res.status_code in (200, 201, 204):
        return
    try:
        data = res.json() if res.content else {}
    except Exception:
        data = {"raw": (res.text or "")[:300]}
    raise RuntimeError(f"Sitemap submit failed ({res.status_code}): {data}")


async def delete_sitemap(*, access_token: str, site_url: str, feedpath: str) -> None:
    """Unregister ``feedpath`` from the verified property."""
    tok = (access_token or "").strip()
    su = (site_url or "").strip()
    fp = (feedpath or "").strip()
    if not tok:
        raise RuntimeError("Missing access token")
    if not su or not fp:
        raise ValueError("site_url and feedpath are required")
    url = GSC_SITEMAP_FEED_URL_TPL.format(site=quote(su, safe=""), feed=quote(fp, safe=""))
    async with httpx.AsyncClient(timeout=20.0) as client:
        res = await client.delete(url, headers={"authorization": f"Bearer {tok}"})
    if res.status_code in (200, 204, 404):
        return
    try:
        data = res.json() if res.content else {}
    except Exception:
        data = {"raw": (res.text or "")[:300]}
    raise RuntimeError(f"Sitemap delete failed ({res.status_code}): {data}")

