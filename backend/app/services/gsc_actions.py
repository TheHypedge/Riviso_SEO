from __future__ import annotations

import time
from datetime import datetime

from app.services import gsc
from app.services import google_indexing


async def maybe_request_url_inspection(*, st, proj: dict, live_url: str, wp_status: str | None, article_id: str | None) -> bool:
    """
    Best-effort: after a live publish, call Google Search Console URL Inspection API and
    mark `gsc_status` as 'inspected' on success.

    Note: Search Console does NOT provide a public API for "Request indexing" for general sites.
    URL Inspection returns inspection data and may help Google process the URL, but does not
    guarantee crawling/indexing.
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
    if not gsc.oauth_configured():
        return False


async def request_url_inspection_now(*, st, proj: dict, live_url: str, article_id: str | None) -> bool:
    """
    Manual trigger for URL Inspection (used by "Request Indexing" button).
    Unlike `maybe_request_url_inspection`, this does not require wp_status=publish and ignores
    the per-project toggle. It still requires:
    - Google OAuth connected for the project owner user
    - project has a selected Search Console property
    - a non-empty live_url
    """
    url = (live_url or "").strip()
    if not url:
        return False
    prop = (proj.get("gsc_property_url") or "").strip()
    if not prop:
        return False
    if not gsc.oauth_configured():
        return False

    pid_owner = (proj.get("owner_user_id") or "").strip()
    if not pid_owner or not hasattr(st, "get_user_by_id"):
        return False
    u = st.get_user_by_id(pid_owner) or {}
    rt = (u.get("gsc_refresh_token") or "").strip()
    if not rt:
        return False

    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    async def _mark(patch: dict) -> None:
        if article_id and hasattr(st, "update_article_fields"):
            st.update_article_fields(article_id, patch)

    try:
        # Prefer Google Indexing API when configured (service account).
        if google_indexing.configured():
            await _mark(
                {
                    "gsc_status": "pending",
                    "gsc_inspection_last_attempt_at": now_str,
                    "gsc_inspection_error": "",
                    "gsc_inspection_url": url,
                }
            )
            try:
                await google_indexing.publish_url_update(url=url)
                await _mark(
                    {
                        "gsc_status": "inspected",
                        "gsc_inspection_requested_at": now_str,
                        "gsc_inspection_last_attempt_at": now_str,
                        "gsc_inspection_error": "",
                        "gsc_inspection_url": url,
                    }
                )
                return True
            except Exception as e:
                # Fall back to Search Console URL Inspection below.
                await _mark(
                    {
                        "gsc_status": "pending",
                        "gsc_inspection_last_attempt_at": now_str,
                        "gsc_inspection_error": f"Indexing API failed: {str(e)[:460]}",
                        "gsc_inspection_url": url,
                    }
                )

        at = (u.get("gsc_access_token") or "").strip()
        exp_raw = (u.get("gsc_token_expires_at") or "").strip()
        try:
            exp = int(exp_raw or "0")
        except Exception:
            exp = 0
        now = int(time.time())
        if not at or not exp or (exp - now) <= 60:
            tok = await gsc.refresh_access_token(refresh_token=rt)
            at = (tok.get("access_token") or "").strip()
            expires_in = int(tok.get("expires_in") or 0)
            exp2 = int(time.time()) + max(0, expires_in)
            if at and hasattr(st, "update_user_fields"):
                st.update_user_fields(pid_owner, {"gsc_access_token": at, "gsc_token_expires_at": str(exp2)})

        await _mark(
            {
                "gsc_status": "pending",
                "gsc_inspection_last_attempt_at": now_str,
                "gsc_inspection_error": "",
                "gsc_inspection_url": url,
            }
        )

        resp = await gsc.request_url_inspection(access_token=at, site_url=prop, inspection_url=url)
        if not gsc.inspection_response_accepted(resp):
            await _mark(
                {
                    "gsc_status": "pending",
                    "gsc_inspection_last_attempt_at": now_str,
                    "gsc_inspection_error": "Inspection API returned no inspectionResult.",
                    "gsc_inspection_url": url,
                }
            )
            return False

        await _mark(
            {
                "gsc_status": "inspected",
                "gsc_inspection_requested_at": now_str,
                "gsc_inspection_last_attempt_at": now_str,
                "gsc_inspection_error": "",
                "gsc_inspection_url": url,
            }
        )
        return True
    except Exception as e:
        await _mark(
            {
                "gsc_status": "pending",
                "gsc_inspection_last_attempt_at": now_str,
                "gsc_inspection_error": str(e)[:500],
                "gsc_inspection_url": url,
            }
        )
        return False

