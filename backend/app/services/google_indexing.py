from __future__ import annotations

import base64
import json
from typing import Any

import httpx

from app.core.config import settings


INDEXING_SCOPE = "https://www.googleapis.com/auth/indexing"
INDEXING_PUBLISH_URL = "https://indexing.googleapis.com/v3/urlNotifications:publish"


def configured() -> bool:
    return bool((settings.google_indexing_service_account_json or "").strip())


def _service_account_info() -> dict[str, Any]:
    raw = (settings.google_indexing_service_account_json or "").strip()
    if not raw:
        raise RuntimeError("Google Indexing API service account JSON is not configured")
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
        except Exception as e:
            raise RuntimeError(f"Invalid service account JSON: {e}") from e
        if not isinstance(data, dict):
            raise RuntimeError("Invalid service account JSON payload")
        return data
    try:
        decoded = base64.b64decode(raw.encode("utf-8")).decode("utf-8")
        data = json.loads(decoded)
    except Exception as e:
        raise RuntimeError(f"Service account JSON must be raw JSON or base64 JSON: {e}") from e
    if not isinstance(data, dict):
        raise RuntimeError("Invalid service account JSON payload")
    return data


def _access_token() -> str:
    # google-auth is an optional dependency for the backend; keep import local.
    from google.auth.transport.requests import Request
    from google.oauth2 import service_account

    info = _service_account_info()
    creds = service_account.Credentials.from_service_account_info(info, scopes=[INDEXING_SCOPE])
    creds.refresh(Request())
    tok = (creds.token or "").strip()
    if not tok:
        raise RuntimeError("Failed to obtain Indexing API access token")
    return tok


async def publish_url_update(*, url: str) -> dict[str, Any]:
    """
    Calls Google Indexing API (urlNotifications.publish).
    NOTE: This API only works for eligible content types (e.g., JobPosting/BroadcastEvent) and
    requires the service account to be an owner in Search Console for the property.
    """
    u = (url or "").strip()
    if not u:
        raise ValueError("url is required")
    token = _access_token()
    payload = {"url": u, "type": "URL_UPDATED"}
    async with httpx.AsyncClient(timeout=20.0) as client:
        res = await client.post(INDEXING_PUBLISH_URL, json=payload, headers={"authorization": f"Bearer {token}"})
    data: Any
    try:
        data = res.json() if res.content else {}
    except Exception:
        data = {"raw": (res.text or "")[:500]}
    if res.status_code not in (200, 201):
        raise RuntimeError(f"Indexing API publish failed ({res.status_code}): {data}")
    if not isinstance(data, dict):
        raise RuntimeError("Indexing API returned invalid payload")
    return data

