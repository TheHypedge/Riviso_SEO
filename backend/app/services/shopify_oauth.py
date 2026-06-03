"""Shopify OAuth helpers (custom app / public app credentials)."""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from typing import Any
from urllib.parse import urlencode, urlparse

import httpx
from jose import jwt

from app.core.config import settings
from app.services.url_guard import SsrfError, assert_public_http_url, ssrf_guarded_event_hooks

_MYSHOPIFY_HOST_RE = re.compile(r"([a-z0-9][a-z0-9\-]*\.myshopify\.com)", re.IGNORECASE)

SHOPIFY_SCOPES = ",".join(
    [
        "read_products",
        "write_products",
        "read_content",
        "write_content",
        "read_online_store_pages",
        "write_online_store_pages",
    ]
)

SHOPIFY_API_VERSION = "2024-10"


def _shopify_credentials() -> tuple[str, str]:
    return (
        (settings.shopify_api_key or "").strip(),
        (settings.shopify_api_secret or "").strip(),
    )


def oauth_misconfiguration_reason() -> str | None:
    """
    Return a human-readable reason when Shopify OAuth cannot work, else None.

    Partners apps expose a **Client ID** (API key) and a separate **Client secret**.
    Using the Client ID for both env vars breaks HMAC verification and token exchange.
    """
    key, secret = _shopify_credentials()
    if not key or not secret:
        return "Set SHOPIFY_API_KEY and SHOPIFY_API_SECRET in the server environment."
    if key == secret:
        return (
            "SHOPIFY_API_SECRET must be the Client secret from Shopify Partners (App setup), "
            "not the same value as SHOPIFY_API_KEY (Client ID)."
        )
    if secret.upper().startswith("REPLACE_") or secret.lower() in ("your_client_secret", "changeme"):
        return "Set SHOPIFY_API_SECRET to your Client secret from Shopify Partners (App setup → Client credentials)."
    return None


def oauth_configured() -> bool:
    return oauth_misconfiguration_reason() is None


def hmac_failure_hint() -> str:
    reason = oauth_misconfiguration_reason()
    if reason:
        return f"Shopify OAuth verification failed: {reason}"
    return (
        "Shopify OAuth verification failed (invalid HMAC). "
        "Confirm SHOPIFY_API_SECRET is the Client secret from Shopify Partners for this app."
    )


def parse_store_hostname(raw: str) -> str:
    """Hostname only from user input (custom domain or myshopify.com)."""
    s = (raw or "").strip().lower()
    if not s:
        return ""
    if not s.startswith(("http://", "https://")):
        s = f"https://{s}"
    try:
        host = (urlparse(s).hostname or "").strip().lower()
    except Exception:
        host = ""
    return host.split("/")[0] if host else ""


def normalize_shop_domain(raw: str) -> str:
    host = parse_store_hostname(raw)
    if not host:
        return ""
    if host.endswith(".myshopify.com"):
        return host
    if "." not in host:
        return f"{host}.myshopify.com"
    return host


def _find_myshopify_in_text(text: str) -> str:
    m = _MYSHOPIFY_HOST_RE.search(text or "")
    return (m.group(1).lower() if m else "")


def _find_myshopify_in_url(url: str) -> str:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return ""
    if host.endswith(".myshopify.com"):
        return host
    return _find_myshopify_in_text(url)


async def resolve_shop_domain(raw: str) -> tuple[str, str, str | None]:
    """
    Resolve user input to the Shopify admin hostname (``*.myshopify.com``).

    Accepts public storefront URLs (``https://kwirky.in``) or admin domains
    (``kwirky-ak.myshopify.com``). Returns ``(myshopify_host, public_website_url, error)``.
    """
    host = parse_store_hostname(raw)
    if not host:
        return "", "", "Enter your store website or Shopify address."

    if host.endswith(".myshopify.com"):
        return host, f"https://{host}", None

    if "." not in host:
        shop = f"{host}.myshopify.com"
        return shop, f"https://{shop}", None

    public_url = f"https://{host}"
    # S1.6b: the host is user-supplied — block internal/metadata targets before probing.
    try:
        assert_public_http_url(public_url)
    except SsrfError:
        return "", public_url, "This website address is not allowed."
    paths = ("/cart.js", "/", "/meta.json")
    async with httpx.AsyncClient(
        timeout=12.0, follow_redirects=True, event_hooks=ssrf_guarded_event_hooks()
    ) as client:
        for path in paths:
            try:
                res = await client.get(f"{public_url}{path}")
                found = _find_myshopify_in_url(str(res.url)) or _find_myshopify_in_text(res.text[:500_000])
                if found:
                    return found, public_url, None
            except Exception:
                continue

    return (
        "",
        public_url,
        "We could not link this website to a Shopify store. "
        "Try your admin address instead (e.g. your-store.myshopify.com from Shopify Admin → Settings → Domains).",
    )


def validate_return_origin(raw: str | None) -> str:
    """Allowed browser origin for post-OAuth redirect (must match where auth tokens live)."""
    default = ""
    if settings.frontend_base_url:
        default = str(settings.frontend_base_url).strip().rstrip("/")
    s = (raw or "").strip().rstrip("/")
    if not s:
        return default
    try:
        u = urlparse(s if "://" in s else f"https://{s}")
    except Exception:
        return default
    if u.scheme not in ("http", "https") or not u.netloc:
        return default
    host = (u.hostname or "").lower()
    allowed: set[str] = {"localhost", "127.0.0.1"}
    if settings.frontend_base_url:
        fb = urlparse(str(settings.frontend_base_url))
        if fb.hostname:
            allowed.add(fb.hostname.lower())
    cors = str(getattr(settings, "cors_origins", "") or "")
    for part in cors.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            h = (urlparse(part).hostname or "").lower()
            if h:
                allowed.add(h)
        except Exception:
            continue
    if host not in allowed:
        return default
    return f"{u.scheme}://{u.netloc}"


def make_state_token(*, user_id: str, project_id: str, shop: str, return_origin: str = "") -> str:
    uid = (user_id or "").strip()
    pid = (project_id or "").strip()
    shop_norm = normalize_shop_domain(shop)
    if not uid or not pid or not shop_norm:
        raise ValueError("Missing user_id, project_id, or shop")
    now = int(time.time())
    ret = validate_return_origin(return_origin)
    payload: dict[str, Any] = {
        "uid": uid,
        "pid": pid,
        "shop": shop_norm,
        "nonce": secrets.token_hex(16),
        "iat": now,
        "exp": now + 15 * 60,
    }
    if ret:
        payload["ret"] = ret
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")


def parse_state_token(state: str) -> dict[str, str]:
    raw = (state or "").strip()
    if not raw:
        raise ValueError("Missing state")
    data = jwt.decode(raw, settings.secret_key, algorithms=["HS256"])
    return {
        "uid": str(data.get("uid") or "").strip(),
        "pid": str(data.get("pid") or "").strip(),
        "shop": normalize_shop_domain(str(data.get("shop") or "")),
        "return_origin": validate_return_origin(str(data.get("ret") or "")),
    }


def verify_oauth_hmac(query_params: dict[str, str], *, client_secret: str | None = None) -> bool:
    secret = (client_secret or "").strip() or (settings.shopify_api_secret or "").strip()
    if not secret:
        return False
    received = (query_params.get("hmac") or "").strip()
    if not received:
        return False
    pairs = []
    for key in sorted(query_params.keys()):
        if key == "hmac":
            continue
        pairs.append(f"{key}={query_params[key]}")
    message = "&".join(pairs).encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
    return hmac.compare_digest(digest, received)


def build_authorize_url(*, shop: str, redirect_uri: str, state: str) -> str:
    shop_norm = normalize_shop_domain(shop)
    client_id = (settings.shopify_api_key or "").strip()
    if not shop_norm or not client_id:
        raise ValueError("Shopify app credentials or shop domain missing")
    params = {
        "client_id": client_id,
        "scope": SHOPIFY_SCOPES,
        "redirect_uri": redirect_uri,
        "state": state,
    }
    return f"https://{shop_norm}/admin/oauth/authorize?{urlencode(params)}"


async def exchange_code_for_token(*, shop: str, code: str) -> dict[str, Any]:
    shop_norm = normalize_shop_domain(shop)
    client_id = (settings.shopify_api_key or "").strip()
    client_secret = (settings.shopify_api_secret or "").strip()
    if not shop_norm or not client_id or not client_secret:
        raise ValueError("Shopify OAuth is not configured")
    url = f"https://{shop_norm}/admin/oauth/access_token"
    payload = {
        "client_id": client_id,
        "client_secret": client_secret,
        "code": (code or "").strip(),
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.post(url, json=payload)
        res.raise_for_status()
        data = res.json()
    if not isinstance(data, dict) or not (data.get("access_token") or "").strip():
        raise ValueError("Shopify token response missing access_token")
    return data
