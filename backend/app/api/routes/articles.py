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

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
import markdown as md
from pymongo.errors import PyMongoError

from app.core.deps import get_current_user
from app.core.ids import user_ids_equal
from app.legacy.storage import get_legacy_storage_module
from app.services.content_sanitizer import (
    sanitize_article_body,
    sanitize_meta_description,
    sanitize_meta_title,
)
from app.services.context_links import apply_context_links_html
from app.services.wordpress_client import WordpressClient
from app.services.gsc_actions import inspect_url_status, maybe_request_url_inspection, request_url_inspection_now
from app.services.sitemap_ping import default_sitemap_url, ping_sitemap
from app.services.scheduler import prepare_article_for_scheduled_job, scheduler_error_message
from app.services.to_thread import run_sync
from app.services.user_timezone import parse_schedule_input_to_utc, zoneinfo_for_user
from app.services.prompt_validation import assert_writing_prompt_allowed
from app.services.article_pipeline import (
    execute_article_generation,
    execute_featured_image_regeneration,
    image_regeneration_limit_snapshot,
)
from app.core.article_duplicates import normalize_article_title_key as _normalize_article_title_key
from app.core.article_duplicates import sync_project_title_index as _sync_project_title_index
from app.schemas.articles import (
    ArticleCreate,
    ArticleDetailResponse,
    ArticlePublic,
    ArticleUpdateRequest,
    BulkActionRequest,
    BulkUploadRequest,
    BulkUploadResponse,
    GenerateRequest,
    RegenerateImageRequest,
    ScheduleRequest,
)

router = APIRouter(prefix="/projects/{project_id}/articles", tags=["articles"])

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

    # DB explicitly published → always show published (even if wp_link/wp_post_id missing; data can be inconsistent).
    if raw == "published" or wp_last == "publish":
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
        jobs = st.load_scheduled_jobs(project_id=pid) or []
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
        keywords=[str(x).strip() for x in (a.get("keywords") or []) if str(x).strip()],
        focus_keyphrase=(a.get("focus_keyphrase") or "").strip() or None,
        wp_scheduled_at=wp_sched or None,
        wp_schedule_error=(a.get("wp_schedule_error") or "").strip() or None,
        wp_link=(a.get("wp_link") or "").strip() or None,
        gsc_status=(a.get("gsc_status") or "").strip() or None,
        hasBody=bool(a.get("hasBody")) if "hasBody" in a else None,
    )


# ---------------------------------------------------------------------------
# Access control & article lookup
# ---------------------------------------------------------------------------


def _require_project_access(*, st, user: dict, project_id: str) -> dict:
    pid = (project_id or "").strip()
    proj = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role != "admin" and not user_ids_equal(proj.get("owner_user_id"), uid):
        raise HTTPException(status_code=404, detail="Project not found")
    return proj


def _require_verified_website(proj: dict) -> None:
    """Generation/scheduling depend on project WordPress context and must only run after verification."""
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
    plan: dict = {}
    try:
        plans = st.load_plans() or {}
        plan = plans.get(plan_key) if isinstance(plans, dict) else {}
        if not isinstance(plan, dict):
            plan = {}
    except Exception:
        plan = {}
    return image_regeneration_limit_snapshot(
        used=int(article.get("featured_image_regeneration_count") or 0),
        limit=plan.get("max_article_image_regenerations"),
    )


def _to_detail_response(*, st, user: dict, article: dict, view_article: dict | None = None) -> ArticleDetailResponse:
    a_view = view_article or article
    base = _to_public(a_view).model_dump()
    regen = _article_image_regeneration_usage(st=st, user=user, article=article)
    return ArticleDetailResponse(
        **base,
        article=(article.get("article") or ""),
        meta_title=(article.get("meta_title") or "").strip() or None,
        meta_description=(article.get("meta_description") or "").strip() or None,
        image_url=(article.get("image_url") or "").strip() or None,
        featured_image_regeneration_count=regen["used"],
        featured_image_regeneration_limit=regen["limit"],
        featured_image_regeneration_remaining=regen["remaining"],
        featured_image_regeneration_unlimited=regen["unlimited"],
    )


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


@router.get("", response_model=list[ArticlePublic])
async def list_articles(project_id: str, user: dict = Depends(get_current_user)) -> list[ArticlePublic]:
    """List articles for a project, newest first, with WordPress/schedule overlay when present."""
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    if hasattr(st, "load_articles_listing_for_project"):
        rows = await run_sync(st.load_articles_listing_for_project, project_id, limit=5000)
    else:
        all_rows = await run_sync(st.load_articles)
        rows = [a for a in (all_rows or []) if isinstance(a, dict) and (a.get("project_id") or "") == project_id]
    posted_jobs = await run_sync(_fetch_posted_job_overlay_map, st, project_id)
    out = [
        _to_public(_merge_posted_job_into_article_row(a, posted_jobs.get((a.get("id") or "").strip())))
        for a in rows
        if isinstance(a, dict)
    ]
    out.sort(key=lambda x: (x.created_at or ""), reverse=True)
    return out


@router.post("/export/consume", status_code=200)
async def consume_export_quota(project_id: str, user: dict = Depends(get_current_user)) -> dict:
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
        raise HTTPException(
            status_code=503,
            detail="Database temporarily unavailable. Please try again.",
        ) from e

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
    user: dict = Depends(get_current_user),
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


@router.get("/{article_id}", response_model=ArticleDetailResponse)
async def get_article_detail(
    project_id: str,
    article_id: str,
    user: dict = Depends(get_current_user),
) -> ArticleDetailResponse:
    """Full article body and meta for the editor UI."""
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    a = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)
    aid = (article_id or "").strip()
    job = await run_sync(_fetch_posted_job_overlay_for_article, st, project_id, aid)
    a_view = _merge_posted_job_into_article_row(a, job)
    return _to_detail_response(st=st, user=user, article=a, view_article=a_view)


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


@router.post("/{article_id}/generate")
async def generate_article_and_image(
    project_id: str,
    article_id: str,
    payload: GenerateRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Generate article HTML and optional featured image (OpenAI), then persist to storage.

    Requires ``OPENAI_API_KEY``; uses project prompts and article row fields as context.
    """
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    _require_verified_website(proj)
    row = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)
    wp_id = (payload.writing_prompt_id or "").strip() or (proj.get("default_prompt_id") or "").strip() or None
    ip_id = (payload.image_prompt_id or "").strip() or (proj.get("default_image_prompt_id") or "").strip() or None
    return await execute_article_generation(
        st=st,
        user=user,
        proj=proj,
        project_id=project_id,
        article_id=(article_id or "").strip(),
        row=row,
        writing_prompt_id=wp_id,
        image_prompt_id=ip_id,
        generate_image=bool(payload.generate_image),
        focus_keyphrase_override=payload.focus_keyphrase,
    )


@router.post("/{article_id}/regenerate-image")
async def regenerate_article_featured_image(
    project_id: str,
    article_id: str,
    payload: RegenerateImageRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    """Regenerate only the article featured image, capped per article by the user's plan."""
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    _require_verified_website(proj)
    row = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)
    ip_id = (payload.image_prompt_id or "").strip() or (proj.get("default_image_prompt_id") or "").strip() or None
    return await execute_featured_image_regeneration(
        st=st,
        user=user,
        proj=proj,
        article_id=(article_id or "").strip(),
        row=row,
        image_prompt_id=ip_id,
    )


@router.post("/{article_id}/schedule", status_code=200)
async def schedule_article(
    project_id: str,
    article_id: str,
    payload: ScheduleRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    _require_verified_website(proj)
    a = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)

    raw = (payload.wp_scheduled_at or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="Missing schedule time")

    # Naive datetime-local values are interpreted in the user's profile IANA timezone (normalized for legacy names).
    # Values with explicit offsets / Z are interpreted as that instant in UTC.
    try:
        user_tz = zoneinfo_for_user(user.get("timezone"))
        dt_utc = parse_schedule_input_to_utc(raw, user_tz=user_tz)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e) or "Invalid schedule time format") from None
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid schedule time format") from None

    norm_utc = dt_utc.replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")

    # Enforce minimum gap of 5 minutes from current time (UTC).
    if dt_utc < (datetime.now(timezone.utc) + timedelta(minutes=5)):
        raise HTTPException(status_code=400, detail="Scheduled time must be at least 5 minutes from now")

    wp_status = (payload.wp_status or "draft").strip().lower()
    if wp_status not in {"draft", "publish"}:
        raise HTTPException(status_code=400, detail="Invalid wp_status (draft|publish)")

    # Plan enforcement: scheduling must be enabled and consumes monthly schedule quota.
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role != "admin" and uid:
        plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
        plan = {}
        try:
            plans = st.load_plans() or {}
            plan = plans.get(plan_key) if isinstance(plans, dict) else {}
            if not isinstance(plan, dict):
                plan = {}
        except Exception:
            plan = {}
        if plan.get("allow_scheduling") is False:
            raise HTTPException(status_code=403, detail="Scheduling is not enabled for your plan.")
        if hasattr(st, "consume_scheduled_usage"):
            ok, msg = st.consume_scheduled_usage(uid, month_limit=plan.get("max_scheduled_per_month"), amount=1)
            if not ok:
                raise HTTPException(status_code=403, detail=msg or "Schedule limit reached for your plan")

    post_type = (payload.post_type or "").strip() or (proj.get("default_wp_rest_base") or "").strip() or "posts"
    # For scheduled jobs, categories default from project settings unless overridden later.
    cat_raw = (proj.get("wp_category_ids") or "").strip()

    await run_sync(
        st.update_article_fields,
        article_id,
        {
            # Store UTC timestamp string; UI can display in user timezone.
            "wp_scheduled_at": norm_utc,
            "wp_schedule_wp_status": wp_status,
            "wp_rest_base": post_type,
            "wp_schedule_error": "",
            # keep current draft/pending/published status; UI will show "scheduled" via wp_scheduled_at
            "status": (a.get("status") or "pending"),
        },
    )

    # Insert/update scheduled job row.
    #
    # IMPORTANT: avoid loading/scanning all jobs during the request (can be slow on production DBs and cause Nginx 504).
    # We use a stable job id derived from (project_id, article_id) so reschedules are O(1).
    if hasattr(st, "insert_scheduled_job") and hasattr(st, "update_scheduled_job_fields"):
        stable = hashlib.sha1(f"{project_id}:{article_id}".encode("utf-8")).hexdigest()[:20]
        job_id = f"job_{stable}"
        now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        job_updates = {
            "project_id": project_id,
            "article_id": article_id,
            "run_at": norm_utc,
            "post_type": post_type,
            "wp_status": wp_status,
            "category_ids": cat_raw,
            "writing_prompt_id": (payload.writing_prompt_id or "").strip(),
            "image_prompt_id": (payload.image_prompt_id or "").strip(),
            "generate_image": bool(payload.generate_image),
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
                await run_sync(st.insert_scheduled_job, {"id": job_id, **job_updates, "created_at": now_str})
            except Exception:
                # If insert races (already exists), just update.
                try:
                    await run_sync(st.update_scheduled_job_fields, job_id, job_updates)
                except Exception:
                    pass

        # Start background preparation immediately so the article is ready well before posting.
        # This is best-effort and does not block the schedule response.
        try:
            proj2 = proj
            art2 = a
            job2 = {"id": job_id, **job_updates}

            async def _prep() -> None:
                try:
                    await prepare_article_for_scheduled_job(st=st, jid=job_id, proj=proj2, art=art2, job=job2)
                    await run_sync(
                        st.update_scheduled_job_fields,
                        job_id,
                        {"state": "ready_to_post", "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")},
                    )
                except Exception as e:
                    err = scheduler_error_message(e)
                    await run_sync(
                        st.update_scheduled_job_fields,
                        job_id,
                        {
                            "state": "failed",
                            "last_error": err,
                            "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                        },
                    )

            asyncio.create_task(_prep())
        except Exception:
            pass
    return {
        "ok": True,
        "status": "scheduled",
        "message": "Article scheduled successfully.",
        "wp_scheduled_at": norm_utc,
        "post_type": post_type,
        "wp_status": wp_status,
    }


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
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    _require_verified_website(proj)
    a = await run_sync(_get_article_or_404, st=st, project_id=project_id, article_id=article_id)

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

    # categories
    cat_ids: list[int] = []
    for part in (category_ids or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            cat_ids.append(int(part))
        except (TypeError, ValueError):
            continue
    cat_ids = list(dict.fromkeys([x for x in cat_ids if x > 0]))[:50]

    def _markdown_to_html(raw: str) -> str:
        # Convert markdown to HTML for WordPress. This prevents raw ##/** showing up on WP.
        # We avoid "unsafe" extensions; markdown library escapes HTML by default unless raw HTML is present.
        text = (raw or "").strip()
        if not text:
            return ""
        return md.markdown(text, extensions=["extra", "sane_lists", "smarty"])

    title = (a.get("title") or "").strip()
    article_md = (a.get("article") or "").strip()
    if not title or not article_md:
        raise HTTPException(status_code=400, detail="Article title/content is required before publishing")

    content_html = _markdown_to_html(article_md)
    content_html = apply_context_links_html(content_html, links) if links else content_html

    wp = WordpressClient(site_url=wp_site_url, username=wp_username, app_password=wp_app_password)

    # Upload featured image if we have one.
    featured_media_id: int | None = None
    if image_file is not None:
        data = await image_file.read()
        if data:
            up = await wp.upload_media(filename=image_file.filename or "upload.png", content_type=image_file.content_type or "image/png", data=data)
            if isinstance(up, dict) and isinstance(up.get("id"), int):
                featured_media_id = int(up["id"])
    else:
        # If generated image exists (data URL), upload it.
        img_url = (a.get("image_url") or "").strip()
        if img_url.startswith("data:image/") and ";base64," in img_url:
            try:
                b64 = img_url.split(";base64,", 1)[1]
                data = base64.b64decode(b64, validate=False)
            except (IndexError, binascii.Error, ValueError):
                data = b""
            if data:
                up = await wp.upload_media(filename="generated.png", content_type="image/png", data=data)
                if isinstance(up, dict) and isinstance(up.get("id"), int):
                    featured_media_id = int(up["id"])

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

    # WordPress tags from our keywords (create if missing)
    kw = [str(x).strip() for x in (a.get("keywords") or []) if str(x).strip()]
    if kw:
        try:
            tag_ids = await wp.ensure_tag_ids(kw[:15], timeout=20.0)
            if tag_ids:
                payload["tags"] = tag_ids
        except Exception:
            pass

    try:
        created = await wp.post_json(f"/wp-json/wp/v2/{rest_base}", payload, timeout=90.0)
    except Exception as e:
        # Some custom post types don't support tags; retry without them.
        if "tags" in payload:
            try:
                payload.pop("tags", None)
                created = await wp.post_json(f"/wp-json/wp/v2/{rest_base}", payload, timeout=90.0)
            except Exception:
                raise HTTPException(status_code=502, detail=f"WordPress publish failed: {e}") from e
        else:
            raise HTTPException(status_code=502, detail=f"WordPress publish failed: {e}") from e

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

    return {
        "ok": True,
        "status": "published" if created_wp_status == "publish" else "draft",
        "message": "Published to WordPress successfully." if created_wp_status == "publish" else "Created draft on WordPress successfully.",
        "wp_post_id": wp_post_id,
        "wp_link": wp_link,
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
    proj = _require_project_access(st=st, user=user, project_id=project_id)
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
    proj = _require_project_access(st=st, user=user, project_id=project_id)
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
    proj = _require_project_access(st=st, user=user, project_id=project_id)
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

