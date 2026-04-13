"""
Google OAuth (Search Console) integration.

Requires env:
  GOOGLE_OAUTH_CLIENT_ID
  GOOGLE_OAUTH_CLIENT_SECRET

Configure OAuth consent + redirect URI in Google Cloud Console, e.g.:
  http://127.0.0.1:5000/oauth/google/callback

Tokens are stored in data/google_oauth.json (refresh token for long-lived access).
"""

from __future__ import annotations

import json
import os
from typing import Any

from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

_ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
_DATA_DIR = os.path.join(_ROOT_DIR, "data")
_OAUTH_STORE = os.path.join(_DATA_DIR, "google_oauth.json")


def _load_dotenv_if_available() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv(os.path.join(_ROOT_DIR, ".env"))

# Search Console + identity (email for UI)
SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/webmasters",
]


def _ensure_data_dir() -> None:
    os.makedirs(_DATA_DIR, exist_ok=True)


def oauth_client_configured() -> bool:
    cid = (os.environ.get("GOOGLE_OAUTH_CLIENT_ID") or "").strip()
    csec = (os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET") or "").strip()
    return bool(cid and csec)


def _client_config_dict() -> dict[str, Any]:
    return {
        "web": {
            "client_id": (os.environ.get("GOOGLE_OAUTH_CLIENT_ID") or "").strip(),
            "client_secret": (os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET") or "").strip(),
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }


def build_flow(redirect_uri: str) -> Flow:
    """
    Web OAuth client uses client_secret on the server; do not auto-enable PKCE.
    If PKCE is used, the same Flow instance (or its code_verifier) must be kept
    across the redirect — a fresh Flow on the callback causes
    (invalid_grant) Missing code verifier.
    """
    return Flow.from_client_config(
        _client_config_dict(),
        scopes=SCOPES,
        redirect_uri=redirect_uri,
        autogenerate_code_verifier=False,
    )


def save_oauth_session(credentials: Credentials, email: str | None) -> None:
    _ensure_data_dir()
    payload = json.loads(credentials.to_json())
    out = {"credentials": payload, "email": (email or "").strip()}
    with open(_OAUTH_STORE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


def load_credentials() -> Credentials | None:
    if not os.path.isfile(_OAUTH_STORE):
        return None
    try:
        with open(_OAUTH_STORE, encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        return None
    creds_dict = raw.get("credentials")
    if not isinstance(creds_dict, dict):
        return None
    try:
        return Credentials.from_authorized_user_info(creds_dict, SCOPES)
    except Exception:
        return None


def get_valid_credentials() -> Credentials | None:
    """Return credentials, refreshing the access token when expired (uses refresh_token on disk)."""
    creds = load_credentials()
    if not creds:
        return None
    if not creds.valid:
        if not creds.refresh_token:
            return None
        try:
            from google.auth.transport.requests import Request

            creds.refresh(Request())
            email = get_stored_email()
            save_oauth_session(creds, email)
        except Exception:
            return None
    return creds


def get_stored_email() -> str | None:
    if not os.path.isfile(_OAUTH_STORE):
        return None
    try:
        with open(_OAUTH_STORE, encoding="utf-8") as f:
            raw = json.load(f)
        e = raw.get("email")
        return (e or "").strip() or None
    except Exception:
        return None


def disconnect() -> None:
    try:
        if os.path.isfile(_OAUTH_STORE):
            os.remove(_OAUTH_STORE)
    except OSError:
        pass


def fetch_user_email(credentials: Credentials) -> str | None:
    import requests

    try:
        token = credentials.token
        if not token:
            return None
        r = requests.get(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
        if not r.ok:
            return None
        data = r.json()
        return (data.get("email") or "").strip() or None
    except Exception:
        return None


def list_search_console_sites(credentials: Credentials) -> list[dict[str, Any]]:
    """Returns Search Console site entries (siteUrl, permissionLevel)."""
    service = build("webmasters", "v3", credentials=credentials, cache_discovery=False)
    resp = service.sites().list().execute()
    entries = resp.get("siteEntry") or []
    if not isinstance(entries, list):
        return []
    out: list[dict[str, Any]] = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        su = (e.get("siteUrl") or "").strip()
        if not su:
            continue
        out.append(
            {
                "siteUrl": su,
                "permissionLevel": (e.get("permissionLevel") or "").strip(),
            }
        )
    out.sort(key=lambda x: x["siteUrl"].lower())
    return out


def request_url_inspection(credentials: Credentials, site_url: str, inspection_url: str) -> dict[str, Any]:
    """
    Calls Search Console URL Inspection API (index.inspect).
    This asks Search Console to process the URL; the response includes inspection data.
    Crawl/index state in the Search Console UI updates on Google's timeline (not immediate).
    """
    site_url = (site_url or "").strip()
    inspection_url = (inspection_url or "").strip()
    if not site_url or not inspection_url:
        raise ValueError("site_url and inspection_url are required.")
    service = build("searchconsole", "v1", credentials=credentials, cache_discovery=False)
    body = {"inspectionUrl": inspection_url, "siteUrl": site_url}
    return service.urlInspection().index().inspect(body=body).execute()


def gsc_inspection_response_accepted(api_response: dict[str, Any]) -> bool:
    """
    True only when the API returned a non-empty inspection payload.
    Avoids marking articles as submitted when the call returned an empty or invalid body.
    """
    if not isinstance(api_response, dict):
        return False
    ir = api_response.get("inspectionResult")
    if not isinstance(ir, dict) or not ir:
        return False
    return True


_load_dotenv_if_available()
