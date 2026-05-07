"""
Helpers that bridge Google Search Console / Indexing API access from per-project
(preferred) or per-user (legacy fallback) credentials, and store the article's
indexing state for the UI.

Important reality of Google's APIs (drives all the language used here):

- The **GSC URL Inspection API** is read-only. Calling it does NOT submit a URL
  for indexing — it only returns the current coverage state. We use it only for
  the "Check" action (:func:`inspect_url_status`).
- The **Google Indexing API** (``urlNotifications.publish``) is officially limited
  to ``JobPosting`` / ``BroadcastEvent`` content. Even when it accepts a call for
  general URLs, the request is **not** echoed into Search Console's URL Inspection
  "Indexing requested" history.
- The **GSC web UI "Request Indexing" button** is the only thing that produces
  the visible "Indexing requested" entry in URL Inspection. It has no public API.

Public helpers:

- :func:`maybe_request_url_inspection` — fired automatically after a live publish.
- :func:`request_url_inspection_now` — fired manually from the article actions UI.
- :func:`inspect_url_status` — read-only "Check" used by the UI.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any

from app.services import gsc
from app.services import google_indexing
from app.services.sitemap_ping import default_sitemap_url, ping_sitemap


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


async def request_url_inspection_now(
    *, st, proj: dict, live_url: str, article_id: str | None
) -> dict[str, Any]:
    """
    Manual "Index now" trigger.

    Behavior — honest about what's actually possible with Google's APIs:

    1. **Google Indexing API** (service account, when configured): we send
       ``urlNotifications.publish``. Officially this only indexes ``JobPosting``
       / ``BroadcastEvent`` content; for general articles Google may accept the
       call but it is **not** echoed into URL Inspection's "Indexing requested"
       history. We track this in ``indexing_api`` regardless.
    2. **Sitemap ping** (Google + Bing): best-effort discovery hint based on the
       project's WordPress site URL. Not a guarantee of indexing.
    3. **Manual handoff**: we always return a deep link to the GSC URL Inspection
       panel pre-filled with ``live_url``. Pressing "REQUEST INDEXING" there is
       the **only** action that produces the visible entry in the user's URL
       Inspection history (Google does not expose this as a public API).

    Never calls the read-only URL Inspection API (that's the "Check" action only).

    Returns a structured result the UI can surface verbatim::

        {
          "ok": True,
          "gsc_status": "index_api_pinged" | "sitemap_pinged" | "manual_required",
          "indexing_api": {"attempted": bool, "ok": bool, "error": str},
          "sitemap_ping": {"attempted": bool, "ok": bool, "sitemap_url": str},
          "inspect_panel_url": "https://search.google.com/search-console/inspect?...",
          "note": "<human-readable summary>",
        }
    """
    url = (live_url or "").strip()
    if not url:
        return {
            "ok": False,
            "gsc_status": "failed",
            "indexing_api": {"attempted": False, "ok": False, "error": ""},
            "sitemap_ping": {"attempted": False, "ok": False, "sitemap_url": ""},
            "inspect_panel_url": "",
            "note": "Article does not have a live URL yet (publish first).",
        }

    now_str = _now_str()
    prop = (proj.get("gsc_property_url") or "").strip()

    indexing_api_attempted = False
    indexing_api_ok = False
    indexing_api_error = ""

    if google_indexing.configured():
        indexing_api_attempted = True
        try:
            await google_indexing.publish_url_update(url=url)
            indexing_api_ok = True
        except Exception as e:
            indexing_api_error = f"{e}"[:460]
            log.info("Indexing API publish failed for %s: %s", url, indexing_api_error)

    # Best-effort sitemap ping — never throws, and works whether or not Indexing API is set up.
    sitemap_attempted = False
    sitemap_ok = False
    sitemap_url = default_sitemap_url(wp_site_url=(proj.get("wp_site_url") or ""))
    if sitemap_url:
        sitemap_attempted = True
        try:
            await ping_sitemap(sitemap_url=sitemap_url)
            sitemap_ok = True
        except Exception as e:
            log.info("Sitemap ping failed for %s: %s", sitemap_url, e)

    inspect_panel_url = gsc.build_inspection_panel_url(site_url=prop, inspection_url=url) if prop else ""

    if indexing_api_ok:
        new_status = "index_api_pinged"
        note = (
            "Indexing API ping sent. Note: Google's Indexing API is officially supported only for "
            "JobPosting / BroadcastEvent content; for general articles the ping is treated as a "
            "discovery hint and will NOT appear in Search Console's URL Inspection history. "
            "To get the request reflected in URL Inspection, click 'Open in Search Console' and "
            "press REQUEST INDEXING there."
        )
    elif sitemap_ok:
        new_status = "sitemap_pinged"
        note = (
            "Sitemap ping sent to Google and Bing as a discovery hint. Google does not expose a "
            "public API equivalent of the 'Request Indexing' button in URL Inspection — open the "
            "URL in Search Console and press REQUEST INDEXING to actually queue a crawl request "
            "you can see in URL Inspection."
        )
    else:
        new_status = "manual_required"
        note = (
            "No automated channel was available. Open the URL in Search Console and press "
            "REQUEST INDEXING to manually queue a crawl request."
        )

    await _mark_article(
        st=st,
        article_id=article_id,
        patch={
            "gsc_status": new_status,
            "gsc_inspection_requested_at": now_str,
            "gsc_inspection_last_attempt_at": now_str,
            "gsc_inspection_error": indexing_api_error,
            "gsc_inspection_url": url,
        },
    )

    return {
        "ok": True,
        "gsc_status": new_status,
        "indexing_api": {
            "attempted": indexing_api_attempted,
            "ok": indexing_api_ok,
            "error": indexing_api_error,
        },
        "sitemap_ping": {
            "attempted": sitemap_attempted,
            "ok": sitemap_ok,
            "sitemap_url": sitemap_url,
        },
        "inspect_panel_url": inspect_panel_url,
        "note": note,
    }


async def maybe_request_url_inspection(
    *, st, proj: dict, live_url: str, wp_status: str | None, article_id: str | None
) -> bool:
    """
    Fired automatically after a successful live publish (REST status == ``publish``).

    Honors the per-project ``gsc_index_on_publish`` toggle (default True). Delegates to
    :func:`request_url_inspection_now` so the discovery channels stay in one place.
    Returns True only when at least one channel (Indexing API or sitemap) succeeded.
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
    result = await request_url_inspection_now(st=st, proj=proj, live_url=url, article_id=article_id)
    return bool(
        (result.get("indexing_api") or {}).get("ok")
        or (result.get("sitemap_ping") or {}).get("ok")
    )


# ---------------------------------------------------------------------------
# Sitemap registration helpers (project-aware)
# ---------------------------------------------------------------------------


async def list_sitemaps_for_project(*, st, proj: dict) -> list[dict[str, Any]]:
    """List sitemaps registered against the project's linked GSC property."""
    prop = (proj.get("gsc_property_url") or "").strip()
    if not prop:
        raise RuntimeError("Search Console property is not selected for this project")
    if not gsc.oauth_configured():
        raise RuntimeError("Google OAuth client is not configured on the backend")
    at, _src = await _get_valid_access_token_for_project(st=st, proj=proj)
    return await gsc.list_sitemaps(access_token=at, site_url=prop)


async def submit_sitemap_for_project(*, st, proj: dict, sitemap_url: str) -> dict[str, Any]:
    """
    Register/re-submit ``sitemap_url`` against the project's linked property.

    Returns ``{"ok": True, "sitemap_url": "...", "submitted_at": "..."}`` on success.
    Raises ``RuntimeError`` on configuration / API errors so the route can map them
    to a 400 with a descriptive ``detail``.
    """
    prop = (proj.get("gsc_property_url") or "").strip()
    if not prop:
        raise RuntimeError("Search Console property is not selected for this project")
    if not gsc.oauth_configured():
        raise RuntimeError("Google OAuth client is not configured on the backend")
    su = (sitemap_url or "").strip()
    if not su:
        # Default to ``<wp_site_url>/sitemap.xml`` so users can submit with one click.
        su = (proj.get("wp_site_url") or "").strip().rstrip("/")
        if su:
            su = f"{su}/sitemap.xml"
    if not su:
        raise RuntimeError("Sitemap URL is required (no WordPress site URL on this project to default from)")

    at, _src = await _get_valid_access_token_for_project(st=st, proj=proj)
    await gsc.submit_sitemap(access_token=at, site_url=prop, feedpath=su)
    return {"ok": True, "sitemap_url": su, "submitted_at": _now_str()}


async def delete_sitemap_for_project(*, st, proj: dict, sitemap_url: str) -> dict[str, Any]:
    """Unregister ``sitemap_url`` from the project's linked property."""
    prop = (proj.get("gsc_property_url") or "").strip()
    if not prop:
        raise RuntimeError("Search Console property is not selected for this project")
    if not gsc.oauth_configured():
        raise RuntimeError("Google OAuth client is not configured on the backend")
    su = (sitemap_url or "").strip()
    if not su:
        raise RuntimeError("sitemap_url is required")
    at, _src = await _get_valid_access_token_for_project(st=st, proj=proj)
    await gsc.delete_sitemap(access_token=at, site_url=prop, feedpath=su)
    return {"ok": True, "sitemap_url": su}


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
