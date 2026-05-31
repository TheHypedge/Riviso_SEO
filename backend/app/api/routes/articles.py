"""
REST API for articles under ``/api/projects/{project_id}/articles``.

**Architecture**

- Persistence goes through :mod:`app.legacy.storage` (MongoDB for primary app data).
- Heavy OR blocking storage calls use :func:`app.services.to_thread.run_sync` so the event loop stays responsive.
- Listing/status helpers reconcile legacy ``status`` fields with WordPress REST outcomes.

**Duplicate titles**

Per-project uniqueness uses :func:`_normalize_article_title_key` (NFKC + casefold). Create, bulk-upload,
and title updates return HTTP 409 with structured JSON ``detail`` when a collision occurs.

For bulk upload, the API applies two phases:

1. **In-sheet dedupe** — same title repeated in the payload keeps the first row only.
2. **Project index** — remaining rows compared against existing articles; conflicts yield 409 unless
   ``skip_project_duplicate_conflicts`` is true (client confirms importing only non-conflicting rows).
"""

from __future__ import annotations

import time
import uuid
import base64
import unicodedata
from collections import Counter
import binascii
import html
from datetime import datetime, timedelta, timezone
import re
import asyncio
import hashlib
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form, Request
from fastapi.responses import JSONResponse, StreamingResponse
import markdown as md
from pydantic import BaseModel, Field, ValidationError
from pymongo.errors import PyMongoError

from app.core.deps import get_current_user
from app.core.project_lookup import require_project_access
from app.core.ids import user_ids_equal
from app.legacy.storage import get_legacy_storage_module
from app.services.storage_db import call_storage
from app.services.storage_http import raise_storage_http
from app.services.content_sanitizer import (
    sanitize_article_body,
    sanitize_meta_description,
    sanitize_meta_title,
)
from app.services.context_links import apply_context_links_html
from app.services.wordpress_client import WordpressClient, resolve_featured_media_id
from app.services.shopify_client import ShopifyClient
from app.services.gsc_actions import inspect_url_status, maybe_request_url_inspection, request_url_inspection_now
from app.services.sitemap_ping import default_sitemap_url, ping_sitemap
from app.services.scheduler import start_scheduled_job_preparation_task
from app.services.generation_queue import generation_slot
from app.services.to_thread import run_sync
from app.services.user_timezone import parse_schedule_input_to_utc, zoneinfo_for_user
from app.services.schedule_timing import SCHEDULE_TOO_SOON_MESSAGE, is_schedule_time_allowed
from app.services.prompt_validation import assert_writing_prompt_allowed
from app.services.article_pipeline import (
    execute_article_generation,
    execute_featured_image_regeneration,
    image_regeneration_limit_snapshot,
)
from app.services.cluster_internal_link_service import build_cluster_link_context
from app.services.async_operation_dispatch import (
    enqueue_article_generation_job,
    enqueue_image_regeneration_job,
    should_use_async_queue,
)
from app.services.pipeline_streamer import (
    MSG_HUMANIZE,
    MSG_PUBLISH_COMPLETE,
    MSG_PUBLISH_DISPATCH,
    STAGE_COMPLETE,
    STAGE_HUMANIZATION,
    STAGE_PUBLISH_DISPATCH,
    pipeline_event_stream,
    publish_pipeline_status,
)
from app.services.plan_gatekeeper import PlanAction, require_plan_action
from app.services.integrity_engine import (
    AIDetectionAuditor,
    execute_structural_humanization,
    protected_terms_from_article,
)
from app.core.article_duplicates import normalize_article_title_key as _normalize_article_title_key
from app.core.article_duplicates import sync_project_title_index as _sync_project_title_index
from app.schemas.articles import (
    ArticleListItem,
    ArticleCreate,
    ArticleBodyResponse,
    ArticleDetailResponse,
    ArticleFeaturedImageResponse,
    ArticleGenerationStatusResponse,
    ArticleListPageResponse,
    ArticlePublic,
    ArticleTitleRef,
    ArticleUpdateRequest,
    BulkActionRequest,
    BulkUploadRequest,
    BulkUploadResponse,
    BulkScheduleFailure,
    BulkScheduleRequest,
    BulkScheduleResponse,
    GenerateRequest,
    ShopifyPublishRequest,
    RegenerateImageRequest,
    ScheduleRequest,
)

router = APIRouter(prefix="/projects/{project_id}/articles", tags=["articles"])

_log = logging.getLogger(__name__)

_plans_cache_at: float = 0.0
_plans_cache_data: dict | None = None
_PLANS_CACHE_TTL_SEC = 120.0


def _load_plans_cached(st) -> dict:
    global _plans_cache_at, _plans_cache_data
    now = time.monotonic()
    if _plans_cache_data is not None and (now - _plans_cache_at) < _PLANS_CACHE_TTL_SEC:
        return _plans_cache_data
    try:
        raw = st.load_plans() or {}
        _plans_cache_data = raw if isinstance(raw, dict) else {}
    except Exception:
        _plans_cache_data = {}
    _plans_cache_at = now
    return _plans_cache_data


def _detail_image_for_response(article: dict, *, st=None) -> tuple[str | None, bool]:
    """Omit inline data URLs from the editor JSON; load them via GET .../featured-image."""
    raw = (article.get("image_url") or "").strip()
    aid = (article.get("id") or "").strip()
    has_fn = getattr(st, "article_has_stored_featured_image", None) if st is not None else None
    if callable(has_fn):
        has_stored = has_fn(article_id=aid, row=article)
    else:
        gen_at = (article.get("featured_image_generated_at") or "").strip()
        storage = (article.get("featured_image_storage") or "").strip()
        has_stored = bool(gen_at) or storage in {"file", "url", "inline"}
        if not has_stored and aid:
            file_fn = getattr(st, "featured_image_file_exists", None) if st is not None else None
            if callable(file_fn):
                has_stored = bool(file_fn(aid))
    if raw.startswith("http://") or raw.startswith("https://"):
        if len(raw) <= 500_000:
            return raw, False
        return None, True
    if raw.startswith("data:") or (raw and len(raw) > 500_000):
        return None, True
    if has_stored:
        return None, True
    return None, False


def _coerce_keywords(raw: object) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        if "," in s:
            return [p.strip() for p in s.split(",") if p.strip()]
        return [s]
    s = str(raw).strip()
    return [s] if s else []

# ---------------------------------------------------------------------------
# WordPress / listing helpers (normalize stored rows for API responses)
# ---------------------------------------------------------------------------


def _wp_post_present(a: dict) -> bool:
    link = (a.get("wp_link") or "").strip()
    if link:
        return True
    pid = a.get("wp_post_id")
    if pid is None or pid == "":
        return False
    try:
        return int(pid) > 0
    except (TypeError, ValueError):
        s = str(pid).strip().lower()
        return s not in ("", "0", "none")


def _normalize_wp_rest_status(val: object) -> str:
    if isinstance(val, str):
        return val.strip().lower()
    return str(val or "").strip().lower()


def _stored_article_status_normalized(a: dict) -> str:
    """
    Normalize Mongo `status` for comparisons. Handles non-str BSON / odd whitespace so UI matches DB.
    """
    v = a.get("status")
    if v is None:
        return "pending"
    if isinstance(v, (bytes, bytearray)):
        try:
            s = v.decode("utf-8", errors="ignore").strip()
        except Exception:
            return "pending"
    elif isinstance(v, str):
        s = v.strip()
    else:
        s = str(v).strip()
    if not s:
        return "pending"
    try:
        s = unicodedata.normalize("NFKC", s)
    except Exception:
        pass
    return s.casefold()


def _derive_listing_status(a: dict) -> str:
    """
    UI status from stored row. Prefer WordPress truth (post id / link / last REST status) over
    legacy `status` which often stayed 'pending' after successful publishes or imports.
    """
    wp_sched = (a.get("wp_scheduled_at") or "").strip()
    raw = _stored_article_status_normalized(a)
    wp_last = _normalize_wp_rest_status(a.get("wp_last_wp_status"))
    has_post = _wp_post_present(a)
    shopify_published = bool((a.get("shopify_link") or "").strip() or a.get("shopify_article_id"))

    # DB explicitly published → always show published (even if wp_link/wp_post_id missing; data can be inconsistent).
    if raw == "published" or wp_last == "publish":
        return "published"
    if shopify_published:
        return "published"
    if wp_last == "draft" and has_post:
        return "draft"
    if wp_sched:
        # Stale schedule row but post already live as publish.
        if has_post and wp_last == "publish":
            return "published"
        return "scheduled"
    if has_post and raw == "pending":
        # WP row exists but app `status` was never upgraded (older Flask paths, partial writes).
        return "draft" if wp_last == "draft" else "published"
    return raw


def _fetch_posted_job_overlay_map(st, project_id: str) -> dict[str, dict]:
    """
    For articles whose Mongo row missed wp_link/wp_post_id after a scheduled post, the scheduled_jobs
    row may still hold state=posted + link. Map article_id -> best job doc for list/detail overlay.
    """
    pid = (project_id or "").strip()
    if not pid or not hasattr(st, "load_scheduled_jobs"):
        return {}
    try:
        jobs = (
            st.load_scheduled_jobs(project_id=pid, state="posted", limit=5000)
            if hasattr(st, "load_scheduled_jobs")
            else []
        ) or []
    except Exception:
        return {}
    best: dict[str, dict] = {}
    for j in jobs:
        if not isinstance(j, dict):
            continue
        if (j.get("state") or "").strip().lower() != "posted":
            continue
        aid = (j.get("article_id") or "").strip()
        if not aid:
            continue
        cur = best.get(aid)
        if cur is None:
            best[aid] = j
            continue
        jw = (j.get("wp_link") or "").strip()
        cw = (cur.get("wp_link") or "").strip()
        if jw and not cw:
            best[aid] = j
    return best


def _fetch_posted_job_overlay_for_article_ids(
    st,
    project_id: str,
    article_ids: list[str],
) -> dict[str, dict]:
    """Overlay map for a bounded set of article ids (list page) — avoids scanning all jobs."""
    pid = (project_id or "").strip()
    aids = [(x or "").strip() for x in (article_ids or []) if (x or "").strip()]
    if not pid or not aids:
        return {}
    if hasattr(st, "load_posted_scheduled_jobs_for_articles"):
        try:
            return st.load_posted_scheduled_jobs_for_articles(pid, aids) or {}
        except Exception:
            return {}
    # Fallback: per-id lookup (still far cheaper than full-project scan for a single page).
    out: dict[str, dict] = {}
    for aid in aids:
        job = _fetch_posted_job_overlay_for_article(st, pid, aid)
        if job:
            out[aid] = job
    return out


def _fetch_posted_job_overlay_for_article(st, project_id: str, article_id: str) -> dict | None:
    """
    Return the best posted scheduled-job row for a single article.

    This avoids loading/scanning all scheduled jobs in large projects on the editor page.
    """
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    if not pid or not aid or not hasattr(st, "load_scheduled_jobs"):
        return None
    try:
        jobs = st.load_scheduled_jobs(project_id=pid, article_id=aid, state="posted", limit=25) or []
    except Exception:
        return None
    best: dict | None = None
    for j in jobs:
        if not isinstance(j, dict):
            continue
        jw = (j.get("wp_link") or "").strip()
        if best is None:
            best = j
            # Prefer a row that already has a link.
            if jw:
                break
            continue
        bw = (best.get("wp_link") or "").strip()
        if jw and not bw:
            best = j
            break
    return best


def _merge_posted_job_into_article_row(a: dict, job: dict | None) -> dict:
    """Non-persistent merge: fill missing WP fields from a posted scheduled job."""
    if not job or not isinstance(a, dict):
        return a
    m = dict(a)
    if not (m.get("wp_link") or "").strip():
        wl = (job.get("wp_link") or "").strip()
        if wl:
            m["wp_link"] = wl
    if not _wp_post_present(m):
        wpid = job.get("wp_post_id")
        if wpid is not None and str(wpid).strip() not in ("", "None", "0"):
            if isinstance(wpid, int):
                if wpid > 0:
                    m["wp_post_id"] = wpid
            elif str(wpid).strip().isdigit():
                m["wp_post_id"] = int(str(wpid).strip())
    jws = (job.get("wp_status") or "").strip().lower()
    if jws == "publish":
        if not _normalize_wp_rest_status(m.get("wp_last_wp_status")):
            m["wp_last_wp_status"] = "publish"
        if not (m.get("posted_at") or "").strip():
            ts = (job.get("updated_at") or job.get("last_attempt_at") or job.get("created_at") or "").strip()
            if ts:
                m["posted_at"] = ts
        if _stored_article_status_normalized(m) != "published":
            m["status"] = "published"
    return m


def _to_public(a: dict) -> ArticlePublic:
    wp_sched = (a.get("wp_scheduled_at") or "").strip()
    status = _derive_listing_status(a)
    posted = (a.get("posted_at") or "").strip() or None
    # If we treat the row as published but posted_at was never set, surface updated_at so the list is not blank.
    if status == "published" and not posted:
        posted = (a.get("updated_at") or "").strip() or (a.get("created_at") or "").strip() or None
    return ArticlePublic(
        id=(a.get("id") or "").strip(),
        project_id=(a.get("project_id") or "").strip(),
        title=(a.get("title") or "").strip(),
        status=status,
        created_at=(a.get("created_at") or "").strip() or None,
        updated_at=(a.get("updated_at") or "").strip() or None,
        posted_at=posted or None,
        keywords=_coerce_keywords(a.get("keywords")),
        focus_keyphrase=(a.get("focus_keyphrase") or "").strip() or None,
        wp_scheduled_at=wp_sched or None,
        wp_schedule_error=(a.get("wp_schedule_error") or "").strip() or None,
        wp_link=(a.get("wp_link") or "").strip() or None,
        wp_post_id=a.get("wp_post_id"),
        wp_rest_base=(a.get("wp_rest_base") or "").strip() or None,
        wp_last_wp_status=(a.get("wp_last_wp_status") or "").strip() or None,
        wp_modified_at=(a.get("wp_modified_at") or "").strip() or None,
        wp_synced_at=(a.get("wp_synced_at") or "").strip() or None,
        gsc_status=(a.get("gsc_status") or "").strip() or None,
        hasBody=bool(a.get("hasBody")) if "hasBody" in a else None,
        image_url=(a.get("image_url") or "").strip() or None,
        shopify_blog_id=a.get("shopify_blog_id"),
        shopify_article_id=a.get("shopify_article_id"),
        shopify_link=(a.get("shopify_link") or "").strip() or None,
    )


def _to_list_item(a: dict) -> ArticleListItem:
    """Lightweight list row — no body, meta blobs, or image URLs."""
    return ArticleListItem(
        id=(a.get("id") or "").strip(),
        project_id=(a.get("project_id") or "").strip(),
        title=(a.get("title") or "").strip(),
        status=_derive_listing_status(a),
        keywords=_coerce_keywords(a.get("keywords")),
        focus_keyphrase=(a.get("focus_keyphrase") or "").strip() or None,
        gsc_status=(a.get("gsc_status") or "").strip() or None,
        wp_link=(a.get("wp_link") or "").strip() or None,
        monitor_status=(a.get("monitor_status") or "").strip() or None,
    )


# ---------------------------------------------------------------------------
# Access control & article lookup
# ---------------------------------------------------------------------------


def _require_project_access(*, st, user: dict, project_id: str, full: bool = False) -> dict:
    return require_project_access(st=st, user=user, project_id=project_id, full=full)


def _require_verified_website(proj: dict) -> None:
    """Require a verified website connection (WordPress or Shopify) before generation/scheduling."""
    plat = (proj.get("platform") or "").strip().lower()
    if plat == "shopify" or (proj.get("shopify_shop") or "").strip() or (proj.get("shopify_access_token") or "").strip():
        shopify_ok = (proj.get("shopify_verified_status") or "").strip().lower() == "connected" and bool(
            (proj.get("shopify_verified_at") or "").strip()
        )
        if shopify_ok:
            return
        raise HTTPException(
            status_code=400,
            detail={
                "code": "website_not_connected",
                "message": "Shopify is not verified for this project. Enter your shop URL and Admin API access token, then click Verify connection in Project Settings.",
            },
        )
    status = (proj.get("wp_verified_status") or "").strip().lower()
    if status != "connected":
        raise HTTPException(
            status_code=400,
            detail={
                "code": "website_not_connected",
                "message": "Website is not connected for this project. Connect and verify WordPress in Project Settings to generate or schedule articles.",
            },
        )


def _article_image_regeneration_usage(*, st, user: dict, article: dict) -> dict:
    plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
    plans = _load_plans_cached(st)
    plan = plans.get(plan_key) if isinstance(plans, dict) else {}
    if not isinstance(plan, dict):
        plan = {}
    return image_regeneration_limit_snapshot(
        used=int(article.get("featured_image_regeneration_count") or 0),
        limit=plan.get("max_article_image_regenerations"),
    )


def _to_detail_response(
    *,
    st,
    user: dict,
    article: dict,
    view_article: dict | None = None,
    include_cluster_context: bool = False,
) -> ArticleDetailResponse:
    a_view = view_article or article
    pub = _to_public(a_view)
    regen = _article_image_regeneration_usage(st=st, user=user, article=article)
    image_url, has_featured_image = _detail_image_for_response(article, st=st)
    cluster_ctx = None
    if include_cluster_context:
        try:
            cluster_ctx = build_cluster_link_context(
                st,
                project_id=(article.get("project_id") or "").strip(),
                article_id=(article.get("id") or "").strip(),
            )
        except Exception:
            _log.debug("cluster_link_context build failed", exc_info=True)
    try:
        return ArticleDetailResponse(
            id=pub.id,
            project_id=pub.project_id,
            title=pub.title,
            status=pub.status,
            created_at=pub.created_at,
            updated_at=pub.updated_at,
            posted_at=pub.posted_at,
            keywords=pub.keywords,
            focus_keyphrase=pub.focus_keyphrase,
            wp_scheduled_at=pub.wp_scheduled_at,
            wp_schedule_error=pub.wp_schedule_error,
            wp_link=pub.wp_link,
            wp_post_id=pub.wp_post_id,
            wp_rest_base=pub.wp_rest_base,
            shopify_blog_id=pub.shopify_blog_id,
            shopify_article_id=pub.shopify_article_id,
            shopify_link=pub.shopify_link,
            gsc_status=pub.gsc_status,
            gsc_inspection_requested_at=pub.gsc_inspection_requested_at,
            gsc_inspection_last_attempt_at=pub.gsc_inspection_last_attempt_at,
            gsc_inspection_error=pub.gsc_inspection_error,
            gsc_inspection_url=pub.gsc_inspection_url,
            monitor_status=pub.monitor_status,
            monitor_last_checked_at=pub.monitor_last_checked_at,
            internal_links_count=pub.internal_links_count,
            hasBody=pub.hasBody,
            image_url=image_url,
            has_featured_image=has_featured_image,
            article=(article.get("article") or ""),
            meta_title=(article.get("meta_title") or "").strip() or None,
            meta_description=(article.get("meta_description") or "").strip() or None,
            featured_image_regeneration_count=regen["used"],
            featured_image_regeneration_limit=regen["limit"],
            featured_image_regeneration_remaining=regen["remaining"],
            featured_image_regeneration_unlimited=regen["unlimited"],
            integrity_ai_percentage=article.get("integrity_ai_percentage"),
            integrity_flagged_paragraphs=article.get("integrity_flagged_paragraphs"),
            integrity_last_audited_at=(article.get("integrity_last_audited_at") or None),
            topic_cluster_id=(article.get("topic_cluster_id") or "").strip() or None,
            topic_slot_id=(article.get("topic_slot_id") or "").strip() or None,
            topic_role=(article.get("topic_role") or "").strip() or None,
            cluster_link_context=cluster_ctx,
        )
    except ValidationError as e:
        _log.warning(
            "Article detail validation failed project=%s article=%s: %s",
            pub.project_id,
            pub.id,
            e,
        )
        raise HTTPException(status_code=500, detail="Article data could not be serialized") from e


def _get_article_or_404(*, st, project_id: str, article_id: str) -> dict:
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    if not pid or not aid:
        raise HTTPException(status_code=404, detail="Not found")
    if hasattr(st, "get_article"):
        a = st.get_article(project_id=pid, article_id=aid)
        if isinstance(a, dict):
            return a
    rows = st.load_articles() or []
    for a in rows:
        if not isinstance(a, dict):
            continue
        if (a.get("id") or "").strip() == aid and (a.get("project_id") or "").strip() == pid:
            return a
    raise HTTPException(status_code=404, detail="Not found")


def _get_article_image_regen_or_404(*, st, project_id: str, article_id: str) -> dict:
    """Article metadata for image regen without loading body or inline image bytes."""
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    if not pid or not aid:
        raise HTTPException(status_code=404, detail="Not found")
    slim_get = getattr(st, "get_article_for_image_regeneration", None)
    if callable(slim_get):
        a = slim_get(project_id=pid, article_id=aid)
        if isinstance(a, dict):
            return a
    a = _get_article_or_404(st=st, project_id=pid, article_id=aid)
    slim = {k: a.get(k) for k in (
        "id",
        "project_id",
        "title",
        "keywords",
        "focus_keyphrase",
        "featured_image_regeneration_count",
        "featured_image_generated_at",
        "featured_image_source",
        "featured_image_prompt_id",
        "shopify_mapped_products",
        "wp_mapped_pages",
    )}
    slim["has_featured_image"] = bool((a.get("image_url") or "").strip()) or bool(
        (a.get("featured_image_generated_at") or "").strip()
    )
    has_fn = getattr(st, "article_has_stored_featured_image", None)
    if callable(has_fn):
        slim["has_featured_image"] = has_fn(article_id=aid, row=a)
    return slim


# ---------------------------------------------------------------------------
# Duplicate title detection (per project, case-insensitive)
# ---------------------------------------------------------------------------
# ``_normalize_article_title_key`` / ``_sync_project_title_index`` live in
# :mod:`app.core.article_duplicates` (shared with topic-cluster generation).


def _duplicate_title_http_detail(
    *,
    submitted: str,
    existing_title: str,
    existing_id: str,
) -> dict:
    """Serializable payload for HTTP 409 responses (single-title conflict)."""
    return {
        "error": "duplicate_article_title",
        "message": "An article with this title already exists in this project. Only unique titles are allowed (comparison is not case-sensitive).",
        "duplicates": [
            {
                "submitted_title": submitted[:500],
                "existing_title": (existing_title or "")[:500],
                "existing_id": (existing_id or "").strip(),
            }
        ],
    }


# ---------------------------------------------------------------------------
# CRUD & bulk operations
# ---------------------------------------------------------------------------


_LISTING_STATUS_KEYS = frozenset({"pending", "draft", "published", "scheduled"})
_LISTING_MAX_SCAN = 20000


async def _listing_rows_page(
    st,
    project_id: str,
    *,
    page: int,
    per_page: int,
    q: str | None,
    date_from: str | None,
    date_to: str | None,
    sort: str,
) -> list[dict]:
    if hasattr(st, "load_articles_listing_page_for_project"):
        return await run_sync(
            st.load_articles_listing_page_for_project,
            project_id,
            page=page,
            per_page=per_page,
            q=q,
            date_from=date_from,
            date_to=date_to,
            sort=sort,
        )
    if hasattr(st, "load_articles_listing_for_project"):
        rows = await run_sync(st.load_articles_listing_for_project, project_id, limit=5000)
        # Legacy fallback: filter/sort/paginate in-process (small projects / JSON mode).
        qs = (q or "").strip().lower()
        df = (date_from or "").strip()
        dt = (date_to or "").strip()

        def _row_ok(a: dict) -> bool:
            if qs:
                hay = " ".join(
                    [
                        str(a.get("title") or ""),
                        str(a.get("focus_keyphrase") or ""),
                        " ".join(str(x) for x in (a.get("keywords") or [])),
                    ]
                ).lower()
                if qs not in hay:
                    return False
            ca = str(a.get("created_at") or "")
            if df and ca < (df if len(df) > 10 else f"{df} 00:00:00"):
                return False
            if dt:
                try:
                    d0 = datetime.strptime(dt[:10], "%Y-%m-%d")
                    end = (d0 + timedelta(days=1)).strftime("%Y-%m-%d") + " 00:00:00"
                    if ca >= end:
                        return False
                except Exception:
                    pass
            return True

        filtered = [a for a in (rows or []) if isinstance(a, dict) and _row_ok(a)]
        filtered.sort(key=lambda x: str(x.get("created_at") or ""), reverse=(sort or "desc").lower() != "asc")
        skip = (max(1, page) - 1) * per_page
        return filtered[skip : skip + per_page]
    all_rows = await run_sync(st.load_articles)
    rows = [a for a in (all_rows or []) if isinstance(a, dict) and (a.get("project_id") or "") == project_id]
    return rows[:per_page]


async def _public_listing_items_for_rows(st, project_id: str, rows: list[dict]) -> list[ArticleListItem]:
    ids = [(a.get("id") or "").strip() for a in rows if isinstance(a, dict) and (a.get("id") or "").strip()]
    posted_jobs = await run_sync(_fetch_posted_job_overlay_for_article_ids, st, project_id, ids)
    return [
        _to_list_item(_merge_posted_job_into_article_row(a, posted_jobs.get((a.get("id") or "").strip())))
        for a in rows
        if isinstance(a, dict)
    ]


async def _count_listing_with_derived_status(
    st,
    project_id: str,
    *,
    status_key: str,
    q: str | None,
    date_from: str | None,
    date_to: str | None,
    sort: str,
) -> int:
    """Count rows matching mongo pre-filters and derived listing status (bounded scan)."""
    batch_size = 200
    mongo_page = 1
    scanned = 0
    total = 0
    while scanned < _LISTING_MAX_SCAN:
        rows = await _listing_rows_page(
            st,
            project_id,
            page=mongo_page,
            per_page=batch_size,
            q=q,
            date_from=date_from,
            date_to=date_to,
            sort=sort,
        )
        if not rows:
            break
        items = await _public_listing_items_for_rows(st, project_id, rows)
        for it in items:
            if (it.status or "").strip().lower() == status_key:
                total += 1
        scanned += len(rows)
        if len(rows) < batch_size:
            break
        mongo_page += 1
    return total


async def _listing_page_with_derived_status(
    st,
    project_id: str,
    *,
    page: int,
    per_page: int,
    status_key: str,
    q: str | None,
    date_from: str | None,
    date_to: str | None,
    sort: str,
) -> list[ArticleListItem]:
    """Fill one UI page when status is derived (not a raw Mongo field)."""
    need = per_page
    skip = (max(1, page) - 1) * per_page
    collected: list[ArticleListItem] = []
    mongo_page = 1
    batch_size = max(per_page * 3, 50)
    scanned = 0
    while len(collected) < skip + need and scanned < _LISTING_MAX_SCAN:
        rows = await _listing_rows_page(
            st,
            project_id,
            page=mongo_page,
            per_page=batch_size,
            q=q,
            date_from=date_from,
            date_to=date_to,
            sort=sort,
        )
        if not rows:
            break
        items = await _public_listing_items_for_rows(st, project_id, rows)
        for it in items:
            if (it.status or "").strip().lower() != status_key:
                continue
            collected.append(it)
        scanned += len(rows)
        if len(rows) < batch_size:
            break
        mongo_page += 1
    return collected[skip : skip + need]


@router.get("/titles", response_model=list[ArticleTitleRef])
async def list_article_titles(project_id: str, user: dict = Depends(get_current_user)) -> list[ArticleTitleRef]:
    """Lightweight id/title list for scheduled jobs and import reconciliation."""
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    if hasattr(st, "load_article_titles_for_project"):
        rows = await run_sync(st.load_article_titles_for_project, project_id, limit=20000)
    elif hasattr(st, "load_articles_listing_for_project"):
        rows = await run_sync(st.load_articles_listing_for_project, project_id, limit=20000)
        rows = [{"id": (r.get("id") or "").strip(), "title": (r.get("title") or "").strip()} for r in rows if isinstance(r, dict)]
    else:
        all_rows = await run_sync(st.load_articles)
        rows = [
            {"id": (a.get("id") or "").strip(), "title": (a.get("title") or "").strip()}
            for a in (all_rows or [])
            if isinstance(a, dict) and (a.get("project_id") or "").strip() == project_id
        ]
    return [ArticleTitleRef(id=(r.get("id") or "").strip(), title=(r.get("title") or "").strip()) for r in rows if (r.get("id") or "").strip()]


@router.get("", response_model=ArticleListPageResponse)
async def list_articles(
    project_id: str,
    user: dict = Depends(get_current_user),
    page: int = Query(1, ge=1),
    per_page: int = Query(10, ge=1, le=100),
    q: str | None = Query(None, max_length=200),
    status: str | None = Query(None, max_length=32),
    date_from: str | None = Query(None, max_length=32),
    date_to: str | None = Query(None, max_length=32),
    sort: str = Query("desc", pattern="^(asc|desc)$"),
) -> ArticleListPageResponse:
    """
    Paginated article list for the project UI.

    Applies Mongo filters for text and created_at range, derives listing status in Python,
    and merges posted scheduled-job overlays only for rows on the current page.
    """
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    status_key = (status or "").strip().lower()
    if status_key and status_key not in _LISTING_STATUS_KEYS:
        status_key = ""

    if status_key:
        total = await _count_listing_with_derived_status(
            st,
            project_id,
            status_key=status_key,
            q=q,
            date_from=date_from,
            date_to=date_to,
            sort=sort,
        )
        items = await _listing_page_with_derived_status(
            st,
            project_id,
            page=page,
            per_page=per_page,
            status_key=status_key,
            q=q,
            date_from=date_from,
            date_to=date_to,
            sort=sort,
        )
    else:
        if hasattr(st, "count_articles_listing_for_project"):
            total = await run_sync(
                st.count_articles_listing_for_project,
                project_id,
                q=q,
                date_from=date_from,
                date_to=date_to,
            )
        else:
            total = len(
                await _listing_rows_page(
                    st,
                    project_id,
                    page=1,
                    per_page=5000,
                    q=q,
                    date_from=date_from,
                    date_to=date_to,
                    sort=sort,
                )
            )
        rows = await _listing_rows_page(
            st,
            project_id,
            page=page,
            per_page=per_page,
            q=q,
            date_from=date_from,
            date_to=date_to,
            sort=sort,
        )
        items = await _public_listing_items_for_rows(st, project_id, rows)

    return ArticleListPageResponse(items=items, total=int(total), page=page, per_page=per_page)


@router.post("/export/consume", status_code=200)
async def consume_export_quota(
    project_id: str,
    user: dict = Depends(require_plan_action(PlanAction.BULK_EXPORT, consume=False)),
) -> dict:
    """
    Consume an export allowance for the user's current plan.

    The frontend calls this before running the client-side export. This provides plan enforcement
    even though the XLSX is generated in the browser.
    """
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role == "admin" or not uid:
        return {"ok": True}

    plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
    plan = {}
    try:
        plans = st.load_plans() or {}
        plan = plans.get(plan_key) if isinstance(plans, dict) else {}
        if not isinstance(plan, dict):
            plan = {}
    except Exception:
        plan = {}

    if plan.get("allow_export") is False:
        raise HTTPException(status_code=403, detail="Export Articles is not enabled for your plan.")

    if hasattr(st, "consume_export_usage"):
        ok, msg = st.consume_export_usage(uid, month_limit=plan.get("max_export_per_month"), amount=1)
        if not ok:
            raise HTTPException(status_code=403, detail=msg or "Export limit reached for your plan")
    return {"ok": True}


@router.post("", response_model=ArticlePublic, status_code=201)
async def create_article(
    project_id: str,
    payload: ArticleCreate,
    user: dict = Depends(get_current_user),
) -> ArticlePublic:
    """
    Create a single pending article. Rejects with 409 if the title matches an existing article
    in the same project (case-insensitive; see module docstring).
    """
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)

    if len(payload.keywords) > 10:
        raise HTTPException(status_code=400, detail="Maximum 10 keywords allowed")
    keywords = [str(k).strip()[:80] for k in payload.keywords if str(k).strip()]
    keywords = keywords[:10]

    title_clean = payload.title.strip()[:500]
    tkey = _normalize_article_title_key(title_clean)
    if tkey:
        idx = await run_sync(_sync_project_title_index, st, project_id)
        hit = idx.get(tkey)
        if hit:
            etitle, eid = hit
            raise HTTPException(
                status_code=409,
                detail=_duplicate_title_http_detail(
                    submitted=title_clean,
                    existing_title=etitle,
                    existing_id=eid,
                ),
            )

    aid = str(uuid.uuid4())
    try:
        await run_sync(
            st.insert_article,
            {
                "id": aid,
                "project_id": project_id,
                "title": title_clean,
                "keywords": keywords,
                "status": "pending",
                "article": "",
                "focus_keyphrase": (payload.focus_keyphrase or "").strip()[:500],
                "meta_title": "",
                "meta_description": "",
                "generated_at": "",
                "posted_at": "",
                "created_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                "gsc_status": "pending",
            },
        )
    except PyMongoError as e:
        from app.services.storage_http import raise_storage_http

        raise_storage_http(e)

    # Return minimal created row.
    return ArticlePublic(
        id=aid,
        project_id=project_id,
        title=title_clean,
        status="pending",
        created_at=datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        keywords=keywords,
        focus_keyphrase=(payload.focus_keyphrase or "").strip() or None,
    )


@router.post("/bulk", status_code=200)
async def bulk_action(
    project_id: str,
    payload: BulkActionRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    """Bulk delete or status change; ``article_ids`` are validated against this project only."""
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)

    pid = (project_id or "").strip()
    ids = [str(x).strip() for x in (payload.article_ids or []) if str(x).strip()]
    ids = list(dict.fromkeys(ids))[:500]
    if not ids:
        raise HTTPException(status_code=400, detail="No articles selected")

    # Ensure ids belong to this project to avoid cross-project updates.
    allowed = set()
    if hasattr(st, "load_articles_listing_for_project"):
        rows = await run_sync(st.load_articles_listing_for_project, pid, limit=20000)
    else:
        rows = await run_sync(st.load_articles)
    for a in rows:
        if isinstance(a, dict) and (a.get("project_id") or "") == pid:
            aid = (a.get("id") or "").strip()
            if aid:
                allowed.add(aid)
    ids = [x for x in ids if x in allowed]
    if not ids:
        return {"ok": True, "updated": 0}

    if payload.action == "delete":
        await run_sync(st.delete_articles_by_ids, ids)
        return {"ok": True, "deleted": len(ids)}

    if payload.action == "change_status":
        ns = (payload.new_status or "").strip().lower()
        if ns not in {"pending", "draft", "published"}:
            raise HTTPException(status_code=400, detail="Invalid new_status")
        updates = [(aid, {"status": ns}) for aid in ids]
        if hasattr(st, "bulk_update_articles"):
            await run_sync(st.bulk_update_articles, updates)
        else:
            for aid, u in updates:
                await run_sync(st.update_article_fields, aid, u)
        return {"ok": True, "updated": len(ids), "new_status": ns}

    raise HTTPException(status_code=400, detail="Unknown action")


def _dedupe_bulk_upload_rows(rows: list) -> tuple[list, list[str], int]:
    """
    Collapse duplicate titles **within the uploaded payload** (same normalization as DB checks).

    For duplicate titles (case-insensitive), keep only the first row (top of file = oldest).

    Returns (deduped_rows, sorted_duplicate_display_titles, extra_rows_dropped).
    """
    norm_rows: list[tuple[str, str, object]] = []
    for row in rows or []:
        title = (getattr(row, "title", None) or "").strip()
        if not title:
            continue
        key = _normalize_article_title_key(title)
        if not key:
            continue
        norm_rows.append((key, title, row))

    counts = Counter(k for k, _, _ in norm_rows)
    seen: set[str] = set()
    deduped: list = []
    first_display: dict[str, str] = {}
    for key, display, row in norm_rows:
        if key not in first_display:
            first_display[key] = display
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)

    duplicate_titles = sorted(first_display[k] for k, c in counts.items() if c > 1)
    dropped = sum(max(0, c - 1) for c in counts.values())
    return deduped, duplicate_titles, dropped


@router.post("/bulk-upload", response_model=BulkUploadResponse, status_code=200)
async def bulk_upload_articles(
    project_id: str,
    payload: BulkUploadRequest,
    user: dict = Depends(require_plan_action(PlanAction.BULK_UPLOAD, consume=False)),
) -> BulkUploadResponse:
    """
    Import many articles from a parsed Excel flow. In-sheet dedupe first, then project index.

    If any row's title collides with an existing article and ``skip_project_duplicate_conflicts`` is
    false, the handler returns **409** without writing rows so the client can confirm skipping conflicts.
    """
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)

    rows_in = list(payload.rows or [])
    rows_work, duplicate_titles, duplicate_dropped = _dedupe_bulk_upload_rows(rows_in)

    title_index = await run_sync(_sync_project_title_index, st, project_id)
    project_conflicts: list[dict[str, str]] = []
    rows_to_insert: list = []
    for row in rows_work:
        title = (getattr(row, "title", None) or "").strip()
        if not title:
            continue
        tkey = _normalize_article_title_key(title)
        if not tkey:
            continue
        if tkey in title_index:
            ex_title, ex_id = title_index[tkey]
            project_conflicts.append(
                {
                    "submitted_title": title[:500],
                    "existing_title": (ex_title or "")[:500],
                    "existing_id": (ex_id or "").strip(),
                }
            )
        else:
            rows_to_insert.append(row)

    if project_conflicts and not payload.skip_project_duplicate_conflicts:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "duplicate_article_titles",
                "message": "One or more article titles already exist in this project. Only unique titles can be added (comparison is not case-sensitive).",
                "project_duplicates": project_conflicts,
                "in_file_duplicate_titles": duplicate_titles,
                "would_create_count": len(rows_to_insert),
                "project_conflict_count": len(project_conflicts),
            },
        )

    created_rows: list[ArticlePublic] = []
    skipped = duplicate_dropped
    for row in rows_in:
        if not (getattr(row, "title", None) or "").strip():
            skipped += 1
    if project_conflicts and payload.skip_project_duplicate_conflicts:
        skipped += len(project_conflicts)
    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    for row in rows_to_insert:
        title = (row.title or "").strip()
        if not title:
            skipped += 1
            continue

        kws_in = [str(k).strip() for k in (row.keywords or []) if str(k).strip()]
        seen = set()
        keywords: list[str] = []
        for k in kws_in:
            key = k.lower()
            if key in seen:
                continue
            seen.add(key)
            keywords.append(k[:80])
            if len(keywords) >= 10:
                break

        status = "pending"

        aid = str(uuid.uuid4())
        await run_sync(
            st.insert_article,
            {
                "id": aid,
                "project_id": project_id,
                "title": title[:500],
                "keywords": keywords,
                "status": status,
                "article": "",
                "focus_keyphrase": (row.focus_keyphrase or "").strip()[:500],
                "meta_title": "",
                "meta_description": "",
                "generated_at": "",
                "posted_at": "",
                "created_at": now_str,
                "gsc_status": "pending",
            },
        )

        created_rows.append(
            ArticlePublic(
                id=aid,
                project_id=project_id,
                title=title[:500],
                status=status,
                created_at=now_str,
                keywords=keywords,
                focus_keyphrase=(row.focus_keyphrase or "").strip() or None,
            )
        )

    return BulkUploadResponse(
        created=len(created_rows),
        skipped=skipped,
        articles=created_rows,
        duplicate_titles=duplicate_titles,
        duplicate_rows_dropped=duplicate_dropped,
        project_skipped_as_duplicates=len(project_conflicts) if payload.skip_project_duplicate_conflicts else 0,
    )


def _get_article_shell_or_404(*, st, project_id: str, article_id: str) -> dict:
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    if not pid or not aid:
        raise HTTPException(status_code=404, detail="Not found")
    if hasattr(st, "get_article_editor_shell"):
        a = st.get_article_editor_shell(project_id=pid, article_id=aid)
    else:
        a = st.get_article(project_id=pid, article_id=aid) if hasattr(st, "get_article") else None
        if isinstance(a, dict):
            a = dict(a)
            a["article"] = ""
            a["image_url"] = ""
    if not a:
        raise HTTPException(status_code=404, detail="Not found")
    return a


@router.get("/{article_id}/editor-shell", response_model=ArticleDetailResponse)
async def get_article_editor_shell(
    project_id: str,
    article_id: str,
    user: dict = Depends(get_current_user),
) -> ArticleDetailResponse:
    """Editor metadata without body or inline image — fast first paint."""
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    aid = (article_id or "").strip()
    try:
        a = await run_sync(
            call_storage,
            _get_article_shell_or_404,
            st=st,
            project_id=project_id,
            article_id=article_id,
        )
        job = None
        try:
            job = await run_sync(call_storage, _fetch_posted_job_overlay_for_article, st, project_id, aid)
        except Exception:
            # Overlay is optional for editor paint; do not block shell on scheduler/mongo blips.
            job = None
        a_view = _merge_posted_job_into_article_row(a, job)
        return await run_sync(
            _to_detail_response,
            st=st,
            user=user,
            article=a,
            view_article=a_view,
            include_cluster_context=False,
        )
    except HTTPException:
        raise
    except ValidationError as e:
        _log.warning("get_article_editor_shell validation failed project=%s article=%s: %s", project_id, aid, e)
        raise HTTPException(status_code=500, detail="Article data could not be serialized") from e
    except Exception as e:
        try:
            raise_storage_http(e)
        except HTTPException:
            raise
        _log.exception("get_article_editor_shell failed project=%s article=%s", project_id, aid)
        raise HTTPException(status_code=500, detail="Could not load article") from e


@router.get("/{article_id}/body", response_model=ArticleBodyResponse)
async def get_article_body(
    project_id: str,
    article_id: str,
    user: dict = Depends(get_current_user),
) -> ArticleBodyResponse:
    """Article body only — loaded after editor shell."""
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    try:
        if hasattr(st, "get_article_body_text"):
            text = await run_sync(call_storage, st.get_article_body_text, project_id=pid, article_id=aid)
        else:
            a = await run_sync(call_storage, _get_article_or_404, st=st, project_id=project_id, article_id=article_id)
            text = (a.get("article") or "") if isinstance(a, dict) else ""
        if text is None:
            raise HTTPException(status_code=404, detail="Not found")
        return ArticleBodyResponse(article=text or "")
    except HTTPException:
        raise
    except Exception as e:
        try:
            raise_storage_http(e)
        except HTTPException:
            raise
        raise HTTPException(status_code=500, detail="Could not load article body") from e


@router.get("/{article_id}", response_model=ArticleDetailResponse)
async def get_article_detail(
    project_id: str,
    article_id: str,
    user: dict = Depends(get_current_user),
) -> ArticleDetailResponse:
    """Full article body and meta for the editor UI."""
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    aid = (article_id or "").strip()

    try:
        a, job = await asyncio.gather(
            run_sync(
                call_storage,
                _get_article_or_404,
                st=st,
                project_id=project_id,
                article_id=article_id,
            ),
            run_sync(call_storage, _fetch_posted_job_overlay_for_article, st, project_id, aid),
        )
        a_view = _merge_posted_job_into_article_row(a, job)
        include_cluster = bool((a.get("topic_cluster_id") or "").strip())
        return await run_sync(
            _to_detail_response,
            st=st,
            user=user,
            article=a,
            view_article=a_view,
            include_cluster_context=include_cluster,
        )
        raise HTTPException(status_code=500, detail="Article data could not be serialized") from e
    except Exception as e:
        try:
            raise_storage_http(e)
        except HTTPException:
            raise
        _log.exception(
            "get_article_detail failed project=%s article=%s",
            project_id,
            aid,
        )
        raise HTTPException(status_code=500, detail="Could not load article") from e


@router.get("/{article_id}/featured-image", response_model=ArticleFeaturedImageResponse)
async def get_article_featured_image(
    project_id: str,
    article_id: str,
    user: dict = Depends(get_current_user),
) -> ArticleFeaturedImageResponse:
    """Return large inline featured images separately so the main editor payload stays small."""
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    try:
        if hasattr(st, "get_article_image_url"):
            raw = await run_sync(call_storage, st.get_article_image_url, project_id=pid, article_id=aid)
        else:
            a = await run_sync(call_storage, _get_article_or_404, st=st, project_id=pid, article_id=aid)
            raw = (a.get("image_url") or "").strip() or None
    except HTTPException:
        raise
    except Exception as e:
        raise_storage_http(e)
    if not raw:
        raise HTTPException(status_code=404, detail="No featured image for this article")
    return ArticleFeaturedImageResponse(image_url=raw)


@router.get("/{article_id}/generation-status", response_model=ArticleGenerationStatusResponse)
async def get_article_generation_status(
    project_id: str,
    article_id: str,
    user: dict = Depends(get_current_user),
) -> ArticleGenerationStatusResponse:
    """Lightweight poll target for async content/image generation (no body or image payload)."""
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    try:
        if hasattr(st, "get_article_generation_status"):
            row = await run_sync(call_storage, st.get_article_generation_status, project_id=pid, article_id=aid)
        else:
            a = await run_sync(call_storage, _get_article_or_404, st=st, project_id=pid, article_id=aid)
            row = {
                "id": aid,
                "status": (a.get("status") or "pending")[:32],
                "generated_at": (a.get("generated_at") or "")[:64] or None,
                "has_body": bool((a.get("article") or "").strip()),
                "has_featured_image": bool((a.get("image_url") or "").strip())
                or bool((a.get("featured_image_generated_at") or "").strip()),
                "featured_image_regeneration_count": int(a.get("featured_image_regeneration_count") or 0),
            }
    except HTTPException:
        raise
    except Exception as e:
        raise_storage_http(e)
    if not isinstance(row, dict):
        raise HTTPException(status_code=404, detail="Not found")
    return ArticleGenerationStatusResponse(
        id=(row.get("id") or aid).strip(),
        status=(row.get("status") or "pending")[:32],
        generated_at=(row.get("generated_at") or None),
        has_body=bool(row.get("has_body")),
        has_featured_image=bool(row.get("has_featured_image")),
        featured_image_regeneration_count=int(row.get("featured_image_regeneration_count") or 0),
    )


@router.get("/{article_id}/cluster-link-context")
async def get_article_cluster_link_context(
    project_id: str,
    article_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """Sibling internal-link targets — loaded on demand, not on every editor shell fetch."""
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    aid = (article_id or "").strip()
    try:
        ctx = await run_sync(
            call_storage,
            build_cluster_link_context,
            st,
            project_id=(project_id or "").strip(),
            article_id=aid,
        )
    except Exception as e:
        raise_storage_http(e)
    if not ctx:
        return {"cluster_link_context": None}
    return {"cluster_link_context": ctx}


@router.patch("/{article_id}", response_model=ArticleDetailResponse)
async def update_article(
    project_id: str,
    article_id: str,
    payload: ArticleUpdateRequest,
    user: dict = Depends(get_current_user),
) -> ArticleDetailResponse:
    """Partial update; changing ``title`` runs the same duplicate check as create (409 on conflict)."""
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    _ = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)
    aid_now = (article_id or "").strip()

    updates: dict = {}
    if payload.title is not None:
        new_title = payload.title.strip()[:500]
        tkey = _normalize_article_title_key(new_title)
        if tkey:
            idx = await run_sync(_sync_project_title_index, st, project_id)
            hit = idx.get(tkey)
            if hit:
                _etitle, eid = hit
                if (eid or "").strip() != aid_now:
                    raise HTTPException(
                        status_code=409,
                        detail=_duplicate_title_http_detail(
                            submitted=new_title,
                            existing_title=_etitle,
                            existing_id=eid,
                        ),
                    )
        updates["title"] = new_title
    if payload.keywords is not None:
        kw = [str(x).strip()[:80] for x in (payload.keywords or []) if str(x).strip()]
        updates["keywords"] = kw[:10]
    if payload.focus_keyphrase is not None:
        updates["focus_keyphrase"] = (payload.focus_keyphrase or "").strip()[:500]
    if payload.article is not None:
        updates["article"] = sanitize_article_body(payload.article)
    if payload.meta_title is not None:
        updates["meta_title"] = sanitize_meta_title(payload.meta_title, max_len=400)
    if payload.meta_description is not None:
        updates["meta_description"] = sanitize_meta_description(payload.meta_description, max_len=600)

    if updates:
        await run_sync(st.update_article_fields, article_id, updates)

    a2 = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)
    return _to_detail_response(st=st, user=user, article=a2)


# ---------------------------------------------------------------------------
# Generation, scheduling, publishing, GSC (downstream of CRUD)
# ---------------------------------------------------------------------------


@router.post("/{article_id}/generate", response_model=None)
async def generate_article_and_image(
    project_id: str,
    article_id: str,
    payload: GenerateRequest,
    user: dict = Depends(require_plan_action(PlanAction.GENERATE_CONTENT, consume=False)),
) -> dict | JSONResponse:
    """
    Generate article HTML and optional featured image (OpenAI), then persist to storage.

    Requires ``OPENAI_API_KEY``; uses project prompts and article row fields as context.
    """
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id, full=True)
    _require_verified_website(proj)
    row = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)
    wp_id = (payload.writing_prompt_id or "").strip() or (proj.get("default_prompt_id") or "").strip() or None
    ip_id = (payload.image_prompt_id or "").strip() or (proj.get("default_image_prompt_id") or "").strip() or None
    mapped_products_payload: list[dict] | None = None
    if payload.mapped_products is not None:
        mapped_products_payload = [p.model_dump() for p in payload.mapped_products]
    mapped_pages_payload: list[dict] | None = None
    if payload.mapped_pages is not None:
        mapped_pages_payload = [p.model_dump() for p in payload.mapped_pages]

    aid = (article_id or "").strip()
    gen_payload = {
        "writing_prompt_id": wp_id,
        "image_prompt_id": ip_id,
        "generate_image": bool(payload.generate_image),
        "focus_keyphrase": payload.focus_keyphrase,
        "mapped_products": mapped_products_payload,
        "mapped_pages": mapped_pages_payload,
    }

    if should_use_async_queue():
        job_id = enqueue_article_generation_job(
            project_id=project_id,
            article_id=aid,
            user_id=(user.get("id") or "").strip(),
            payload=gen_payload,
        )
        await publish_pipeline_status(
            aid,
            "📋 Generation job queued — waiting for background worker...",
            "queued",
        )
        return JSONResponse(
            status_code=202,
            content={
                "status": "queued",
                "job_id": job_id,
                "article_id": aid,
                "message": "Article generation queued.",
            },
        )

    async with generation_slot():
        return await execute_article_generation(
            st=st,
            user=user,
            proj=proj,
            project_id=project_id,
            article_id=aid,
            row=row,
            writing_prompt_id=wp_id,
            image_prompt_id=ip_id,
            generate_image=bool(payload.generate_image),
            focus_keyphrase_override=payload.focus_keyphrase,
            mapped_products=mapped_products_payload,
            mapped_pages=mapped_pages_payload,
        )


@router.get("/{article_id}/events")
async def article_pipeline_events(
    project_id: str,
    article_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
) -> StreamingResponse:
    """
    Server-Sent Events stream of live pipeline log lines for this article
    (generation, humanization, publishing). Requires Redis pub/sub.
    """
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)

    async def event_generator():
        try:
            async for chunk in pipeline_event_stream(article_id, request=request):
                yield chunk
        except asyncio.CancelledError:
            raise

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{article_id}/regenerate-image", response_model=None)
async def regenerate_article_featured_image(
    project_id: str,
    article_id: str,
    payload: RegenerateImageRequest,
    user: dict = Depends(get_current_user),
) -> dict | JSONResponse:
    """Regenerate only the article featured image, capped per article by the user's plan."""
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id, full=True)
    aid = (article_id or "").strip()
    try:
        row = await run_sync(
            call_storage,
            _get_article_image_regen_or_404,
            st=st,
            project_id=project_id,
            article_id=aid,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise_storage_http(e)
    custom_prompt = (payload.custom_image_prompt or "").strip() or None
    if custom_prompt and len(custom_prompt) < 10:
        raise HTTPException(status_code=400, detail="Custom image prompt must be at least 10 characters.")
    ip_id = None if custom_prompt else (payload.image_prompt_id or "").strip() or (proj.get("default_image_prompt_id") or "").strip() or None

    regen_payload = {
        "image_prompt_id": ip_id,
        "custom_image_prompt": custom_prompt,
    }
    if should_use_async_queue():
        job_id = enqueue_image_regeneration_job(
            project_id=project_id,
            article_id=aid,
            user_id=(user.get("id") or "").strip(),
            payload=regen_payload,
        )
        return JSONResponse(
            status_code=202,
            content={
                "status": "queued",
                "job_id": job_id,
                "article_id": aid,
                "message": "Featured image regeneration queued.",
            },
        )

    try:
        async with generation_slot():
            return await execute_featured_image_regeneration(
                st=st,
                user=user,
                proj=proj,
                article_id=aid,
                row=row,
                image_prompt_id=ip_id,
                custom_image_prompt=custom_prompt,
            )
    except HTTPException:
        raise
    except Exception as e:
        raise_storage_http(e)


class IntegrityMarkdownBody(BaseModel):
    markdown: str | None = Field(default=None, max_length=500_000)


@router.post("/{article_id}/integrity/audit", status_code=200)
async def audit_article_integrity(
    project_id: str,
    article_id: str,
    payload: IntegrityMarkdownBody | None = None,
    user: dict = Depends(require_plan_action(PlanAction.HUMANIZE, consume=False)),
) -> dict:
    """
    Integrity audit (fast heuristics): flags templated / overly-uniform paragraphs.
    Returns: { ai_percentage, flagged_paragraphs: [{index,text,reason}], metrics }
    """
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    a = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)
    md_body = ((payload.markdown if payload and payload.markdown else None) or a.get("article") or "").strip()
    auditor = AIDetectionAuditor()
    payload = auditor.audit_markdown(md_body)
    try:
        persist = getattr(st, "patch_article_fields", None) or st.update_article_fields
        await run_sync(
            persist,
            (article_id or "").strip(),
            {
                "integrity_ai_percentage": payload.get("ai_percentage"),
                "integrity_flagged_paragraphs": payload.get("flagged_paragraphs"),
                "integrity_last_audited_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
            },
        )
    except Exception:
        pass
    return payload


@router.post("/{article_id}/integrity/humanize", status_code=200)
async def humanize_article_integrity(
    project_id: str,
    article_id: str,
    payload: IntegrityMarkdownBody | None = None,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Full-document structural humanization (industry-neutral). Does not persist until the user saves/applies in the editor.
    Returns original + humanized + before/after audit for UI.
    """
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    a = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)
    md_body = ((payload.markdown if payload and payload.markdown else None) or a.get("article") or "").strip()
    await publish_pipeline_status(article_id, MSG_HUMANIZE, STAGE_HUMANIZATION)
    auditor = AIDetectionAuditor()
    audit_before = auditor.audit_markdown(md_body)
    res = await execute_structural_humanization(
        md=md_body,
        protected_terms=protected_terms_from_article(a),
        full_document=True,
        max_passes=5,
    )
    human_md = (res.get("humanized_markdown") or "").strip()
    audit_after = auditor.audit_markdown(human_md or md_body)
    await publish_pipeline_status(
        article_id,
        "✨ Structural humanization pass complete.",
        STAGE_COMPLETE,
    )
    return {
        "ok": True,
        "original_markdown": md_body,
        "humanized_markdown": human_md or md_body,
        "rewritten": res.get("rewritten") or [],
        "before": audit_before,
        "after": audit_after,
    }


def _validate_bulk_schedule_cadence(*, cadence: str | None, parsed: list[tuple[str, str, datetime]]) -> None:
    """Reject weekly/monthly bulk payloads squeezed into same-day minute gaps."""
    cadence_norm = (cadence or "").strip().lower()
    if cadence_norm not in {"weekly", "monthly"} or len(parsed) < 2:
        return
    times = sorted(dt for _, _, dt in parsed)
    if cadence_norm == "weekly":
        min_gap = timedelta(hours=12)
        detail = (
            "Weekly bulk schedule times are too close together. "
            "In the schedule dialog, set Articles per week to 1 or add more posting days."
        )
    else:
        min_gap = timedelta(days=5)
        detail = (
            "Monthly bulk schedule times are too close together. "
            "Set Total monthly articles to 1 or add more posting days."
        )
    for i in range(1, len(times)):
        if times[i] - times[i - 1] < min_gap:
            raise HTTPException(status_code=400, detail=detail)


def _parse_schedule_time_utc(*, raw: str, user: dict) -> datetime:
    s = (raw or "").strip()
    if not s:
        raise HTTPException(status_code=400, detail="Missing schedule time")
    try:
        user_tz = zoneinfo_for_user(user.get("timezone"))
        return parse_schedule_input_to_utc(s, user_tz=user_tz)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e) or "Invalid schedule time format") from None
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid schedule time format") from None


def _user_schedule_plan(st, user: dict) -> tuple[str, str, dict]:
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
    plan: dict = {}
    if role != "admin" and uid:
        try:
            plans = st.load_plans() or {}
            plan = plans.get(plan_key) if isinstance(plans, dict) else {}
            if not isinstance(plan, dict):
                plan = {}
        except Exception:
            plan = {}
    return uid, role, plan


async def _persist_schedule_row(
    *,
    st,
    project_id: str,
    article_id: str,
    article: dict,
    proj: dict,
    norm_utc: str,
    wp_status: str,
    post_type: str,
    writing_prompt_id: str,
    image_prompt_id: str,
    generate_image: bool,
    enqueue_preparation: bool = True,
    skip_article_update: bool = False,
) -> dict:
    """Write article + scheduled-job rows; optionally queue background prep (non-blocking)."""
    cat_raw = (proj.get("wp_category_ids") or "").strip()
    if not skip_article_update:
        await run_sync(
            st.update_article_fields,
            article_id,
            {
                "wp_scheduled_at": norm_utc,
                "wp_schedule_wp_status": wp_status,
                "wp_rest_base": post_type,
                "wp_schedule_error": "",
                "status": (article.get("status") or "pending"),
            },
        )

    job_row: dict | None = None
    if hasattr(st, "insert_scheduled_job") and hasattr(st, "update_scheduled_job_fields"):
        stable = hashlib.sha1(f"{project_id}:{article_id}".encode("utf-8")).hexdigest()[:20]
        job_id = f"job_{stable}"
        if hasattr(st, "load_scheduled_jobs"):
            try:
                for row in st.load_scheduled_jobs(project_id=project_id, article_id=article_id, limit=10) or []:
                    if not isinstance(row, dict):
                        continue
                    st_row = (row.get("state") or "").strip().lower()
                    if st_row == "cancelled":
                        continue
                    jid = (row.get("id") or "").strip()
                    if jid:
                        job_id = jid
                        break
            except Exception:
                pass
        now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        job_updates = {
            "id": job_id,
            "project_id": project_id,
            "article_id": article_id,
            "run_at": norm_utc,
            "post_type": post_type,
            "wp_status": wp_status,
            "category_ids": cat_raw,
            "writing_prompt_id": writing_prompt_id,
            "image_prompt_id": image_prompt_id,
            "generate_image": generate_image,
            "state": "scheduled",
            "attempts": 0,
            "last_attempt_at": "",
            "last_error": "",
            "updated_at": now_str,
        }
        updated = False
        try:
            updated = bool(await run_sync(st.update_scheduled_job_fields, job_id, job_updates))
        except Exception:
            updated = False
        if not updated:
            try:
                await run_sync(st.insert_scheduled_job, {**job_updates, "created_at": now_str})
            except Exception:
                try:
                    await run_sync(st.update_scheduled_job_fields, job_id, job_updates)
                except Exception:
                    pass
        job_row = {**job_updates}
        if enqueue_preparation:
            try:
                start_scheduled_job_preparation_task(st=st, jid=job_id, proj=proj, art=article, job=job_row)
            except Exception:
                pass
    return job_row or {}


def _enqueue_bulk_preparation(*, st, proj: dict, prep_rows: list[tuple[dict, dict]]) -> None:
    """Start prep only for jobs within the lead window; others stay ``scheduled`` until the scheduler picks them up."""
    for art, job in prep_rows:
        jid = (job.get("id") or "").strip()
        if not jid:
            continue
        try:
            start_scheduled_job_preparation_task(
                st=st,
                jid=jid,
                proj=proj,
                art=art,
                job=job,
                force=False,
            )
        except Exception:
            pass


@router.post("/bulk-schedule", response_model=BulkScheduleResponse, status_code=200)
async def bulk_schedule_articles(
    project_id: str,
    payload: BulkScheduleRequest,
    user: dict = Depends(get_current_user),
) -> BulkScheduleResponse:
    """Schedule many articles in one round-trip (bulk weekly/monthly UI)."""
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id, full=True)
    _require_verified_website(proj)

    wp_status = (payload.wp_status or "draft").strip().lower()
    if wp_status not in {"draft", "publish"}:
        raise HTTPException(status_code=400, detail="Invalid wp_status (draft|publish)")

    post_type = (payload.post_type or "").strip() or (proj.get("default_wp_rest_base") or "").strip() or "posts"
    writing_prompt_id = (payload.writing_prompt_id or "").strip()
    image_prompt_id = (payload.image_prompt_id or "").strip()
    generate_image = bool(payload.generate_image)

    # Dedupe by article_id (last wins).
    by_aid: dict[str, str] = {}
    for it in payload.items or []:
        aid = (it.article_id or "").strip()
        raw = (it.wp_scheduled_at or "").strip()
        if aid and raw:
            by_aid[aid] = raw
    if not by_aid:
        raise HTTPException(status_code=400, detail="No articles to schedule")

    aids = list(by_aid.keys())[:500]
    uid, role, plan = _user_schedule_plan(st, user)
    if role != "admin" and uid:
        if plan.get("allow_scheduling") is False:
            raise HTTPException(status_code=403, detail="Scheduling is not enabled for your plan.")

    if hasattr(st, "load_articles_by_ids_for_project"):
        articles_map = await run_sync(st.load_articles_by_ids_for_project, project_id, aids)
    else:
        articles_map = {}
        for aid in aids:
            try:
                a = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=aid)
                articles_map[aid] = a
            except HTTPException:
                pass

    parsed: list[tuple[str, str, datetime]] = []
    failed: list[BulkScheduleFailure] = []
    for aid, raw in by_aid.items():
        if aid not in articles_map:
            failed.append(BulkScheduleFailure(article_id=aid, error="Article not found"))
            continue
        try:
            dt_utc = _parse_schedule_time_utc(raw=raw, user=user)
        except HTTPException as e:
            failed.append(BulkScheduleFailure(article_id=aid, error=str(e.detail) or "Invalid schedule time"))
            continue
        if not is_schedule_time_allowed(dt_utc):
            failed.append(BulkScheduleFailure(article_id=aid, error=SCHEDULE_TOO_SOON_MESSAGE))
            continue
        parsed.append((aid, dt_utc.replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S"), dt_utc))

    if not parsed:
        return BulkScheduleResponse(ok=True, scheduled=0, failed=failed)

    _validate_bulk_schedule_cadence(cadence=payload.cadence, parsed=parsed)

    if role != "admin" and uid and hasattr(st, "consume_scheduled_usage"):
        ok, msg = st.consume_scheduled_usage(
            uid,
            month_limit=plan.get("max_scheduled_per_month"),
            amount=len(parsed),
        )
        if not ok:
            raise HTTPException(status_code=403, detail=msg or "Schedule limit reached for your plan")

    article_updates: list[tuple[str, dict]] = []
    prep_rows: list[tuple[dict, dict]] = []
    for aid, norm_utc, _dt in parsed:
        art = articles_map[aid]
        article_updates.append(
            (
                aid,
                {
                    "wp_scheduled_at": norm_utc,
                    "wp_schedule_wp_status": wp_status,
                    "wp_rest_base": post_type,
                    "wp_schedule_error": "",
                    "status": (art.get("status") or "pending"),
                },
            )
        )

    if hasattr(st, "bulk_update_articles"):
        await run_sync(st.bulk_update_articles, article_updates)
    else:
        for aid, u in article_updates:
            await run_sync(st.update_article_fields, aid, u)

    for aid, norm_utc, _dt in parsed:
        art = articles_map[aid]
        job_row = await _persist_schedule_row(
            st=st,
            project_id=project_id,
            article_id=aid,
            article=art,
            proj=proj,
            norm_utc=norm_utc,
            wp_status=wp_status,
            post_type=post_type,
            writing_prompt_id=writing_prompt_id,
            image_prompt_id=image_prompt_id,
            generate_image=generate_image,
            enqueue_preparation=False,
            skip_article_update=True,
        )
        if job_row:
            prep_rows.append((art, job_row))

    if prep_rows:
        _enqueue_bulk_preparation(st=st, proj=proj, prep_rows=prep_rows)

    return BulkScheduleResponse(ok=True, scheduled=len(parsed), failed=failed)


@router.post("/{article_id}/schedule", status_code=200)
async def schedule_article(
    project_id: str,
    article_id: str,
    payload: ScheduleRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id, full=True)
    _require_verified_website(proj)
    a = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)

    dt_utc = _parse_schedule_time_utc(raw=payload.wp_scheduled_at or "", user=user)
    norm_utc = dt_utc.replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")

    if not is_schedule_time_allowed(dt_utc):
        raise HTTPException(status_code=400, detail=SCHEDULE_TOO_SOON_MESSAGE)

    wp_status = (payload.wp_status or "draft").strip().lower()
    if wp_status not in {"draft", "publish"}:
        raise HTTPException(status_code=400, detail="Invalid wp_status (draft|publish)")

    uid, role, plan = _user_schedule_plan(st, user)
    if role != "admin" and uid:
        if plan.get("allow_scheduling") is False:
            raise HTTPException(status_code=403, detail="Scheduling is not enabled for your plan.")
        if hasattr(st, "consume_scheduled_usage"):
            ok, msg = st.consume_scheduled_usage(uid, month_limit=plan.get("max_scheduled_per_month"), amount=1)
            if not ok:
                raise HTTPException(status_code=403, detail=msg or "Schedule limit reached for your plan")

    post_type = (payload.post_type or "").strip() or (proj.get("default_wp_rest_base") or "").strip() or "posts"

    await _persist_schedule_row(
        st=st,
        project_id=project_id,
        article_id=article_id,
        article=a,
        proj=proj,
        norm_utc=norm_utc,
        wp_status=wp_status,
        post_type=post_type,
        writing_prompt_id=(payload.writing_prompt_id or "").strip(),
        image_prompt_id=(payload.image_prompt_id or "").strip(),
        generate_image=bool(payload.generate_image),
        enqueue_preparation=True,
    )
    return {
        "ok": True,
        "status": "scheduled",
        "message": "Article scheduled successfully.",
        "wp_scheduled_at": norm_utc,
        "post_type": post_type,
        "wp_status": wp_status,
    }


def _article_markdown_to_html(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        return ""
    return md.markdown(text, extensions=["extra", "sane_lists", "smarty"])


def _parse_wp_category_ids(category_ids: str) -> list[int]:
    cat_ids: list[int] = []
    for part in (category_ids or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            cat_ids.append(int(part))
        except (TypeError, ValueError):
            continue
    return list(dict.fromkeys([x for x in cat_ids if x > 0]))[:50]


def _wp_post_id_int(a: dict) -> int | None:
    raw = a.get("wp_post_id")
    if raw is None or raw == "":
        return None
    try:
        pid = int(raw)
        return pid if pid > 0 else None
    except (TypeError, ValueError):
        s = str(raw).strip()
        return int(s) if s.isdigit() and int(s) > 0 else None


def _wp_post_id_from_link(link: str) -> int | None:
    """Recover numeric post id from classic ``?p=123`` permalinks when the row missed ``wp_post_id``."""
    from urllib.parse import parse_qs, urlparse

    url = (link or "").strip()
    if not url:
        return None
    try:
        qs = parse_qs(urlparse(url).query)
        raw = (qs.get("p") or [None])[0]
        if raw is None:
            return None
        pid = int(str(raw).strip())
        return pid if pid > 0 else None
    except (TypeError, ValueError):
        return None


def _resolve_wp_post_id(a: dict) -> int | None:
    return _wp_post_id_int(a) or _wp_post_id_from_link((a.get("wp_link") or "").strip())


def _featured_image_url_loader(st, project_id: str, article_id: str):
    """Load disk-backed or omitted inline featured images for WordPress upload."""
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()

    def load() -> str | None:
        fn = getattr(st, "get_article_image_url", None)
        if callable(fn):
            return fn(project_id=pid, article_id=aid)
        file_fn = getattr(st, "featured_image_file_exists", None)
        load_fn = getattr(st, "_load_featured_image_file_as_data_url", None)
        if callable(file_fn) and callable(load_fn) and file_fn(aid):
            return load_fn(aid)
        return None

    return load


def _article_has_stored_featured_image(st, article: dict, article_id: str) -> bool:
    aid = (article_id or "").strip()
    if (article.get("image_url") or "").strip():
        return True
    if article.get("has_featured_image"):
        return True
    storage = (article.get("featured_image_storage") or "").strip()
    if storage in {"file", "url", "inline"}:
        return True
    file_fn = getattr(st, "featured_image_file_exists", None)
    if callable(file_fn) and file_fn(aid):
        return True
    return False


@router.post("/{article_id}/publish", status_code=200)
async def publish_to_live_site(
    project_id: str,
    article_id: str,
    image_file: UploadFile | None = File(default=None),
    post_type: str = Form(default="posts"),
    wp_status: str = Form(default="draft"),
    category_ids: str = Form(default=""),
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Publish an article to the live WordPress site.
    """
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id, full=True)
    _require_verified_website(proj)
    a = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)

    # Double-post guard: if this article already has a live WordPress post,
    # block silent re-publishing so we never create a second WP entry for the
    # same article from the same UI action.
    existing_wp_post_id = str((a or {}).get("wp_post_id") or "").strip()
    if existing_wp_post_id:
        raise HTTPException(
            status_code=409,
            detail=(
                "This article is already published to WordPress (post id "
                f"{existing_wp_post_id}). Edit it in WordPress directly or "
                "duplicate the article to publish a new copy."
            ),
        )

    # If a scheduled job exists for this article, atomically claim it for the
    # manual publish path. This prevents the scheduler loop from publishing the
    # same article at the same instant (the main double-posting trigger).
    claimed_job_id: str | None = None
    if hasattr(st, "load_scheduled_jobs") and hasattr(st, "claim_scheduled_job_for_posting"):
        try:
            rows = await run_sync(st.load_scheduled_jobs, project_id=project_id) or []
            active = [
                r
                for r in rows
                if isinstance(r, dict)
                and (r.get("article_id") or "").strip() == article_id
                and (r.get("state") or "").strip().lower()
                in {"scheduled", "ready_to_post", "failed", "content_generating", "image_generating"}
            ]
            if active:
                def _stamp(x: dict) -> str:
                    return (x.get("updated_at") or x.get("created_at") or "").strip()
                active.sort(key=_stamp, reverse=True)
                target_jid = (active[0].get("id") or "").strip()
                if target_jid:
                    claimed = await run_sync(
                        st.claim_scheduled_job_for_posting,
                        target_jid,
                        ["scheduled", "ready_to_post", "failed", "content_generating", "image_generating"],
                        target_state="posting",
                    )
                    if not claimed:
                        # Could not claim — most likely the scheduler is already
                        # publishing this article. Refuse instead of double-posting.
                        raise HTTPException(
                            status_code=409,
                            detail=(
                                "This article is currently being published by the scheduler. "
                                "Please wait a moment and refresh — duplicate publishing was prevented."
                            ),
                        )
                    claimed_job_id = target_jid
        except HTTPException:
            raise
        except Exception:
            # If the lookup fails (e.g., storage hiccup), continue — atomicity
            # gain is best-effort, not a hard correctness requirement on a
            # path that already had no guard before.
            claimed_job_id = None

    # Plan enforcement: publishing consumes per-day / per-month article quota.
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role != "admin" and uid and hasattr(st, "consume_article_usage"):
        plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
        plan = {}
        try:
            plans = st.load_plans() or {}
            plan = plans.get(plan_key) if isinstance(plans, dict) else {}
            if not isinstance(plan, dict):
                plan = {}
        except Exception:
            plan = {}
        day_lim = plan.get("max_articles_per_day")
        month_lim = plan.get("max_articles_per_month")
        ok, msg = st.consume_article_usage(uid, day_limit=day_lim, month_limit=month_lim, amount=1)
        if not ok:
            raise HTTPException(status_code=403, detail=msg or "Limit reached for your plan")

    links = []
    for x in (proj.get("context_links") or []):
        if isinstance(x, dict) and (x.get("label") or "").strip() and (x.get("url") or "").strip():
            links.append({"label": (x.get("label") or "").strip(), "url": (x.get("url") or "").strip()})

    wp_site_url = (proj.get("wp_site_url") or proj.get("website_url") or "").strip()
    wp_username = (proj.get("wp_username") or "").strip()
    wp_app_password = (proj.get("wp_app_password") or "").replace(" ", "").strip()
    if not wp_site_url or not wp_username or not wp_app_password:
        raise HTTPException(status_code=400, detail="WordPress is not connected for this project. Fill WP site URL, username, and application password in Project Settings.")

    if (wp_status or "").strip().lower() not in {"draft", "publish"}:
        raise HTTPException(status_code=400, detail="Invalid wp_status (must be draft or publish)")
    rest_base = (post_type or "").strip() or "posts"

    cat_ids = _parse_wp_category_ids(category_ids)

    title = (a.get("title") or "").strip()
    article_md = (a.get("article") or "").strip()
    if not title or not article_md:
        raise HTTPException(status_code=400, detail="Article title/content is required before publishing")

    content_html = _article_markdown_to_html(article_md)
    content_html = apply_context_links_html(content_html, links) if links else content_html

    wp = WordpressClient(site_url=wp_site_url, username=wp_username, app_password=wp_app_password)

    def _release_manual_claim(err_msg: str | None) -> None:
        """If we atomically claimed a scheduled job for this manual publish but
        the WordPress call failed, mark the job as 'failed' so the user sees
        the error in Scheduled Articles and the scheduler doesn't silently
        reclaim it on the next poll."""
        if not claimed_job_id:
            return
        try:
            st.update_scheduled_job_fields(
                claimed_job_id,
                {
                    "state": "failed",
                    "last_error": (err_msg or "Manual publish failed")[:1000],
                    "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                },
            )
        except Exception:
            pass

    from app.services.wordpress_publish import assert_wordpress_publish_ready, publish_post_to_wordpress

    try:
        await assert_wordpress_publish_ready(wp)
    except Exception as e:
        _release_manual_claim(str(e))
        raise HTTPException(status_code=403, detail=str(e)) from e

    # Featured image is best-effort — a media 403 must not block publishing the article body.
    featured_media_id: int | None = None
    if image_file is not None:
        data = await image_file.read()
        if data:
            featured_media_id = await wp.upload_media_optional(
                filename=image_file.filename or "upload.png",
                content_type=image_file.content_type or "image/png",
                data=data,
            )
    else:
        featured_media_id = await resolve_featured_media_id(
            wp,
            a,
            timeout=90.0,
            load_image_url=_featured_image_url_loader(st, project_id, article_id),
        )

    payload: dict = {
        "title": title[:500],
        "status": (wp_status or "draft").strip().lower(),
        "content": content_html,
        "meta": {
            # Yoast SEO meta keys (best-effort; requires Yoast + REST meta enabled)
            "_yoast_wpseo_title": (a.get("meta_title") or "").strip()[:400],
            "_yoast_wpseo_metadesc": (a.get("meta_description") or "").strip()[:600],
            "_yoast_wpseo_focuskw": (a.get("focus_keyphrase") or "").strip()[:500],
        },
    }
    if featured_media_id is not None:
        payload["featured_media"] = featured_media_id
    if cat_ids:
        payload["categories"] = cat_ids

    # WordPress tags from keywords — applied inside Riviso plugin (no REST tag API spam).
    kw = [str(x).strip() for x in (a.get("keywords") or []) if str(x).strip()]
    if kw:
        payload["tag_names"] = kw[:15]

    await publish_pipeline_status(article_id, MSG_PUBLISH_DISPATCH, STAGE_PUBLISH_DISPATCH)
    try:
        created = await publish_post_to_wordpress(wp, post_type=rest_base, payload=payload)
    except Exception as e:
        _release_manual_claim(f"WordPress publish failed: {e}")
        msg = str(e)
        status_code = 403 if "403" in msg or "blocked publishing" in msg.lower() else 502
        raise HTTPException(status_code=status_code, detail=f"WordPress publish failed: {msg}") from e

    wp_post_id = created.get("id") if isinstance(created, dict) else None
    wp_link = created.get("link") if isinstance(created, dict) else None
    created_wp_status = _normalize_wp_rest_status(created.get("status")) if isinstance(created, dict) else ""
    if not created_wp_status:
        created_wp_status = (payload["status"] or "").strip().lower()

    updates: dict = {
        "wp_post_id": wp_post_id,
        "wp_link": wp_link or "",
        "wp_rest_base": rest_base,
        "wp_last_wp_status": created_wp_status or payload["status"],
        "posted_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S") if created_wp_status == "publish" else (a.get("posted_at") or ""),
        "status": "published" if created_wp_status == "publish" else (a.get("status") or "draft"),
        # Clear schedule marker so the UI shows published, not scheduled (same as scheduler after post).
        "wp_scheduled_at": "",
        "wp_schedule_error": "",
    }
    await run_sync(st.update_article_fields, article_id, updates)

    # Best-effort: Search Console URL Inspection after live publish.
    try:
        await maybe_request_url_inspection(
            st=st,
            proj=proj,
            live_url=str(wp_link or ""),
            wp_status=created_wp_status or payload["status"],
            article_id=article_id,
        )
    except Exception:
        pass

    # Best-effort: ping sitemap so crawlers discover the new URL via sitemap updates.
    # (This is not a guarantee of indexing.)
    try:
        if created_wp_status == "publish":
            asyncio.create_task(ping_sitemap(sitemap_url=default_sitemap_url(wp_site_url=wp_site_url)))
    except Exception:
        pass

    # If this article had a pending scheduled job, mark it posted so Scheduled Articles stays in sync.
    try:
        if hasattr(st, "load_scheduled_jobs") and hasattr(st, "update_scheduled_job_fields"):
            rows = await run_sync(st.load_scheduled_jobs, project_id=project_id) or []
            candidates = [
                r
                for r in rows
                if isinstance(r, dict)
                and (r.get("article_id") or "").strip() == article_id
                and (r.get("state") or "") not in {"posted", "cancelled"}
            ]
            if candidates:
                def _stamp(x: dict) -> str:
                    return (x.get("updated_at") or x.get("created_at") or "").strip()

                candidates.sort(key=_stamp, reverse=True)
                jid = (candidates[0].get("id") or "").strip()
                if jid:
                    await run_sync(
                        st.update_scheduled_job_fields,
                        jid,
                        {
                            "state": "posted",
                            "wp_post_id": str(wp_post_id) if wp_post_id is not None else "",
                            "wp_link": str(wp_link or "")[:2000],
                            "last_error": "",
                            "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                        },
                    )
    except Exception:
        pass

    message = (
        "Published to WordPress."
        if created_wp_status == "publish"
        else "Saved to WordPress as draft."
    )
    await publish_pipeline_status(article_id, MSG_PUBLISH_COMPLETE, STAGE_COMPLETE)
    return {
        "ok": True,
        "status": "published" if created_wp_status == "publish" else "draft",
        "message": message,
        "wp_post_id": wp_post_id,
        "wp_link": wp_link,
        "featured_media_id": featured_media_id,
    }


@router.post("/{article_id}/shopify/publish", status_code=200)
async def publish_to_shopify_blog(
    project_id: str,
    article_id: str,
    payload: ShopifyPublishRequest | None = None,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Create a Shopify Blog Article for this project.
    """
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id, full=True)

    plat = (proj.get("platform") or "").strip().lower()
    if plat != "shopify":
        raise HTTPException(status_code=400, detail="This project is not a Shopify project.")

    from app.services.shopify_credentials import refresh_project_token_if_needed

    pid = (proj.get("id") or "").strip()
    proj = await refresh_project_token_if_needed(st=st, project_id=pid, proj=proj)
    token = (proj.get("shopify_access_token") or "").strip()
    shop = (proj.get("shopify_shop") or "").strip()
    if not token or not shop:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "website_not_connected",
                "message": "Shopify store is not connected for this project. Connect Shopify in Project Settings before publishing.",
            },
        )
    from app.services.shopify_api_errors import parse_granted_scopes, scopes_missing_for_publish
    from app.services.shopify_client import ShopifyClient

    client = ShopifyClient(shop=shop, access_token=token)
    try:
        live_handles = await client.fetch_access_scopes()
        granted_live = set(live_handles)
    except Exception:
        granted_live = parse_granted_scopes(proj.get("shopify_scope") or "")
    missing_publish = scopes_missing_for_publish(granted_live)
    if missing_publish:
        need = ", ".join(f"`{s}`" for s in missing_publish)
        raise HTTPException(
            status_code=403,
            detail={
                "code": "shopify_scope_missing",
                "message": (
                    f"Shopify publish permission is missing ({need}). "
                    "Enable Store content → read_content and write_content on your app version, "
                    "click Update app permissions in Riviso, then try again."
                ),
                "missing_scopes": missing_publish,
                "granted_scopes": sorted(granted_live),
            },
        )

    a = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)
    title = (a.get("title") or "").strip()
    article_md = (a.get("article") or "").strip()
    if not title or not article_md:
        raise HTTPException(status_code=400, detail="Article title/content is required before publishing")

    body = payload or ShopifyPublishRequest()
    blog_id: int | None = body.blog_id
    publish_now = bool(body.publish)

    # Resolve blog id from synced catalog if needed.
    if blog_id is None:
        catalog = proj.get("shopify_catalog") if isinstance(proj.get("shopify_catalog"), dict) else {}
        blogs = catalog.get("blogs") if isinstance(catalog.get("blogs"), list) else []
        first = next((b for b in blogs if isinstance(b, dict) and b.get("id")), None)
        if first and str(first.get("id")).strip().isdigit():
            blog_id = int(str(first.get("id")).strip())
    if blog_id is None:
        try:
            live_blogs = await client.get_paginated("/blogs.json", resource_key="blogs", max_pages=1)
            first_live = next((b for b in live_blogs if isinstance(b, dict) and b.get("id")), None)
            if first_live and str(first_live.get("id")).strip().isdigit():
                blog_id = int(str(first_live.get("id")).strip())
        except Exception:
            pass
    if blog_id is None:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "shopify_blog_missing",
                "message": (
                    "No Shopify blog found. Add a blog in Shopify Admin → Online Store → Blog posts, "
                    "enable read_content on your app, then Sync from Shopify in Project Settings."
                ),
            },
        )

    # Best-effort: compute public link when handles are available.
    def _public_base() -> str:
        base = (proj.get("website_url") or "").strip().rstrip("/")
        if base.startswith("http://") or base.startswith("https://"):
            return base
        return f"https://{shop}"

    def _blog_handle_for(bid: int) -> str:
        catalog = proj.get("shopify_catalog") if isinstance(proj.get("shopify_catalog"), dict) else {}
        blogs = catalog.get("blogs") if isinstance(catalog.get("blogs"), list) else []
        for b in blogs:
            if not isinstance(b, dict):
                continue
            if str(b.get("id") or "").strip() == str(bid):
                return (b.get("handle") or "").strip()
        return ""

    content_html = _article_markdown_to_html(article_md)
    # Tags from keywords.
    tags = ", ".join([str(x).strip() for x in (a.get("keywords") or []) if str(x).strip()][:20])

    from app.services.shopify_article_image import (
        build_shopify_article_image_payload,
        shopify_article_has_featured_image,
    )

    image_payload = await build_shopify_article_image_payload(a, alt=title)
    if (a.get("image_url") or "").strip() and not image_payload:
        _log.warning(
            "Shopify publish: article has image_url but could not build attachment (article_id=%s)",
            article_id,
        )

    article_body: dict = {
        "title": title[:255],
        "body_html": content_html,
        "tags": tags,
        "published": publish_now,
    }
    if image_payload:
        article_body["image"] = image_payload

    await publish_pipeline_status(article_id, MSG_PUBLISH_DISPATCH, STAGE_PUBLISH_DISPATCH)
    try:
        created = await client.post_json(
            f"/blogs/{blog_id}/articles.json",
            payload={"article": article_body},
        )
    except Exception as exc:
        hint = ""
        msg = str(exc)
        if "403" in msg or "Forbidden" in msg:
            hint = (
                " (403 Forbidden: your Shopify token likely lacks write_content scope; "
                "reconnect Shopify in Project Settings to grant publish permissions.)"
            )
        raise HTTPException(status_code=502, detail=f"Shopify publish failed: {exc}{hint}") from exc

    art = created.get("article") if isinstance(created, dict) else None
    if not isinstance(art, dict):
        raise HTTPException(status_code=502, detail="Shopify publish failed: invalid response from Shopify")

    shopify_article_id = art.get("id")
    if image_payload and shopify_article_id and not shopify_article_has_featured_image(art):
        try:
            updated = await client.put_json(
                f"/blogs/{blog_id}/articles/{shopify_article_id}.json",
                payload={"article": {"image": image_payload}},
            )
            art_updated = updated.get("article") if isinstance(updated, dict) else None
            if isinstance(art_updated, dict):
                art = art_updated
        except Exception:
            _log.warning(
                "Shopify publish: featured image PUT failed (article_id=%s shopify_id=%s)",
                article_id,
                shopify_article_id,
                exc_info=True,
            )
    handle = (art.get("handle") or "").strip()
    blog_handle = _blog_handle_for(blog_id)
    link = ""
    if handle and blog_handle:
        link = f"{_public_base()}/blogs/{blog_handle}/{handle}"
    # Fallback to admin URL.
    if not link and shopify_article_id:
        link = f"https://{shop}/admin/blogs/{blog_id}/articles/{shopify_article_id}"

    updates: dict = {
        "shopify_blog_id": blog_id,
        "shopify_article_id": shopify_article_id,
        "shopify_link": link,
        "shopify_published_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S") if publish_now else "",
        "posted_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S") if publish_now else (a.get("posted_at") or ""),
        "status": "published" if publish_now else (a.get("status") or "draft"),
    }
    await run_sync(st.update_article_fields, article_id, updates)
    await publish_pipeline_status(article_id, MSG_PUBLISH_COMPLETE, STAGE_COMPLETE)
    return {
        "ok": True,
        "status": "published" if publish_now else "draft",
        "message": "Published to Shopify." if publish_now else "Created draft on Shopify.",
        "shopify_article_id": shopify_article_id,
        "shopify_blog_id": blog_id,
        "shopify_link": link or None,
    }


@router.post("/{article_id}/update-wordpress", status_code=200)
async def update_wordpress_post(
    project_id: str,
    article_id: str,
    image_file: UploadFile | None = File(default=None),
    post_type: str = Form(default=""),
    wp_status: str = Form(default=""),
    category_ids: str = Form(default=""),
    user: dict = Depends(get_current_user),
) -> dict:
    """Push the current article row to an existing WordPress post (no new post created)."""
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id, full=True)
    _require_verified_website(proj)
    aid = (article_id or "").strip()
    try:
        a = await run_sync(call_storage, _get_article_or_404, st=st, project_id=project_id, article_id=aid)
    except HTTPException:
        raise
    except Exception as e:
        raise_storage_http(e)

    wp_post_id = _resolve_wp_post_id(a)
    if not wp_post_id:
        raise HTTPException(
            status_code=400,
            detail="This article is not linked to a WordPress post yet. Publish it first.",
        )
    if not _wp_post_id_int(a):
        await run_sync(st.update_article_fields, article_id, {"wp_post_id": wp_post_id})

    links = []
    for x in (proj.get("context_links") or []):
        if isinstance(x, dict) and (x.get("label") or "").strip() and (x.get("url") or "").strip():
            links.append({"label": (x.get("label") or "").strip(), "url": (x.get("url") or "").strip()})

    wp_site_url = (proj.get("wp_site_url") or proj.get("website_url") or "").strip()
    wp_username = (proj.get("wp_username") or "").strip()
    wp_app_password = (proj.get("wp_app_password") or "").replace(" ", "").strip()
    if not wp_site_url or not wp_username or not wp_app_password:
        raise HTTPException(
            status_code=400,
            detail="WordPress is not connected for this project. Fill WP credentials in Project Settings.",
        )

    status_in = (wp_status or a.get("wp_last_wp_status") or "publish").strip().lower()
    if status_in not in {"draft", "publish"}:
        raise HTTPException(status_code=400, detail="Invalid wp_status (must be draft or publish)")
    rest_base = (post_type or a.get("wp_rest_base") or "posts").strip() or "posts"
    cat_ids = _parse_wp_category_ids(category_ids)

    title = (a.get("title") or "").strip()
    article_md = (a.get("article") or "").strip()
    if not title or not article_md:
        raise HTTPException(status_code=400, detail="Article title/content is required before updating WordPress")

    content_html = _article_markdown_to_html(article_md)
    content_html = apply_context_links_html(content_html, links) if links else content_html

    wp = WordpressClient(site_url=wp_site_url, username=wp_username, app_password=wp_app_password)

    expects_featured_image = _article_has_stored_featured_image(st, a, aid) or image_file is not None
    featured_media_id: int | None = None
    featured_image_warning: str | None = None
    if image_file is not None:
        data = await image_file.read()
        if data:
            featured_media_id = await wp.upload_media_optional(
                filename=image_file.filename or "upload.png",
                content_type=image_file.content_type or "image/png",
                data=data,
            )
    else:
        featured_media_id = await resolve_featured_media_id(
            wp,
            a,
            timeout=90.0,
            load_image_url=_featured_image_url_loader(st, project_id, aid),
        )

    if expects_featured_image and featured_media_id is None:
        featured_image_warning = (
            "Post updated but the featured image could not be uploaded to WordPress. "
            "Ensure the WordPress user has upload_files permission and REST media uploads are allowed."
        )

    payload: dict = {
        "title": title[:500],
        "status": status_in,
        "content": content_html,
        "meta": {
            "_yoast_wpseo_title": (a.get("meta_title") or "").strip()[:400],
            "_yoast_wpseo_metadesc": (a.get("meta_description") or "").strip()[:600],
            "_yoast_wpseo_focuskw": (a.get("focus_keyphrase") or "").strip()[:500],
        },
    }
    if featured_media_id is not None:
        payload["featured_media"] = featured_media_id
    if cat_ids:
        payload["categories"] = cat_ids

    kw = [str(x).strip() for x in (a.get("keywords") or []) if str(x).strip()]
    if kw:
        payload["tag_names"] = kw[:15]

    from app.services.wordpress_publish import update_post_on_wordpress

    try:
        updated = await update_post_on_wordpress(
            wp,
            post_type=rest_base,
            wp_post_id=wp_post_id,
            payload=payload,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"WordPress update failed: {e}") from e

    wp_link = updated.get("link") if isinstance(updated, dict) else None
    updated_wp_status = _normalize_wp_rest_status(updated.get("status")) if isinstance(updated, dict) else ""
    if not updated_wp_status:
        updated_wp_status = status_in

    updates: dict = {
        "wp_post_id": wp_post_id,
        "wp_link": (wp_link or a.get("wp_link") or "").strip(),
        "wp_rest_base": rest_base,
        "wp_last_wp_status": updated_wp_status,
        "posted_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        if updated_wp_status == "publish"
        else (a.get("posted_at") or ""),
        "status": "published" if updated_wp_status == "publish" else (a.get("status") or "draft"),
    }
    await run_sync(st.update_article_fields, article_id, updates)

    message = "WordPress post updated successfully."
    if featured_image_warning:
        message = featured_image_warning

    return {
        "ok": True,
        "status": "published" if updated_wp_status == "publish" else "draft",
        "message": message,
        "wp_post_id": wp_post_id,
        "wp_link": updates.get("wp_link"),
        "featured_media_id": featured_media_id,
        "featured_image_uploaded": featured_media_id is not None,
    }


@router.post("/{article_id}/sync-from-wordpress", status_code=200)
async def sync_article_from_wordpress_route(
    project_id: str,
    article_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Pull the latest title, body, SEO meta, permalink, and status from WordPress into Riviso.
    """
    from app.api.routes.wordpress import _get_wp_client_for_project

    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id, full=True)
    _require_verified_website(proj)
    aid = (article_id or "").strip()
    try:
        row = await run_sync(call_storage, _get_article_or_404, st=st, project_id=project_id, article_id=aid)
    except HTTPException:
        raise
    except Exception as e:
        raise_storage_http(e)

    wp = _get_wp_client_for_project(proj)
    from app.services.wordpress_sync import sync_article_from_wordpress

    try:
        result = await sync_article_from_wordpress(
            wp=wp,
            article=row,
            rest_base=(row.get("wp_rest_base") or "").strip() or None,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"WordPress sync failed: {e}") from e

    updates = result.get("updates") or {}
    if updates:
        try:
            saved = await run_sync(call_storage, st.update_article_fields, aid, updates)
        except Exception as e:
            raise_storage_http(e)
        if not saved:
            raise HTTPException(status_code=500, detail="Could not save synced WordPress data.")

    fresh = await run_sync(call_storage, _get_article_or_404, st=st, project_id=project_id, article_id=aid)
    detail = _to_detail_response(st=st, user=user, article=fresh)

    change_labels = {
        "title": "title",
        "article": "body",
        "wp_link": "live URL",
        "wp_status": "WordPress status",
        "meta_title": "meta title",
        "meta_description": "meta description",
        "focus_keyphrase": "focus keyphrase",
        "checked": "no content changes",
    }
    changes = [change_labels.get(c, c) for c in (result.get("changes") or [])]

    return {
        "ok": True,
        "message": "Synced from WordPress."
        if changes != ["no content changes"]
        else "Already up to date with WordPress.",
        "changes": changes,
        "wp_link": result.get("wp_link"),
        "wp_status": result.get("wp_status"),
        "wp_modified_at": result.get("wp_modified_at"),
        "wp_synced_at": result.get("wp_synced_at"),
        "article": detail.model_dump(),
    }


@router.post("/{article_id}/gsc/request-indexing", status_code=200)
async def request_indexing(project_id: str, article_id: str, user: dict = Depends(get_current_user)) -> dict:
    """
    Manual "Index now" — runs the available automated discovery channels and
    returns a deep link to GSC URL Inspection so the user can finish the manual
    "REQUEST INDEXING" step (which has no public API equivalent).

    Channels exercised, in order, by :func:`request_url_inspection_now`:

    1. Google Indexing API (when ``GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON`` is set).
       Officially limited to JobPosting / BroadcastEvent — the response is **not**
       reflected in URL Inspection's history. We surface this caveat in ``note``.
    2. Sitemap ping to Google and Bing (best-effort discovery hint).
    3. Deep link to the GSC URL Inspection panel pre-filled with the live URL —
       the only way to actually create the visible "Indexing requested" entry.
    """
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id, full=True)
    a = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)
    live_url = (a.get("wp_link") or "").strip()
    if not live_url:
        raise HTTPException(status_code=400, detail="Article does not have a live URL yet (publish first).")
    if not (proj.get("gsc_property_url") or "").strip():
        raise HTTPException(status_code=400, detail="Search Console property is not linked for this project. Open Tools → Search Console.")

    result = await request_url_inspection_now(st=st, proj=proj, live_url=live_url, article_id=article_id)
    a2 = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)
    return {
        "ok": bool(result.get("ok")),
        "gsc_status": (a2.get("gsc_status") or "").strip() or None,
        "gsc_inspection_requested_at": (a2.get("gsc_inspection_requested_at") or "").strip() or None,
        "gsc_inspection_url": (a2.get("gsc_inspection_url") or "").strip() or None,
        "indexing_api": result.get("indexing_api") or {"attempted": False, "ok": False, "error": ""},
        "sitemap_ping": result.get("sitemap_ping") or {"attempted": False, "ok": False, "sitemap_url": ""},
        "inspect_panel_url": (result.get("inspect_panel_url") or "").strip() or None,
        "note": (result.get("note") or "").strip() or None,
    }


@router.get("/{article_id}/gsc/indexing-status", status_code=200)
async def indexing_status(project_id: str, article_id: str, user: dict = Depends(get_current_user)) -> dict:
    """
    Read-only "Check indexing" — calls Google Search Console URL Inspection and returns
    flat coverageState / verdict / lastCrawlTime fields suitable for the UI. Does not
    consume any indexing quota beyond Google's standard URL Inspection API limits.
    """
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id, full=True)
    a = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)
    live_url = (a.get("wp_link") or "").strip()
    if not live_url:
        raise HTTPException(status_code=400, detail="Article does not have a live URL yet (publish first).")
    if not (proj.get("gsc_property_url") or "").strip():
        raise HTTPException(status_code=400, detail="Search Console property is not linked for this project. Open Tools → Search Console.")
    try:
        result = await inspect_url_status(st=st, proj=proj, live_url=live_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e) or "Search Console URL Inspection failed.") from e
    return result


# ---------------------------------------------------------------------------
# Rank monitoring — Feature 4 (Smart Refresh foundations)
# ---------------------------------------------------------------------------


@router.post("/{article_id}/monitor/mark", status_code=200)
async def monitor_mark(
    project_id: str,
    article_id: str,
    payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Manual override for the Optimization-status column. ``status`` must be one of
    ``fresh|stale|unknown``. Used by the dashboard before automated SERP-shift
    detection lands; once the scheduler sweep is online this becomes the override path.
    """
    from app.services.rank_monitor_service import RankMonitorService

    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id, full=True)
    a = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)

    status = ((payload or {}).get("status") or "").strip().lower()
    if status not in {"fresh", "stale", "unknown"}:
        raise HTTPException(status_code=400, detail="status must be one of fresh|stale|unknown")

    svc = RankMonitorService(project=proj)
    monitor = svc.mark_status(article_id=(a.get("id") or "").strip(), status=status)
    # Also reflect the status on the article row so list views update without a separate fetch.
    if hasattr(st, "update_article_fields"):
        try:
            st.update_article_fields(
                (a.get("id") or "").strip(),
                {
                    "monitor_status": monitor.get("status") or "",
                    "monitor_last_checked_at": monitor.get("last_checked_at") or "",
                },
            )
        except Exception:
            pass
    return {"ok": True, "monitor": monitor}


@router.post("/{article_id}/monitor/refresh", status_code=501)
async def monitor_refresh(
    project_id: str,
    article_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    One-click "Smart Refresh" — regenerate body using updated SERP signals. v1 stub.

    Schema, monitor lifecycle, and "Mark stale" override are already in place; the
    SERP-diff + regeneration pipeline lands in the follow-up PR.
    """
    raise HTTPException(
        status_code=501,
        detail=(
            "Smart Refresh ships in the next iteration. Use the standard Edit / regenerate flow "
            "in the meantime; once SERP-diff detection is live, this endpoint will return the "
            "refreshed article without manual intervention."
        ),
    )

