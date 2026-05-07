"""
Helpers that bridge Google Search Console / Indexing API access from per-project
(preferred) or per-user (legacy fallback) credentials, and store the article's
indexing state for the UI.

Two public helpers:

- :func:`maybe_request_url_inspection` — fired automatically after a live publish.
- :func:`request_url_inspection_now` — fired manually from the article actions UI.

Both prefer :func:`google_indexing.publish_url_update` (Indexing API via service
account) when configured; otherwise they fall back to the user's OAuth-issued
URL Inspection API token.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any

from app.services import gsc
from app.services import google_indexing


log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Token resolution (project preferred, owner user as fallback)
# ---------------------------------------------------------------------------


def _project_has_oauth(proj: dict) -> bool:
    return bool((proj.get("gsc_refresh_token") or "").strip())


def _owner_has_oauth(owner_user: dict | None) -> bool:
    if not isinstance(owner_user, dict):
        return False
    return bool((owner_user.get("gsc_refresh_token") or "").strip())


async def _refresh_for_project(*, st, proj: dict) -> str:
    """Refresh the project's GSC access token using its stored refresh token; persist back."""
    pid = (proj.get("id") or "").strip()
    rt = (proj.get("gsc_refresh_token") or "").strip()
    if not pid or not rt:
        raise RuntimeError("project missing refresh token")
    tok = await gsc.refresh_access_token(refresh_token=rt)
    at = (tok.get("access_token") or "").strip()
    expires_in = int(tok.get("expires_in") or 0)
    exp = int(time.time()) + max(0, expires_in)
    if at and hasattr(st, "update_project_fields"):
        st.update_project_fields(pid, {"gsc_access_token": at, "gsc_token_expires_at": str(exp)})
    return at


async def _refresh_for_user(*, st, uid: str, refresh_token: str) -> str:
    tok = await gsc.refresh_access_token(refresh_token=refresh_token)
    at = (tok.get("access_token") or "").strip()
    expires_in = int(tok.get("expires_in") or 0)
    exp = int(time.time()) + max(0, expires_in)
    if at and uid and hasattr(st, "update_user_fields"):
        st.update_user_fields(uid, {"gsc_access_token": at, "gsc_token_expires_at": str(exp)})
    return at


async def _get_valid_access_token_for_project(*, st, proj: dict) -> tuple[str, str]:
    """
    Return ``(access_token, source)`` where ``source`` is "project" or "user".

    Prefers the project's own GSC connection. Falls back to the project owner's
    user-level GSC tokens (legacy connection flow). Raises ``RuntimeError`` when
    nothing is connected on either layer.
    """
    if _project_has_oauth(proj):
        at = (proj.get("gsc_access_token") or "").strip()
        exp_raw = (proj.get("gsc_token_expires_at") or "").strip()
        try:
            exp = int(exp_raw or "0")
        except Exception:
            exp = 0
        now = int(time.time())
        if at and exp and (exp - now) > 60:
            return at, "project"
        try:
            return (await _refresh_for_project(st=st, proj=proj), "project")
        except Exception as e:
            log.warning("Project-level GSC token refresh failed (project=%s): %s", proj.get("id"), e)
            # Fall through to user-level fallback below.

    owner_uid = (proj.get("owner_user_id") or "").strip()
    if not owner_uid or not hasattr(st, "get_user_by_id"):
        raise RuntimeError("Search Console is not connected for this project")
    owner = st.get_user_by_id(owner_uid) or {}
    if not _owner_has_oauth(owner):
        raise RuntimeError("Search Console is not connected for this project")
    at = (owner.get("gsc_access_token") or "").strip()
    exp_raw = (owner.get("gsc_token_expires_at") or "").strip()
    try:
        exp = int(exp_raw or "0")
    except Exception:
        exp = 0
    now = int(time.time())
    if at and exp and (exp - now) > 60:
        return at, "user"
    rt = (owner.get("gsc_refresh_token") or "").strip()
    return (await _refresh_for_user(st=st, uid=owner_uid, refresh_token=rt), "user")


# ---------------------------------------------------------------------------
# Article indexing helpers
# ---------------------------------------------------------------------------


def _now_str() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")


async def _mark_article(*, st, article_id: str | None, patch: dict[str, Any]) -> None:
    if article_id and hasattr(st, "update_article_fields"):
        try:
            st.update_article_fields(article_id, patch)
        except Exception:
            log.exception("Failed to write GSC indexing state on article=%s", article_id)


async def _attempt_inspection_via_oauth(*, st, proj: dict, live_url: str) -> dict[str, Any]:
    prop = (proj.get("gsc_property_url") or "").strip()
    if not prop:
        raise RuntimeError("Search Console property is not selected for this project")
    at, _src = await _get_valid_access_token_for_project(st=st, proj=proj)
    return await gsc.request_url_inspection(access_token=at, site_url=prop, inspection_url=live_url)


async def request_url_inspection_now(*, st, proj: dict, live_url: str, article_id: str | None) -> bool:
    """
    Manual trigger for "Index this URL" / "Inspect URL".

    Tries the Google Indexing API first (service account), then falls back to the
    Search Console URL Inspection API using the project's own OAuth tokens (or the
    legacy user-level tokens when the project is not yet connected).

    Stores the resulting ``gsc_status`` / ``gsc_inspection_*`` fields on the article.
    """
    url = (live_url or "").strip()
    if not url:
        return False

    now_str = _now_str()
    indexing_attempted = False

    if google_indexing.configured():
        indexing_attempted = True
        await _mark_article(
            st=st,
            article_id=article_id,
            patch={
                "gsc_status": "pending",
                "gsc_inspection_last_attempt_at": now_str,
                "gsc_inspection_error": "",
                "gsc_inspection_url": url,
            },
        )
        try:
            await google_indexing.publish_url_update(url=url)
            await _mark_article(
                st=st,
                article_id=article_id,
                patch={
                    "gsc_status": "inspected",
                    "gsc_inspection_requested_at": now_str,
                    "gsc_inspection_last_attempt_at": now_str,
                    "gsc_inspection_error": "",
                    "gsc_inspection_url": url,
                },
            )
            return True
        except Exception as e:
            await _mark_article(
                st=st,
                article_id=article_id,
                patch={
                    "gsc_status": "pending",
                    "gsc_inspection_last_attempt_at": now_str,
                    "gsc_inspection_error": f"Indexing API failed: {str(e)[:460]}",
                    "gsc_inspection_url": url,
                },
            )

    if not gsc.oauth_configured():
        if not indexing_attempted:
            await _mark_article(
                st=st,
                article_id=article_id,
                patch={
                    "gsc_status": "pending",
                    "gsc_inspection_last_attempt_at": now_str,
                    "gsc_inspection_error": "Google OAuth client is not configured on the backend.",
                    "gsc_inspection_url": url,
                },
            )
        return False

    try:
        await _mark_article(
            st=st,
            article_id=article_id,
            patch={
                "gsc_status": "pending",
                "gsc_inspection_last_attempt_at": now_str,
                "gsc_inspection_error": "",
                "gsc_inspection_url": url,
            },
        )
        resp = await _attempt_inspection_via_oauth(st=st, proj=proj, live_url=url)
        if not gsc.inspection_response_accepted(resp):
            await _mark_article(
                st=st,
                article_id=article_id,
                patch={
                    "gsc_status": "pending",
                    "gsc_inspection_last_attempt_at": now_str,
                    "gsc_inspection_error": "Inspection API returned no inspectionResult.",
                    "gsc_inspection_url": url,
                },
            )
            return False
        await _mark_article(
            st=st,
            article_id=article_id,
            patch={
                "gsc_status": "inspected",
                "gsc_inspection_requested_at": now_str,
                "gsc_inspection_last_attempt_at": now_str,
                "gsc_inspection_error": "",
                "gsc_inspection_url": url,
            },
        )
        return True
    except Exception as e:
        await _mark_article(
            st=st,
            article_id=article_id,
            patch={
                "gsc_status": "pending",
                "gsc_inspection_last_attempt_at": now_str,
                "gsc_inspection_error": str(e)[:500],
                "gsc_inspection_url": url,
            },
        )
        return False


async def maybe_request_url_inspection(
    *, st, proj: dict, live_url: str, wp_status: str | None, article_id: str | None
) -> bool:
    """
    Fired automatically after a successful live publish (REST status == ``publish``).

    Honors the per-project ``gsc_index_on_publish`` toggle (default True). Requires
    a non-empty ``live_url`` and a Search Console property linked to the project.
    Delegates the actual call chain to :func:`request_url_inspection_now` so the
    Indexing API + URL Inspection fallback path stays in one place.
    """
    if (wp_status or "").strip().lower() != "publish":
        return False
    url = (live_url or "").strip()
    if not url:
        return False
    if not proj.get("gsc_index_on_publish", True):
        return False
    prop = (proj.get("gsc_property_url") or "").strip()
    if not prop:
        return False
    return await request_url_inspection_now(st=st, proj=proj, live_url=url, article_id=article_id)


async def inspect_url_status(*, st, proj: dict, live_url: str) -> dict[str, Any]:
    """
    Read-only "Check indexing" used by the UI to show coverageState / verdict /
    last crawl time without mutating article fields.

    Returns a flat, frontend-friendly dict (no nested ``inspectionResult``) plus
    a ``raw`` payload for advanced views. Raises ``RuntimeError`` on backend errors.
    """
    url = (live_url or "").strip()
    if not url:
        raise RuntimeError("live_url is required")
    prop = (proj.get("gsc_property_url") or "").strip()
    if not prop:
        raise RuntimeError("Search Console property is not selected for this project")
    if not gsc.oauth_configured():
        raise RuntimeError("Google OAuth client is not configured on the backend")

    at, _src = await _get_valid_access_token_for_project(st=st, proj=proj)
    resp = await gsc.request_url_inspection(access_token=at, site_url=prop, inspection_url=url)
    ir = resp.get("inspectionResult") if isinstance(resp, dict) else None
    if not isinstance(ir, dict):
        return {
            "url": url,
            "site_url": prop,
            "verdict": "",
            "coverage_state": "",
            "robots_txt_state": "",
            "indexing_state": "",
            "last_crawl_time": "",
            "page_fetch_state": "",
            "google_canonical": "",
            "user_canonical": "",
            "referring_urls": [],
            "fetched_at": _now_str(),
            "raw": resp,
        }
    index_status = ir.get("indexStatusResult") if isinstance(ir.get("indexStatusResult"), dict) else {}
    return {
        "url": url,
        "site_url": prop,
        "verdict": (index_status.get("verdict") or "").strip(),
        "coverage_state": (index_status.get("coverageState") or "").strip(),
        "robots_txt_state": (index_status.get("robotsTxtState") or "").strip(),
        "indexing_state": (index_status.get("indexingState") or "").strip(),
        "last_crawl_time": (index_status.get("lastCrawlTime") or "").strip(),
        "page_fetch_state": (index_status.get("pageFetchState") or "").strip(),
        "google_canonical": (index_status.get("googleCanonical") or "").strip(),
        "user_canonical": (index_status.get("userCanonical") or "").strip(),
        "referring_urls": list(index_status.get("referringUrls") or []),
        "fetched_at": _now_str(),
        "raw": resp,
    }
