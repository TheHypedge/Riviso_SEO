from __future__ import annotations

import uuid
import base64
import binascii
import html
from datetime import datetime, timedelta, timezone
import re
from zoneinfo import ZoneInfo
import asyncio

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
import markdown as md

from app.core.deps import get_current_user
from app.core.config import settings
from app.legacy.storage import get_legacy_storage_module
from app.services.article_generation import generate_article_bundle
from app.services.context_links import apply_context_links_html
from app.services.wordpress_client import WordpressClient
from app.services.scheduler import prepare_article_for_scheduled_job
from app.schemas.articles import (
    ArticleCreate,
    ArticleDetailResponse,
    ArticlePublic,
    ArticleUpdateRequest,
    BulkActionRequest,
    BulkUploadRequest,
    BulkUploadResponse,
    GenerateRequest,
    ScheduleRequest,
)

router = APIRouter(prefix="/projects/{project_id}/articles", tags=["articles"])


def _to_public(a: dict) -> ArticlePublic:
    wp_sched = (a.get("wp_scheduled_at") or "").strip()
    status_raw = ((a.get("status") or "pending").strip().lower() or "pending")
    # Back-compat with old UI: if schedule exists and not yet posted, display scheduled.
    status = "scheduled" if wp_sched else status_raw
    return ArticlePublic(
        id=(a.get("id") or "").strip(),
        project_id=(a.get("project_id") or "").strip(),
        title=(a.get("title") or "").strip(),
        status=status,
        created_at=(a.get("created_at") or "").strip() or None,
        updated_at=(a.get("updated_at") or "").strip() or None,
        posted_at=(a.get("posted_at") or "").strip() or None,
        keywords=[str(x).strip() for x in (a.get("keywords") or []) if str(x).strip()],
        focus_keyphrase=(a.get("focus_keyphrase") or "").strip() or None,
        wp_scheduled_at=wp_sched or None,
        wp_schedule_error=(a.get("wp_schedule_error") or "").strip() or None,
        wp_link=(a.get("wp_link") or "").strip() or None,
        gsc_status=(a.get("gsc_status") or "").strip() or None,
        hasBody=bool(a.get("hasBody")) if "hasBody" in a else None,
    )


def _require_project_access(*, st, user: dict, project_id: str) -> dict:
    pid = (project_id or "").strip()
    proj = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role != "admin" and (proj.get("owner_user_id") or "").strip() != uid:
        raise HTTPException(status_code=404, detail="Project not found")
    return proj


def _get_article_or_404(*, st, project_id: str, article_id: str) -> dict:
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    if not pid or not aid:
        raise HTTPException(status_code=404, detail="Not found")
    rows = st.load_articles() or []
    for a in rows:
        if not isinstance(a, dict):
            continue
        if (a.get("id") or "").strip() == aid and (a.get("project_id") or "").strip() == pid:
            return a
    raise HTTPException(status_code=404, detail="Not found")


@router.get("", response_model=list[ArticlePublic])
async def list_articles(project_id: str, user: dict = Depends(get_current_user)) -> list[ArticlePublic]:
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    if hasattr(st, "load_articles_listing_for_project"):
        rows = st.load_articles_listing_for_project(project_id, limit=5000)
    else:
        rows = [a for a in (st.load_articles() or []) if isinstance(a, dict) and (a.get("project_id") or "") == project_id]
    out = [_to_public(a) for a in rows if isinstance(a, dict)]
    out.sort(key=lambda x: (x.created_at or ""), reverse=True)
    return out


@router.post("", response_model=ArticlePublic, status_code=201)
async def create_article(
    project_id: str,
    payload: ArticleCreate,
    user: dict = Depends(get_current_user),
) -> ArticlePublic:
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)

    if len(payload.keywords) > 10:
        raise HTTPException(status_code=400, detail="Maximum 10 keywords allowed")
    keywords = [str(k).strip()[:80] for k in payload.keywords if str(k).strip()]
    keywords = keywords[:10]

    aid = str(uuid.uuid4())
    st.insert_article(
        {
            "id": aid,
            "project_id": project_id,
            "title": payload.title.strip()[:500],
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
        }
    )

    # Return minimal created row.
    return ArticlePublic(
        id=aid,
        project_id=project_id,
        title=payload.title.strip()[:500],
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
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)

    pid = (project_id or "").strip()
    ids = [str(x).strip() for x in (payload.article_ids or []) if str(x).strip()]
    ids = list(dict.fromkeys(ids))[:500]
    if not ids:
        raise HTTPException(status_code=400, detail="No articles selected")

    # Ensure ids belong to this project to avoid cross-project updates.
    allowed = set()
    rows = st.load_articles_listing_for_project(pid, limit=20000) if hasattr(st, "load_articles_listing_for_project") else (st.load_articles() or [])
    for a in rows:
        if isinstance(a, dict) and (a.get("project_id") or "") == pid:
            aid = (a.get("id") or "").strip()
            if aid:
                allowed.add(aid)
    ids = [x for x in ids if x in allowed]
    if not ids:
        return {"ok": True, "updated": 0}

    if payload.action == "delete":
        st.delete_articles_by_ids(ids)
        return {"ok": True, "deleted": len(ids)}

    if payload.action == "change_status":
        ns = (payload.new_status or "").strip().lower()
        if ns not in {"pending", "draft", "published"}:
            raise HTTPException(status_code=400, detail="Invalid new_status")
        updates = [(aid, {"status": ns}) for aid in ids]
        if hasattr(st, "bulk_update_articles"):
            st.bulk_update_articles(updates)
        else:
            for aid, u in updates:
                st.update_article_fields(aid, u)
        return {"ok": True, "updated": len(ids), "new_status": ns}

    raise HTTPException(status_code=400, detail="Unknown action")


@router.post("/bulk-upload", response_model=BulkUploadResponse, status_code=200)
async def bulk_upload_articles(
    project_id: str,
    payload: BulkUploadRequest,
    user: dict = Depends(get_current_user),
) -> BulkUploadResponse:
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)

    created_rows: list[ArticlePublic] = []
    skipped = 0
    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    for row in payload.rows or []:
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
        st.insert_article(
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
            }
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

    return BulkUploadResponse(created=len(created_rows), skipped=skipped, articles=created_rows)


@router.get("/{article_id}", response_model=ArticleDetailResponse)
async def get_article_detail(
    project_id: str,
    article_id: str,
    user: dict = Depends(get_current_user),
) -> ArticleDetailResponse:
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    a = _get_article_or_404(st=st, project_id=project_id, article_id=article_id)
    base = _to_public(a).model_dump()
    return ArticleDetailResponse(
        **base,
        article=(a.get("article") or ""),
        meta_title=(a.get("meta_title") or "").strip() or None,
        meta_description=(a.get("meta_description") or "").strip() or None,
        image_url=(a.get("image_url") or "").strip() or None,
    )


@router.patch("/{article_id}", response_model=ArticleDetailResponse)
async def update_article(
    project_id: str,
    article_id: str,
    payload: ArticleUpdateRequest,
    user: dict = Depends(get_current_user),
) -> ArticleDetailResponse:
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    _ = _get_article_or_404(st=st, project_id=project_id, article_id=article_id)

    updates: dict = {}
    if payload.title is not None:
        updates["title"] = payload.title.strip()[:500]
    if payload.keywords is not None:
        kw = [str(x).strip()[:80] for x in (payload.keywords or []) if str(x).strip()]
        updates["keywords"] = kw[:10]
    if payload.focus_keyphrase is not None:
        updates["focus_keyphrase"] = (payload.focus_keyphrase or "").strip()[:500]
    if payload.article is not None:
        updates["article"] = payload.article
    if payload.meta_title is not None:
        updates["meta_title"] = (payload.meta_title or "").strip()[:400]
    if payload.meta_description is not None:
        updates["meta_description"] = (payload.meta_description or "").strip()[:600]

    if updates:
        st.update_article_fields(article_id, updates)

    a2 = _get_article_or_404(st=st, project_id=project_id, article_id=article_id)
    base = _to_public(a2).model_dump()
    return ArticleDetailResponse(
        **base,
        article=(a2.get("article") or ""),
        meta_title=(a2.get("meta_title") or "").strip() or None,
        meta_description=(a2.get("meta_description") or "").strip() or None,
        image_url=(a2.get("image_url") or "").strip() or None,
    )


@router.post("/{article_id}/generate")
async def generate_article_and_image(
    project_id: str,
    article_id: str,
    payload: GenerateRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Stable API contract for the legacy "Generate article" panel.

    Next step: wire this to the real generation engine (OpenAI + optional image generation)
    and persist results to storage. For now, return a deterministic "not implemented"
    response so the frontend can be built safely against the contract.
    """
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    row = _get_article_or_404(st=st, project_id=project_id, article_id=article_id)

    # Resolve prompt ids: explicit override > project default > None
    writing_prompt_id = (payload.writing_prompt_id or "").strip() or (proj.get("default_prompt_id") or "").strip() or None
    image_prompt_id = (payload.image_prompt_id or "").strip() or (proj.get("default_image_prompt_id") or "").strip() or None

    def _resolve_prompt(prompts: list, pid: str | None) -> dict | None:
        if not pid:
            return None
        for p in prompts or []:
            if isinstance(p, dict) and (p.get("id") or "").strip() == pid:
                return {"id": pid, "name": (p.get("name") or "").strip(), "text": (p.get("text") or "").strip()}
        raise HTTPException(status_code=404, detail="Prompt not found")

    resolved_writing = _resolve_prompt(proj.get("prompts") or [], writing_prompt_id)
    resolved_image = _resolve_prompt(proj.get("image_prompts") or [], image_prompt_id)

    if not (settings.openai_api_key or "").strip():
        raise HTTPException(status_code=501, detail="OPENAI_API_KEY is not configured on the backend")

    title = (row.get("title") or "").strip()
    keywords = [str(x).strip() for x in (row.get("keywords") or []) if str(x).strip()]
    focus = (payload.focus_keyphrase or (row.get("focus_keyphrase") or "")).strip()

    if not title:
        raise HTTPException(status_code=400, detail="Article title is required for generation")
    if not resolved_writing:
        raise HTTPException(status_code=400, detail="No writing prompt selected and no project default set")

    gen = await generate_article_bundle(
        title=title,
        keywords=keywords,
        focus_keyphrase=focus,
        writing_prompt_text=resolved_writing["text"],
        generate_image=bool(payload.generate_image),
        image_prompt_text=(resolved_image["text"] if resolved_image else None),
    )

    updates = {
        "article": gen["article"],
        "meta_title": gen["meta_title"],
        "meta_description": gen["meta_description"],
        "generated_at": gen["generated_at"],
        "image_url": gen.get("image_url") or "",
        "status": "draft" if ((row.get("status") or "pending").strip().lower() != "published") else (row.get("status") or "published"),
    }
    st.update_article_fields(article_id, updates)

    return {
        "ok": True,
        "status": "generated",
        "message": "Article generated successfully.",
        "resolved": {
            "writing_prompt": {"id": resolved_writing["id"], "name": resolved_writing["name"]} if resolved_writing else None,
            "image_prompt": {"id": resolved_image["id"], "name": resolved_image["name"]} if resolved_image else None,
            "focus_keyphrase": focus,
            "generate_image": bool(payload.generate_image),
            "models": gen.get("models"),
        },
        "generated": {
            "article": gen["article"],
            "meta_title": gen["meta_title"],
            "meta_description": gen["meta_description"],
            "image_url": gen.get("image_url"),
        },
    }


@router.post("/{article_id}/schedule", status_code=200)
async def schedule_article(
    project_id: str,
    article_id: str,
    payload: ScheduleRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    a = _get_article_or_404(st=st, project_id=project_id, article_id=article_id)

    raw = (payload.wp_scheduled_at or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="Missing schedule time")

    # Accept "YYYY-MM-DDTHH:MM" (from datetime-local) or "YYYY-MM-DD HH:MM[:SS]".
    # Interpret the provided local time in the user's profile timezone, then store UTC for execution.
    norm_local = raw.replace("T", " ").strip()
    if len(norm_local) == 16:
        norm_local = norm_local + ":00"
    norm_local = norm_local[:19]

    try:
        naive_local = datetime.strptime(norm_local, "%Y-%m-%d %H:%M:%S")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid schedule time format") from None

    tz_name = (user.get("timezone") or "").strip() or "UTC"
    try:
        user_tz = ZoneInfo(tz_name)
    except Exception:
        user_tz = ZoneInfo("UTC")

    dt_utc = naive_local.replace(tzinfo=user_tz).astimezone(timezone.utc)
    norm_utc = dt_utc.replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")

    # Enforce minimum gap of 5 minutes from current time (UTC).
    if dt_utc < (datetime.now(timezone.utc) + timedelta(minutes=5)):
        raise HTTPException(status_code=400, detail="Scheduled time must be at least 5 minutes from now")

    wp_status = (payload.wp_status or "draft").strip().lower()
    if wp_status not in {"draft", "publish"}:
        raise HTTPException(status_code=400, detail="Invalid wp_status (draft|publish)")

    post_type = (payload.post_type or "").strip() or (proj.get("default_wp_rest_base") or "").strip() or "posts"
    # For scheduled jobs, categories default from project settings unless overridden later.
    cat_raw = (proj.get("wp_category_ids") or "").strip()

    st.update_article_fields(
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

    # Insert or update scheduled job row
    if hasattr(st, "load_scheduled_jobs") and hasattr(st, "insert_scheduled_job"):
        existing = None
        try:
            rows = st.load_scheduled_jobs(project_id=project_id)
            # If this article already has a non-completed job, overwrite it instead of creating duplicates.
            # This makes "reschedule" behave like an update.
            candidates = [
                r
                for r in (rows or [])
                if isinstance(r, dict)
                and (r.get("article_id") or "").strip() == article_id
                and (r.get("state") or "scheduled") not in {"posted", "cancelled"}
            ]
            if candidates:
                # Prefer the most recently updated/created row.
                def _stamp(x: dict) -> str:
                    return (x.get("updated_at") or x.get("created_at") or "").strip()

                candidates.sort(key=_stamp, reverse=True)
                existing = candidates[0]
        except Exception:
            existing = None
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
            "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        }
        job_id = ""
        if existing and hasattr(st, "update_scheduled_job_fields"):
            job_id = (existing.get("id") or "").strip()
            st.update_scheduled_job_fields(job_id, job_updates)
        else:
            job_id = str(uuid.uuid4())
            st.insert_scheduled_job(
                {
                    "id": job_id,
                    **job_updates,
                    "attempts": 0,
                    "last_error": "",
                    "created_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                }
            )

        # Start background preparation immediately so the article is ready well before posting.
        # This is best-effort and does not block the schedule response.
        try:
            if job_id:
                proj2 = proj
                art2 = a
                job2 = {"id": job_id, **job_updates}

                async def _prep() -> None:
                    try:
                        await prepare_article_for_scheduled_job(st=st, jid=job_id, proj=proj2, art=art2, job=job2)
                        st.update_scheduled_job_fields(job_id, {"state": "ready_to_post", "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")})
                    except Exception as e:
                        st.update_scheduled_job_fields(
                            job_id,
                            {
                                "state": "failed",
                                "last_error": str(e),
                                "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                            },
                        )

                asyncio.create_task(_prep())
        except Exception:
            # Don't fail scheduling if background prep fails to start.
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
    a = _get_article_or_404(st=st, project_id=project_id, article_id=article_id)

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
        created = await wp.post_json(f"/wp-json/wp/v2/{rest_base}", payload, timeout=45.0)
    except Exception as e:
        # Some custom post types don't support tags; retry without them.
        if "tags" in payload:
            try:
                payload.pop("tags", None)
                created = await wp.post_json(f"/wp-json/wp/v2/{rest_base}", payload, timeout=45.0)
            except Exception:
                raise HTTPException(status_code=502, detail=f"WordPress publish failed: {e}") from e
        else:
            raise HTTPException(status_code=502, detail=f"WordPress publish failed: {e}") from e

    wp_post_id = created.get("id") if isinstance(created, dict) else None
    wp_link = created.get("link") if isinstance(created, dict) else None

    updates: dict = {
        "wp_post_id": wp_post_id,
        "wp_link": wp_link or "",
        "wp_rest_base": rest_base,
        "wp_last_wp_status": payload["status"],
        "posted_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S") if payload["status"] == "publish" else (a.get("posted_at") or ""),
        "status": "published" if payload["status"] == "publish" else (a.get("status") or "draft"),
    }
    st.update_article_fields(article_id, updates)

    return {
        "ok": True,
        "status": "published" if payload["status"] == "publish" else "draft",
        "message": "Published to WordPress successfully." if payload["status"] == "publish" else "Created draft on WordPress successfully.",
        "wp_post_id": wp_post_id,
        "wp_link": wp_link,
    }

