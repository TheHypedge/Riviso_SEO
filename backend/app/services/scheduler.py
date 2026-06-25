from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone

from app.legacy.storage import get_legacy_storage_module
from app.services.wordpress_client import WordpressClient, resolve_featured_media_id
from app.services.context_links import apply_context_links_html
from app.services.shopify_product_pipeline import is_shopify_project
from app.services.wordpress_content_pipeline import is_wordpress_project
from app.services.gsc_actions import maybe_request_url_inspection
from app.services.sitemap_ping import default_sitemap_url, ping_sitemap
from app.services.to_thread import run_sync
from app.services.pipeline_streamer import (
    MSG_PUBLISH_COMPLETE,
    MSG_PUBLISH_DISPATCH,
    STAGE_COMPLETE,
    STAGE_PUBLISH_DISPATCH,
    publish_pipeline_error,
    publish_pipeline_status,
)
from app.core.config import settings


log = logging.getLogger(__name__)

_STALE_POSTING_MINUTES = 3


async def _storage(fn, /, *args, **kwargs):
    """Run a blocking storage call with Mongo retries (safe after long OpenAI work)."""
    from app.services.storage_db import call_storage

    return await run_sync(call_storage, fn, *args, **kwargs)


async def _patch_scheduled_job(st, jid: str, updates: dict) -> None:
    fn = getattr(st, "patch_scheduled_job_fields", None) or st.update_scheduled_job_fields
    u = dict(updates or {})
    u.setdefault("updated_at", datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"))
    await _storage(fn, jid, u)


async def _owner_user_dict(st, proj: dict) -> dict:
    owner_uid = (proj.get("owner_user_id") or "").strip()
    if owner_uid and hasattr(st, "get_user_by_id"):
        owner_row = await _storage(st.get_user_by_id, owner_uid)
        if isinstance(owner_row, dict):
            return owner_row
    return {"id": owner_uid, "role": "user", "subscription_type": "beta"}


def _http_detail_message(exc) -> str:
    detail = getattr(exc, "detail", None)
    if isinstance(detail, dict):
        return str(detail.get("message") or detail.get("code") or detail)
    if detail is not None:
        return str(detail)
    return str(exc) or "Generation failed"


async def _reload_project(st, project_id: str) -> dict | None:
    pid = (project_id or "").strip()
    if not pid:
        return None
    reader = getattr(st, "get_project_for_generation", None) or getattr(st, "get_project_by_id", None)
    if reader is not None:
        proj = await _storage(reader, pid)
        if isinstance(proj, dict):
            return proj
    rows = await _storage(st.load_projects)
    return next((p for p in (rows or []) if isinstance(p, dict) and (p.get("id") or "").strip() == pid), None)


async def _ensure_project_prompt_defaults(st, project_id: str, proj: dict) -> dict:
    try:
        from app.api.routes.prompts import _ensure_default_prompt
        from app.api.routes.image_prompts import _ensure_default_image_prompt

        proj = _ensure_default_prompt(st=st, project_id=project_id, proj=proj)
        proj = _ensure_default_image_prompt(st=st, project_id=project_id, proj=proj)
    except Exception:
        pass
    return proj


async def _reload_scheduled_job(st, project_id: str, job_id: str) -> dict | None:
    jid = (job_id or "").strip()
    pid = (project_id or "").strip()
    if not jid or not pid:
        return None
    rows = await _storage(st.load_scheduled_jobs, project_id=pid)
    return next((r for r in (rows or []) if isinstance(r, dict) and (r.get("id") or "").strip() == jid), None)


def _parse_job_timestamp(raw: str) -> datetime | None:
    v = (raw or "").strip()
    if not v:
        return None
    try:
        if "T" in v:
            dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        else:
            dt = datetime.strptime(v[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _normalize_wp_rest_status_local(val: object) -> str:
    if isinstance(val, str):
        return val.strip().lower()
    return str(val or "").strip().lower()


def _parse_run_at_utc(s: str) -> datetime | None:
    """Parse stored job run_at as a UTC wall-clock instant (naive string in DB is always UTC)."""
    v = (s or "").strip()
    if not v:
        return None
    try:
        dt_naive = datetime.strptime(v[:19], "%Y-%m-%d %H:%M:%S")
        return dt_naive.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _is_generation_signature_mismatch_message(raw: str) -> bool:
    text = (raw or "").strip().lower()
    if not text:
        return False
    if "image_prompt_text" in text and "unexpected keyword argument" in text:
        return True
    if "backend generation configuration mismatch" in text:
        return True
    return False


def _friendly_scheduler_error(exc: Exception) -> str:
    raw = str(exc) or exc.__class__.__name__
    if _is_generation_signature_mismatch_message(raw):
        return (
            "Scheduled preparation hit a backend version mismatch. "
            "Click Retry preparation or Re-Schedule — content generation will run again automatically."
        )
    if "unexpected keyword argument" in raw:
        return "Scheduled generation failed due to a backend configuration mismatch. Please retry preparation."
    if "OPENAI_API_KEY" in raw:
        return "OpenAI is not configured on the backend. Add OPENAI_API_KEY and retry this scheduled article."
    low = raw.lower()
    if "timed out" in low or "timeout" in low:
        return (
            "The database connection timed out during a long operation. "
            "Post Now runs in the background now — click Post Now again or use Retry preparation if the job stays failed."
        )
    if "403" in low and "wp/v2/media" in low:
        return (
            "WordPress blocked the featured image upload (403). "
            "Give the connected user upload_files permission or allow REST media in your security plugin."
        )
    if "403" in low and ("wp/v2/posts" in low or "wp-json/wp/v2" in low):
        return (
            "WordPress rejected the publish request (403 Forbidden). "
            "Confirm the connected user can create posts via the REST API and that security plugins allow wp-json/wp/v2/posts."
        )
    return raw[:1000]


def scheduler_error_message(exc: Exception) -> str:
    return _friendly_scheduler_error(exc)


def _is_retryable_generation_mismatch(job: dict) -> bool:
    raw = (job.get("last_error") or "").strip()
    if not raw:
        return False
    if _is_generation_signature_mismatch_message(raw):
        return int(job.get("attempts") or 0) < 5
    return False


async def prepare_article_for_scheduled_job(*, st, jid: str, proj: dict, art: dict, job: dict) -> dict:
    """
    Ensure article has generated content/meta and (optionally) image, saving results to storage.
    Uses the same generation pipeline as manual Generate (patch writes, integrity/humanization).
    """
    from fastapi import HTTPException

    from app.services.article_pipeline import execute_article_generation, execute_featured_image_regeneration

    aid = (art.get("id") or "").strip()
    if not aid:
        raise RuntimeError("Article not found")
    if is_shopify_project(proj):
        if not (proj.get("shopify_access_token") or "").strip():
            raise RuntimeError("Shopify store is not connected for this project. Connect Shopify in Project Settings before scheduled generation.")
    elif (proj.get("wp_verified_status") or "").strip().lower() != "connected":
        raise RuntimeError("Website is not connected for this project. Connect and verify WordPress before scheduled generation.")

    pid = (proj.get("id") or job.get("project_id") or "").strip()
    if pid:
        proj = await _ensure_project_prompt_defaults(st, pid, proj)

    needs_content = not (str(art.get("article") or "").strip())
    needs_image = not (str(art.get("image_url") or "").strip())
    generate_image = bool(job.get("generate_image", True))
    if not (needs_content or (generate_image and needs_image)):
        return art

    await _patch_scheduled_job(
        st,
        jid,
        {"state": "content_generating" if needs_content else "image_generating", "last_error": ""},
    )

    writing_prompt_id = (job.get("writing_prompt_id") or "") or (proj.get("default_prompt_id") or "") or None
    image_prompt_id = (job.get("image_prompt_id") or "") or (proj.get("default_image_prompt_id") or "") or None
    mapped_products = art.get("shopify_mapped_products") if is_shopify_project(proj) else None
    mapped_pages = art.get("wp_mapped_pages") if is_wordpress_project(proj) else None
    user = await _owner_user_dict(st, proj)

    try:
        if needs_content:
            await execute_article_generation(
                st=st,
                user=user,
                proj=proj,
                project_id=pid,
                article_id=aid,
                row=art,
                writing_prompt_id=writing_prompt_id,
                generate_image=generate_image,
                image_prompt_id=image_prompt_id,
                focus_keyphrase_override=(art.get("focus_keyphrase") or "").strip() or None,
                mapped_products=mapped_products if isinstance(mapped_products, list) else None,
                mapped_pages=mapped_pages if isinstance(mapped_pages, list) else None,
            )
        elif generate_image and needs_image:
            await execute_featured_image_regeneration(
                st=st,
                user=user,
                proj=proj,
                article_id=aid,
                row=art,
                image_prompt_id=image_prompt_id,
            )
    except HTTPException as e:
        err = _http_detail_message(e)
        await _patch_scheduled_job(st, jid, {"state": "failed", "last_error": err})
        raise RuntimeError(err) from e

    art2 = await _load_article_row(st=st, project_id=pid, article_id=aid)
    return art2 if isinstance(art2, dict) else art


def start_scheduled_job_post_now_task(*, st, jid: str, proj: dict, job: dict) -> None:
    """Queue generate-and-publish for Post Now (never block the HTTP request)."""
    job_id = (jid or "").strip()
    pid = (proj.get("id") or job.get("project_id") or "").strip()
    aid = (job.get("article_id") or "").strip()
    if not job_id or not pid or not aid:
        return

    if settings.generation_queue_enabled:
        from app.services.generation_worker import enqueue_scheduled_post_now

        enqueue_scheduled_post_now(job_id=job_id, project_id=pid, article_id=aid)
        return

    async def _run() -> None:
        try:
            fresh_proj = await _reload_project(st, pid)
            fresh_job = await _reload_scheduled_job(st, pid, job_id)
            if not isinstance(fresh_proj, dict) or not isinstance(fresh_job, dict):
                raise RuntimeError("Scheduled job or project not found")
            fresh_proj = await _ensure_project_prompt_defaults(st, pid, fresh_proj)
            await execute_scheduled_job_post_now(
                st=st,
                proj=fresh_proj,
                job=fresh_job,
                already_claimed=True,
            )
        except Exception:
            log.exception("Post now background task failed job_id=%s", job_id)

    asyncio.create_task(_run())


def start_scheduled_job_preparation_task(
    *,
    st,
    jid: str,
    proj: dict,
    art: dict,
    job: dict,
    force: bool = False,
) -> None:
    """
    Queue background generation for a scheduled job (content + image).

    Unless ``force`` is True, prep is deferred until ``run_at`` is within the configured
    lead window (see ``SCHEDULE_PREP_LEAD_MINUTES``). The scheduler loop enqueues due jobs.
    """
    from app.services.schedule_timing import is_within_scheduled_prep_window

    job_id = (jid or "").strip()
    pid = (proj.get("id") or job.get("project_id") or "").strip()
    aid = (art.get("id") or job.get("article_id") or "").strip()
    if not job_id or not pid or not aid:
        return

    run_at = (job.get("run_at") or "").strip()
    if not force and run_at and not is_within_scheduled_prep_window(run_at):
        return

    patch = getattr(st, "patch_scheduled_job_fields", None) or st.update_scheduled_job_fields
    try:
        patch(
            job_id,
            {
                "state": "content_generating",
                "last_error": "",
                "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
            },
        )
    except Exception:
        pass

    if settings.generation_queue_enabled:
        from app.services.generation_worker import enqueue_scheduled_prep

        enqueue_scheduled_prep(job_id=job_id, project_id=pid, article_id=aid)
        return

    async def _prep() -> None:
        from app.services.generation_queue import generation_slot

        try:
            async with generation_slot():
                await prepare_article_for_scheduled_job(st=st, jid=job_id, proj=proj, art=art, job=job)
            await _patch_scheduled_job(st, job_id, {"state": "ready_to_post", "last_error": ""})
        except Exception as e:
            err = scheduler_error_message(e)
            await _patch_scheduled_job(st, job_id, {"state": "failed", "last_error": err})

    asyncio.create_task(_prep())


def _build_image_loader(st, article_id: str, project_id: str = ""):
    """
    Return a callable that loads the stored featured image as a data URL.

    The manual publish route in articles.py passes this same loader to
    resolve_featured_media_id.  The scheduler must do the same so that:
    1. Disk-backed images (image_url="" / featured_image_storage="file") are
       read from local storage instead of being silently skipped.
    2. Cached HTTPS URLs (featured_image_storage="url") that may have expired
       are fetched through the storage layer which can fall back to disk.
    """
    aid = (article_id or "").strip()
    pid = (project_id or "").strip()

    def _load() -> str | None:
        # Try storage-level image URL getter first (handles all storage types).
        # Requires both project_id and article_id.
        fn = getattr(st, "get_article_image_url", None)
        if callable(fn) and pid and aid:
            try:
                result = fn(project_id=pid, article_id=aid)
                if result:
                    return result
            except Exception:
                pass
        # Fall back: read from disk if a file is present.
        file_fn = getattr(st, "featured_image_file_exists", None)
        load_fn = getattr(st, "_load_featured_image_file_as_data_url", None)
        if callable(file_fn) and callable(load_fn) and aid and file_fn(aid):
            try:
                return load_fn(aid)
            except Exception:
                pass
        return None

    return _load


async def publish_article_to_wordpress(*, st=None, proj: dict, article: dict, post_type: str, wp_status: str, category_ids: list[int]) -> dict:
    if (proj.get("wp_verified_status") or "").strip().lower() != "connected":
        raise RuntimeError("Website is not connected for this project. Connect and verify WordPress before publishing.")
    wp_site_url = (proj.get("wp_site_url") or proj.get("website_url") or "").strip()
    wp_username = (proj.get("wp_username") or "").strip()
    wp_app_password = (proj.get("wp_app_password") or "").replace(" ", "").strip()
    if not wp_site_url or not wp_username or not wp_app_password:
        raise RuntimeError("WordPress is not connected for this project")

    title = (article.get("title") or "").strip()
    body = (article.get("article") or "").strip()
    if not title or not body:
        raise RuntimeError("Article is not ready to post (missing title/content)")

    # Minimal markdown -> HTML is handled by the publish endpoint; reuse that logic by calling WP directly here.
    # Keep it simple: store markdown as-is if needed? We'll use markdown library for consistency.
    import markdown as md

    def _markdown_to_html(raw: str) -> str:
        text = (raw or "").strip()
        return md.markdown(text, extensions=["extra", "sane_lists", "smarty"]) if text else ""

    content_html = _markdown_to_html(body)

    # Context links application
    links = []
    for x in (proj.get("context_links") or []):
        if isinstance(x, dict) and (x.get("label") or "").strip() and (x.get("url") or "").strip():
            links.append({"label": (x.get("label") or "").strip(), "url": (x.get("url") or "").strip()})

    if links:
        content_html = apply_context_links_html(content_html, links)

    wp = WordpressClient(site_url=wp_site_url, username=wp_username, app_password=wp_app_password)

    # Featured image is best-effort — media 403 must not block publishing the article.
    # Build a disk/storage loader so disk-backed images (image_url="" / storage="file")
    # and expired OpenAI CDN URLs are resolved through storage before upload.
    article_id = (article.get("id") or "").strip()
    article_project_id = (article.get("project_id") or "").strip()
    _st = st or get_legacy_storage_module()
    _loader = _build_image_loader(_st, article_id, project_id=article_project_id) if article_id else None
    featured_media_id = await resolve_featured_media_id(wp, article, timeout=90.0, load_image_url=_loader)

    payload: dict = {
        "title": title[:500],
        "status": (wp_status or "draft").strip().lower(),
        "content": content_html,
        "meta": {
            "_yoast_wpseo_title": (article.get("meta_title") or "").strip()[:400],
            "_yoast_wpseo_metadesc": (article.get("meta_description") or "").strip()[:600],
            "_yoast_wpseo_focuskw": (article.get("focus_keyphrase") or "").strip()[:500],
        },
    }
    if featured_media_id is not None:
        payload["featured_media"] = featured_media_id
    if category_ids:
        payload["categories"] = category_ids

    # WordPress tags from our keywords (create if missing)
    kw = [str(x).strip() for x in (article.get("keywords") or []) if str(x).strip()]
    if kw:
        try:
            tag_ids = await wp.ensure_tag_ids(kw[:15], timeout=20.0)
            if tag_ids:
                payload["tags"] = tag_ids
        except Exception:
            pass

    from app.services.wordpress_publish import publish_post_to_wordpress

    created = await publish_post_to_wordpress(wp, post_type=post_type, payload=payload)
    return created


async def publish_article_to_shopify_scheduled(
    *,
    st=None,
    proj: dict,
    article: dict,
    blog_id: int | None = None,
    publish_now: bool = False,
) -> dict:
    """Publish (or update) a scheduled article to a Shopify blog."""
    from app.services.shopify_client import ShopifyClient
    from app.services.shopify_article_image import (
        build_shopify_article_image_payload,
        shopify_article_has_featured_image,
    )
    from app.api.routes.articles import _article_markdown_to_html

    shop = (proj.get("shopify_shop") or "").strip()
    token = (proj.get("shopify_access_token") or "").strip()
    if not shop or not token:
        raise RuntimeError("Shopify store is not connected for this project.")

    title = (article.get("title") or "").strip()
    body = (article.get("article") or "").strip()
    if not title or not body:
        raise RuntimeError("Article is not ready to post (missing title/content)")

    client = ShopifyClient(shop=shop, access_token=token)

    # Resolve blog_id: caller → stored on article → first catalog blog → live API.
    if blog_id is None:
        stored_bid = article.get("shopify_blog_id")
        if stored_bid and str(stored_bid).strip().isdigit():
            blog_id = int(str(stored_bid).strip())
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
        raise RuntimeError(
            "No Shopify blog found. Add a blog in Shopify Admin → Online Store → Blog posts "
            "and sync the catalog before scheduling."
        )

    content_html = _article_markdown_to_html(body)
    tags = ", ".join([str(x).strip() for x in (article.get("keywords") or []) if str(x).strip()][:20])
    image_payload = await build_shopify_article_image_payload(article, alt=title)

    article_body: dict = {
        "title": title[:255],
        "body_html": content_html,
        "tags": tags,
        "published": publish_now,
    }
    if image_payload:
        article_body["image"] = image_payload

    # If this article already has a Shopify ID, update it instead of creating a duplicate.
    existing_id_raw = article.get("shopify_article_id")
    existing_id: int | None = int(str(existing_id_raw).strip()) if existing_id_raw and str(existing_id_raw).strip().isdigit() else None
    existing_blog = article.get("shopify_blog_id")
    effective_blog_id = int(str(existing_blog).strip()) if existing_blog and str(existing_blog).strip().isdigit() else blog_id

    if existing_id:
        response = await client.put_json(
            f"/blogs/{effective_blog_id}/articles/{existing_id}.json",
            payload={"article": article_body},
        )
    else:
        response = await client.post_json(
            f"/blogs/{blog_id}/articles.json",
            payload={"article": article_body},
        )

    art = response.get("article") if isinstance(response, dict) else None
    if not isinstance(art, dict):
        raise RuntimeError("Shopify publish failed: invalid response from Shopify API")

    shopify_article_id = art.get("id") or existing_id
    if image_payload and shopify_article_id and not shopify_article_has_featured_image(art):
        try:
            updated = await client.put_json(
                f"/blogs/{effective_blog_id}/articles/{shopify_article_id}.json",
                payload={"article": {"image": image_payload}},
            )
            art_upd = updated.get("article") if isinstance(updated, dict) else None
            if isinstance(art_upd, dict):
                art = art_upd
        except Exception:
            log.warning("Scheduler Shopify: featured image PUT failed article_id=%s", article.get("id"), exc_info=True)

    handle = (art.get("handle") or "").strip()
    catalog2 = proj.get("shopify_catalog") if isinstance(proj.get("shopify_catalog"), dict) else {}
    blogs2 = catalog2.get("blogs") if isinstance(catalog2.get("blogs"), list) else []
    blog_handle = next(
        ((b.get("handle") or "") for b in blogs2 if isinstance(b, dict) and str(b.get("id") or "") == str(effective_blog_id or blog_id)),
        "",
    )
    base = (proj.get("website_url") or "").strip().rstrip("/") or f"https://{shop}"
    if not base.startswith("http"):
        base = f"https://{shop}"
    link = f"{base}/blogs/{blog_handle}/{handle}" if handle and blog_handle else (
        f"https://{shop}/admin/blogs/{blog_id}/articles/{shopify_article_id}" if shopify_article_id else ""
    )

    return {
        "shopify_article_id": shopify_article_id,
        "shopify_blog_id": effective_blog_id or blog_id,
        "shopify_link": link,
        "status": "published" if publish_now else "draft",
    }


def _parse_job_category_ids(job: dict) -> list[int]:
    cats: list[int] = []
    raw = (job.get("category_ids") or "").strip()
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            cats.append(int(part))
        except (TypeError, ValueError):
            continue
    return list(dict.fromkeys([x for x in cats if x > 0]))[:50]


async def _load_scheduled_job_row(*, st, project_id: str, job_id: str) -> dict | None:
    pid = (project_id or "").strip()
    jid = (job_id or "").strip()
    if not pid or not jid:
        return None
    rows = await run_sync(st.load_scheduled_jobs, project_id=pid) if hasattr(st, "load_scheduled_jobs") else []
    return next((r for r in (rows or []) if isinstance(r, dict) and (r.get("id") or "").strip() == jid), None)


async def _wait_for_scheduled_job_prep(*, st, project_id: str, job_id: str, timeout_s: float = 300) -> dict:
    """Block until background prep finishes (ready/scheduled) or fails."""
    deadline = time.monotonic() + max(30.0, timeout_s)
    last_state = ""
    while time.monotonic() < deadline:
        row = await _load_scheduled_job_row(st=st, project_id=project_id, job_id=job_id)
        if not isinstance(row, dict):
            raise RuntimeError("Scheduled job not found")
        state = (row.get("state") or "").strip().lower()
        last_state = state
        if state in {"ready_to_post", "scheduled"}:
            return row
        if state == "failed":
            err = (row.get("last_error") or "").strip() or "Article preparation failed"
            raise RuntimeError(err)
        if state == "posted":
            return row
        await asyncio.sleep(4)
    raise RuntimeError(
        f"Timed out waiting for article generation (last state: {last_state or 'unknown'}). Try again in a minute."
    )


async def _load_article_row(*, st, project_id: str, article_id: str) -> dict | None:
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    if not pid or not aid:
        return None
    if hasattr(st, "get_article"):
        art = await _storage(st.get_article, project_id=pid, article_id=aid)
        return art if isinstance(art, dict) else None
    rows = await _storage(st.load_articles)
    return next(
        (
            a
            for a in (rows or [])
            if isinstance(a, dict) and (a.get("id") or "").strip() == aid and (a.get("project_id") or "").strip() == pid
        ),
        None,
    )


async def execute_scheduled_job_post_now(*, st, proj: dict, job: dict, already_claimed: bool = False) -> dict:
    """
    Post a scheduled job immediately: generate content/image when missing, then publish to WordPress.
    When ``already_claimed`` is True the job is already in ``posting``; skip re-claim.
    """
    from app.services.generation_queue import generation_slot

    pid = (proj.get("id") or job.get("project_id") or "").strip()
    jid = (job.get("id") or "").strip()
    aid = (job.get("article_id") or "").strip()
    if not jid or not pid or not aid:
        raise RuntimeError("Invalid scheduled job")

    proj = await _ensure_project_prompt_defaults(st, pid, proj)

    state = (job.get("state") or "scheduled").strip().lower()
    if state in {"posted", "cancelled"}:
        raise RuntimeError(f"Cannot post a job in state '{state}'")
    if not already_claimed and state == "posting":
        updated_raw = str(job.get("updated_at") or job.get("last_attempt_at") or "")
        ts = _parse_job_timestamp(updated_raw)
        stale = ts is None or ts <= datetime.now(timezone.utc) - timedelta(minutes=_STALE_POSTING_MINUTES)
        if not stale:
            raise RuntimeError("This article is already being published. Wait a moment and refresh.")
        await _storage(
            st.update_scheduled_job_fields,
            jid,
            {
                "state": "scheduled",
                "last_error": "",
                "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
            },
        )
        state = "scheduled"
        job = {**job, "state": "scheduled", "last_error": ""}

    if state in {"content_generating", "image_generating"}:
        job = await _wait_for_scheduled_job_prep(st=st, project_id=pid, job_id=jid)
        state = (job.get("state") or "").strip().lower()

    art = await _load_article_row(st=st, project_id=pid, article_id=aid)
    if not art:
        raise RuntimeError("Article not found")

    _is_shopify = is_shopify_project(proj)
    if _is_shopify:
        existing_shopify_id = str(art.get("shopify_article_id") or "").strip()
        if existing_shopify_id:
            shopify_link = str(art.get("shopify_link") or job.get("shopify_link") or "")[:2000]
            await _storage(
                st.update_scheduled_job_fields,
                jid,
                {
                    "state": "posted",
                    "shopify_article_id": existing_shopify_id,
                    "shopify_link": shopify_link,
                    "last_error": "",
                    "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                },
            )
            return {
                "ok": True,
                "status": "posted",
                "message": "Article is already on Shopify.",
                "shopify_article_id": int(existing_shopify_id) if existing_shopify_id.isdigit() else existing_shopify_id,
                "shopify_link": shopify_link or None,
            }
    else:
        existing_wp_post_id = str(art.get("wp_post_id") or "").strip()
        if existing_wp_post_id:
            wp_link = str(art.get("wp_link") or job.get("wp_link") or "")[:2000]
            await _storage(
                st.update_scheduled_job_fields,
                jid,
                {
                    "state": "posted",
                    "wp_post_id": existing_wp_post_id,
                    "wp_link": wp_link,
                    "last_error": "",
                    "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                },
            )
            return {
                "ok": True,
                "status": "posted",
                "message": "Article is already on WordPress.",
                "wp_post_id": int(existing_wp_post_id) if existing_wp_post_id.isdigit() else existing_wp_post_id,
                "wp_link": wp_link or None,
            }

    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    if not already_claimed:
        allowed_claim = ["scheduled", "ready_to_post", "failed"]
        if hasattr(st, "claim_scheduled_job_for_posting"):
            claimed = await _storage(
                st.claim_scheduled_job_for_posting,
                jid,
                allowed_claim,
                now_str=now_str,
                target_state="posting",
            )
        else:
            claimed = True
            await _storage(
                st.update_scheduled_job_fields,
                jid,
                {"state": "posting", "updated_at": now_str, "last_error": ""},
            )
        if not claimed:
            raise RuntimeError("Could not claim this job for publishing — another process may be posting it now.")

    try:
        needs_generation = not (str(art.get("article") or "").strip())
        if needs_generation or state == "failed":
            async with generation_slot():
                art = await prepare_article_for_scheduled_job(st=st, jid=jid, proj=proj, art=art, job=job)
            reloaded = await _load_article_row(st=st, project_id=pid, article_id=aid)
            if reloaded:
                art = reloaded

        if _is_shopify:
            post_prep_shopify_id = str(art.get("shopify_article_id") or "").strip()
            if post_prep_shopify_id:
                shopify_link = str(art.get("shopify_link") or "")[:2000]
                await _storage(
                    st.update_scheduled_job_fields,
                    jid,
                    {
                        "state": "posted",
                        "shopify_article_id": post_prep_shopify_id,
                        "shopify_link": shopify_link,
                        "last_error": "",
                        "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                    },
                )
                return {
                    "ok": True,
                    "status": "posted",
                    "message": "Article is already on Shopify.",
                    "shopify_article_id": int(post_prep_shopify_id) if post_prep_shopify_id.isdigit() else post_prep_shopify_id,
                    "shopify_link": shopify_link or None,
                }
        else:
            post_prep_wp_post_id = str(art.get("wp_post_id") or "").strip()
            if post_prep_wp_post_id:
                wp_link = str(art.get("wp_link") or "")[:2000]
                await _storage(
                    st.update_scheduled_job_fields,
                    jid,
                    {
                        "state": "posted",
                        "wp_post_id": post_prep_wp_post_id,
                        "wp_link": wp_link,
                        "last_error": "",
                        "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                    },
                )
                return {
                    "ok": True,
                    "status": "posted",
                    "message": "Article is already on WordPress.",
                    "wp_post_id": int(post_prep_wp_post_id) if post_prep_wp_post_id.isdigit() else post_prep_wp_post_id,
                    "wp_link": wp_link or None,
                }

        title = (art.get("title") or "").strip()
        body = (art.get("article") or "").strip()
        if not title or not body:
            raise RuntimeError("Article generation did not finish — title or content is still missing.")

        await publish_pipeline_status(aid, MSG_PUBLISH_DISPATCH, STAGE_PUBLISH_DISPATCH)

        if _is_shopify:
            shopify_result = await publish_article_to_shopify_scheduled(
                st=st,
                proj=proj,
                article=art,
                publish_now=(job.get("wp_status") or "draft") == "publish",
            )
            shopify_article_id = shopify_result.get("shopify_article_id")
            shopify_link = shopify_result.get("shopify_link") or ""
            shopify_pub_status = shopify_result.get("status") or "draft"
            await _storage(
                st.update_scheduled_job_fields,
                jid,
                {
                    "state": "posted",
                    "shopify_article_id": shopify_article_id,
                    "shopify_link": shopify_link,
                    "last_error": "",
                    "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                },
            )
            await _storage(
                st.update_article_fields,
                aid,
                {
                    "shopify_article_id": shopify_article_id,
                    "shopify_blog_id": shopify_result.get("shopify_blog_id"),
                    "shopify_link": shopify_link,
                    "shopify_scheduled_at": "",
                    "shopify_schedule_error": "",
                    "posted_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
                    if shopify_pub_status == "published"
                    else (art.get("posted_at") or ""),
                    "status": shopify_pub_status,
                },
            )
            msg = "Published to Shopify." if shopify_pub_status == "published" else "Saved to Shopify as draft."
            if needs_generation:
                msg = f"Generated content and {msg[0].lower()}{msg[1:]}"
            await publish_pipeline_status(aid, MSG_PUBLISH_COMPLETE, STAGE_COMPLETE)
            return {
                "ok": True,
                "status": "posted",
                "message": msg,
                "shopify_article_id": shopify_article_id,
                "shopify_link": shopify_link or None,
            }
        else:
            cats = _parse_job_category_ids(job)
            created = await publish_article_to_wordpress(
                st=st,
                proj=proj,
                article=art,
                post_type=(job.get("post_type") or "posts"),
                wp_status=(job.get("wp_status") or "draft"),
                category_ids=cats,
            )

            wp_post_id = created.get("id")
            wp_link = created.get("link") or ""
            created_wp_status = _normalize_wp_rest_status_local(created.get("status")) or _normalize_wp_rest_status_local(
                job.get("wp_status")
            )
            await _storage(
                st.update_scheduled_job_fields,
                jid,
                {
                    "state": "posted",
                    "wp_post_id": wp_post_id,
                    "wp_link": wp_link,
                    "last_error": "",
                    "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                },
            )
            await _storage(
                st.update_article_fields,
                aid,
                {
                    "wp_post_id": wp_post_id,
                    "wp_link": wp_link,
                    "wp_rest_base": (job.get("post_type") or "posts"),
                    "wp_last_wp_status": created_wp_status or "draft",
                    "wp_scheduled_at": "",
                    "wp_schedule_error": "",
                    "posted_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
                    if created_wp_status == "publish"
                    else (art.get("posted_at") or ""),
                    "status": "published" if created_wp_status == "publish" else (art.get("status") or "draft"),
                    "wp_category_ids": (job.get("category_ids") or ""),
                },
            )

            try:
                await maybe_request_url_inspection(
                    st=st,
                    proj=proj,
                    live_url=str(wp_link or ""),
                    wp_status=created_wp_status or "",
                    article_id=aid,
                )
            except Exception:
                pass
            try:
                if created_wp_status == "publish":
                    wp_site_url = (proj.get("wp_site_url") or proj.get("website_url") or "").strip()
                    asyncio.create_task(ping_sitemap(sitemap_url=default_sitemap_url(wp_site_url=wp_site_url)))
            except Exception:
                pass

            msg = "Published to WordPress." if created_wp_status == "publish" else "Saved to WordPress as draft."
            if needs_generation:
                msg = f"Generated content and {msg[0].lower()}{msg[1:]}"
            await publish_pipeline_status(aid, MSG_PUBLISH_COMPLETE, STAGE_COMPLETE)
            return {
                "ok": True,
                "status": "posted",
                "message": msg,
                "wp_post_id": wp_post_id,
                "wp_link": wp_link or None,
            }
    except Exception as e:
        err = scheduler_error_message(e)
        try:
            await publish_pipeline_error(aid, f"Publish failed: {err[:400]}")
        except Exception:
            pass
        try:
            await _storage(
                st.update_scheduled_job_fields,
                jid,
                {
                    "state": "failed",
                    "last_error": err,
                    "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                },
            )
        except Exception:
            pass
        raise RuntimeError(err) from e


async def _heal_premature_generating_jobs(*, st, now: datetime) -> None:
    """Reset far-future jobs stuck in generating state after legacy immediate bulk enqueue."""
    from app.services.schedule_timing import is_within_scheduled_prep_window

    if not hasattr(st, "load_scheduled_jobs"):
        return
    try:
        rows = await run_sync(st.load_scheduled_jobs, project_id=None, limit=500)
    except TypeError:
        rows = await run_sync(st.load_scheduled_jobs, project_id=None)
    for j in rows or []:
        if not isinstance(j, dict):
            continue
        st_name = (j.get("state") or "").strip().lower()
        if st_name not in {"content_generating", "image_generating"}:
            continue
        run_at = (j.get("run_at") or "").strip()
        if not run_at or is_within_scheduled_prep_window(run_at, now=now):
            continue
        jid = (j.get("id") or "").strip()
        if not jid:
            continue
        try:
            await run_sync(
                st.update_scheduled_job_fields,
                jid,
                {
                    "state": "scheduled",
                    "last_error": "",
                    "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                },
            )
        except Exception:
            pass


async def _dispatch_due_prep_jobs(*, st, now: datetime) -> None:
    """Enqueue prep for scheduled jobs whose publish time is within the lead window."""
    from app.services.generation_worker import enqueue_scheduled_prep
    from app.services.schedule_timing import is_within_scheduled_prep_window, prep_dispatch_before_utc_str

    if not hasattr(st, "load_scheduled_jobs_due_for_prep"):
        return
    before = prep_dispatch_before_utc_str(now=now)
    lim = max(1, int(getattr(settings, "scheduler_prep_dispatch_limit", 30) or 30))
    try:
        rows = await run_sync(
            st.load_scheduled_jobs_due_for_prep,
            due_before_utc_str=before,
            limit=lim,
        )
    except Exception:
        return
    for j in rows or []:
        if not isinstance(j, dict):
            continue
        jid = (j.get("id") or "").strip()
        pid = (j.get("project_id") or "").strip()
        aid = (j.get("article_id") or "").strip()
        run_at = (j.get("run_at") or "").strip()
        if not jid or not pid or not aid or not run_at:
            continue
        if not is_within_scheduled_prep_window(run_at, now=now):
            continue
        try:
            enqueue_scheduled_prep(job_id=jid, project_id=pid, article_id=aid)
        except Exception:
            log.debug("Prep enqueue skipped job_id=%s", jid, exc_info=True)


async def scheduler_loop(*, poll_seconds: float = 10.0) -> None:
    """
    In-process scheduler loop.
    Dev-friendly: polls scheduled_jobs and posts due items.
    For production: move to a dedicated worker.
    """
    import time as _time
    _TRIAL_REMINDER_INTERVAL = 3600.0  # check trial milestones once per hour
    _last_trial_reminder_check = 0.0

    # When Mongo/storage is temporarily unavailable, avoid noisy tracebacks every poll.
    # Back off with a capped retry delay, and throttle logs.
    consecutive_storage_failures = 0
    last_storage_error_log_at = 0.0

    while True:
        try:
            st = get_legacy_storage_module()
            try:
                now = datetime.now(timezone.utc)
                now_str = now.strftime("%Y-%m-%d %H:%M:%S")
                if hasattr(st, "load_due_scheduled_jobs"):
                    jobs = await run_sync(
                        st.load_due_scheduled_jobs,
                        due_before_utc_str=now_str,
                        states=["scheduled", "ready_to_post", "failed"],
                        limit=int(settings.scheduler_due_jobs_limit or 200),
                    )
                    # Heal pass: include recent failed rows even if not yet due.
                    try:
                        failed_rows = await run_sync(
                            st.load_scheduled_jobs,
                            state="failed",
                            limit=50,
                        )
                    except TypeError:
                        failed_rows = []
                    seen = {(j.get("id") or "").strip() for j in jobs or [] if isinstance(j, dict)}
                    for fj in failed_rows or []:
                        if isinstance(fj, dict):
                            fid = (fj.get("id") or "").strip()
                            if fid and fid not in seen:
                                jobs.append(fj)
                                seen.add(fid)
                elif hasattr(st, "load_scheduled_jobs"):
                    jobs = await run_sync(st.load_scheduled_jobs, project_id=None)
                else:
                    jobs = []
                consecutive_storage_failures = 0
                await _heal_premature_generating_jobs(st=st, now=now)
                await _dispatch_due_prep_jobs(st=st, now=now)
            except Exception as e:
                consecutive_storage_failures += 1
                now_mono = time.monotonic()
                if now_mono - last_storage_error_log_at >= 60.0:
                    last_storage_error_log_at = now_mono
                    log.warning(
                        "Scheduler storage unavailable (will retry, failures=%s): %s",
                        consecutive_storage_failures,
                        str(e),
                    )
                delay = min(120.0, max(float(poll_seconds), 2.0) * (2 ** min(consecutive_storage_failures, 6)))
                await asyncio.sleep(delay)
                continue

            # Heal failed rows when the article is already on WordPress (e.g. legacy media 403).
            for j in jobs or []:
                if not isinstance(j, dict) or (j.get("state") or "").strip().lower() != "failed":
                    continue
                jid_heal = (j.get("id") or "").strip()
                pid_heal = (j.get("project_id") or "").strip()
                aid_heal = (j.get("article_id") or "").strip()
                if not jid_heal or not pid_heal or not aid_heal:
                    continue
                wp_id_heal = str(j.get("wp_post_id") or "").strip()
                if not wp_id_heal:
                    try:
                        arows_heal = (
                            await run_sync(st.load_articles_listing_for_project, pid_heal, limit=5000)
                            if hasattr(st, "load_articles_listing_for_project")
                            else await run_sync(st.load_articles)
                        )
                        art_heal = next(
                            (
                                a
                                for a in (arows_heal or [])
                                if isinstance(a, dict) and (a.get("id") or "").strip() == aid_heal
                            ),
                            None,
                        )
                        wp_id_heal = str((art_heal or {}).get("wp_post_id") or "").strip()
                        wp_link_heal = str((art_heal or {}).get("wp_link") or j.get("wp_link") or "")[:2000]
                    except Exception:
                        wp_link_heal = str(j.get("wp_link") or "")[:2000]
                else:
                    wp_link_heal = str(j.get("wp_link") or "")[:2000]
                if wp_id_heal:
                    await run_sync(
                        st.update_scheduled_job_fields,
                        jid_heal,
                        {
                            "state": "posted",
                            "wp_post_id": wp_id_heal,
                            "wp_link": wp_link_heal,
                            "last_error": "",
                            "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                        },
                    )

            for j in jobs or []:
                if not isinstance(j, dict):
                    continue
                # A job can be "ready_to_post" if background preparation finished early.
                # Known generation-mismatch failures are retryable after deploy so old
                # failed live jobs do not stay permanently stuck.
                state = (j.get("state") or "scheduled").strip().lower()
                retry_failed = state == "failed" and _is_retryable_generation_mismatch(j)
                if state not in {"scheduled", "ready_to_post"} and not retry_failed:
                    continue
                run_at = _parse_run_at_utc(j.get("run_at") or "")
                if not run_at or run_at > now:
                    continue

                jid = (j.get("id") or "").strip()
                pid = (j.get("project_id") or "").strip()
                aid = (j.get("article_id") or "").strip()
                if not jid or not pid or not aid:
                    continue

                # Atomically claim the job for this worker. If another worker
                # (or the manual "Post Now" path) has already claimed it, we
                # skip and let the winner finish. This is what prevents
                # duplicate WordPress posts when multiple processes poll.
                allowed_claim_states = ["scheduled", "ready_to_post"]
                if retry_failed:
                    allowed_claim_states.append("failed")
                now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
                if hasattr(st, "claim_scheduled_job_for_posting"):
                    claimed = await run_sync(
                        st.claim_scheduled_job_for_posting,
                        jid,
                        allowed_claim_states,
                        now_str=now_str,
                        target_state="posting",
                    )
                else:
                    # Backward-compat fallback: best-effort non-atomic claim.
                    await run_sync(
                        st.update_scheduled_job_fields,
                        jid,
                        {
                            "state": "posting",
                            "updated_at": now_str,
                            "attempts": int(j.get("attempts") or 0) + 1,
                            "last_attempt_at": now_str,
                            "last_error": "",
                        },
                    )
                    claimed = True
                if not claimed:
                    continue

                try:
                    # Point lookups — avoid loading all projects/articles each tick.
                    if hasattr(st, "get_project_for_generation") or hasattr(st, "get_project_by_id"):
                        proj = await run_sync(
                            getattr(st, "get_project_for_generation", None) or st.get_project_by_id, pid
                        )
                    else:
                        prows = await run_sync(st.load_projects)
                        proj = next(
                            (p for p in (prows or []) if isinstance(p, dict) and (p.get("id") or "") == pid),
                            None,
                        )
                    if not proj:
                        raise RuntimeError("Project not found")
                    if hasattr(st, "get_article"):
                        art = await run_sync(st.get_article, project_id=pid, article_id=aid)
                    else:
                        arows = await run_sync(st.load_articles)
                        art = next(
                            (
                                a
                                for a in (arows or [])
                                if isinstance(a, dict)
                                and (a.get("id") or "") == aid
                                and (a.get("project_id") or "") == pid
                            ),
                            None,
                        )
                    if not art:
                        raise RuntimeError("Article not found")

                    _is_shopify_job = is_shopify_project(proj)

                    # Defensive double-post guard: if already published, do NOT create a duplicate.
                    if _is_shopify_job:
                        existing_shopify_id = str(art.get("shopify_article_id") or "").strip()
                        if existing_shopify_id:
                            log.info(
                                "Scheduled job=%s skipped re-posting because article id=%s already has shopify_article_id=%s.",
                                jid,
                                aid,
                                existing_shopify_id,
                            )
                            await run_sync(
                                st.update_scheduled_job_fields,
                                jid,
                                {
                                    "state": "posted",
                                    "shopify_article_id": existing_shopify_id,
                                    "shopify_link": str(art.get("shopify_link") or "").strip(),
                                    "last_error": "",
                                    "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                                },
                            )
                            continue
                    else:
                        existing_wp_post_id = str(art.get("wp_post_id") or "").strip()
                        existing_wp_link = str(art.get("wp_link") or "").strip()
                        if existing_wp_post_id:
                            log.info(
                                "Scheduled job=%s skipped re-posting because article id=%s already has wp_post_id=%s.",
                                jid,
                                aid,
                                existing_wp_post_id,
                            )
                            await run_sync(
                                st.update_scheduled_job_fields,
                                jid,
                                {
                                    "state": "posted",
                                    "wp_post_id": existing_wp_post_id,
                                    "wp_link": existing_wp_link,
                                    "last_error": "",
                                    "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                                },
                            )
                            continue

                    # If article isn't generated yet, generate it now using scheduled prompts/defaults.
                    art = await prepare_article_for_scheduled_job(st=st, jid=jid, proj=proj, art=art, job=j)

                    # Double-check after prep — another worker / manual publish might have completed.
                    if _is_shopify_job:
                        post_prep_shopify_id = str(art.get("shopify_article_id") or "").strip()
                        if post_prep_shopify_id:
                            log.info(
                                "Scheduled job=%s skipped re-posting because article id=%s gained shopify_article_id=%s during prep.",
                                jid,
                                aid,
                                post_prep_shopify_id,
                            )
                            await run_sync(
                                st.update_scheduled_job_fields,
                                jid,
                                {
                                    "state": "posted",
                                    "shopify_article_id": post_prep_shopify_id,
                                    "shopify_link": str(art.get("shopify_link") or "")[:2000],
                                    "last_error": "",
                                    "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                                },
                            )
                            continue
                    else:
                        post_prep_wp_post_id = str(art.get("wp_post_id") or "").strip()
                        if post_prep_wp_post_id:
                            log.info(
                                "Scheduled job=%s skipped re-posting because article id=%s gained wp_post_id=%s during prep.",
                                jid,
                                aid,
                                post_prep_wp_post_id,
                            )
                            await run_sync(
                                st.update_scheduled_job_fields,
                                jid,
                                {
                                    "state": "posted",
                                    "wp_post_id": post_prep_wp_post_id,
                                    "wp_link": str(art.get("wp_link") or "")[:2000],
                                    "last_error": "",
                                    "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                                },
                            )
                            continue

                    # Stay in "posting" (NOT "ready_to_post") so a second
                    # worker can't reclaim the job during this short window.
                    await run_sync(
                        st.update_scheduled_job_fields,
                        jid,
                        {
                            "state": "posting",
                            "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                        },
                    )

                    if _is_shopify_job:
                        shopify_result = await publish_article_to_shopify_scheduled(
                            st=st,
                            proj=proj,
                            article=art,
                            publish_now=(j.get("wp_status") or "draft") == "publish",
                        )
                        shopify_article_id = shopify_result.get("shopify_article_id")
                        shopify_link = shopify_result.get("shopify_link") or ""
                        shopify_pub_status = shopify_result.get("status") or "draft"
                        await run_sync(
                            st.update_scheduled_job_fields,
                            jid,
                            {
                                "state": "posted",
                                "shopify_article_id": shopify_article_id,
                                "shopify_link": shopify_link,
                                "last_error": "",
                                "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                            },
                        )
                        ok_article = await run_sync(
                            st.update_article_fields,
                            aid,
                            {
                                "shopify_article_id": shopify_article_id,
                                "shopify_blog_id": shopify_result.get("shopify_blog_id"),
                                "shopify_link": shopify_link,
                                "shopify_scheduled_at": "",
                                "shopify_schedule_error": "",
                                "posted_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
                                if shopify_pub_status == "published"
                                else (art.get("posted_at") or ""),
                                "status": shopify_pub_status,
                            },
                        )
                        if not ok_article:
                            log.warning(
                                "Scheduled Shopify post wrote job=%s as posted but article id=%s was not found in DB.",
                                jid,
                                aid,
                            )
                    else:
                        # categories
                        cats: list[int] = []
                        raw = (j.get("category_ids") or "").strip()
                        for part in raw.split(","):
                            part = part.strip()
                            if not part:
                                continue
                            try:
                                cats.append(int(part))
                            except (TypeError, ValueError):
                                continue
                        cats = list(dict.fromkeys([x for x in cats if x > 0]))[:50]

                        created = await publish_article_to_wordpress(
                            st=st,
                            proj=proj,
                            article=art,
                            post_type=(j.get("post_type") or "posts"),
                            wp_status=(j.get("wp_status") or "draft"),
                            category_ids=cats,
                        )

                        wp_post_id = created.get("id")
                        wp_link = created.get("link") or ""
                        created_wp_status = _normalize_wp_rest_status_local(created.get("status")) or _normalize_wp_rest_status_local(
                            j.get("wp_status")
                        )
                        await run_sync(
                            st.update_scheduled_job_fields,
                            jid,
                            {
                                "state": "posted",
                                "wp_post_id": wp_post_id,
                                "wp_link": wp_link,
                                "last_error": "",
                                "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                            },
                        )
                        ok_article = await run_sync(
                            st.update_article_fields,
                            aid,
                            {
                                "wp_post_id": wp_post_id,
                                "wp_link": wp_link,
                                "wp_rest_base": (j.get("post_type") or "posts"),
                                "wp_last_wp_status": created_wp_status or "draft",
                                "wp_scheduled_at": "",
                                "wp_schedule_error": "",
                                "posted_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
                                if created_wp_status == "publish"
                                else (art.get("posted_at") or ""),
                                "status": "published" if created_wp_status == "publish" else (art.get("status") or "draft"),
                                "wp_category_ids": (j.get("category_ids") or ""),
                            },
                        )
                        if not ok_article:
                            log.warning(
                                "Scheduled post wrote job=%s as posted but article id=%s was not found in DB to update (check article_id / project_id).",
                                jid,
                                aid,
                            )

                        # Best-effort: Search Console URL Inspection after live publish.
                        try:
                            await maybe_request_url_inspection(
                                st=st,
                                proj=proj,
                                live_url=str(wp_link or ""),
                                wp_status=created_wp_status or "",
                                article_id=aid,
                            )
                        except Exception:
                            pass

                        # Best-effort: ping sitemap after live publish for discovery.
                        try:
                            if created_wp_status == "publish":
                                wp_site_url = (proj.get("wp_site_url") or proj.get("website_url") or "").strip()
                                asyncio.create_task(ping_sitemap(sitemap_url=default_sitemap_url(wp_site_url=wp_site_url)))
                        except Exception:
                            pass
                except Exception as e:
                    log.exception("Scheduled job failed jid=%s", jid)
                    # If the post already succeeded on the platform, do not leave the job as failed.
                    reconciled = False
                    try:
                        arows = await run_sync(st.load_articles_listing_for_project, pid, limit=5000) if hasattr(
                            st, "load_articles_listing_for_project"
                        ) else await run_sync(st.load_articles)
                        art_now = next(
                            (
                                a
                                for a in (arows or [])
                                if isinstance(a, dict)
                                and (a.get("id") or "").strip() == aid
                                and (a.get("project_id") or "").strip() == pid
                            ),
                            None,
                        )
                        if art_now and _is_shopify_job:
                            shopify_id = str((art_now).get("shopify_article_id") or j.get("shopify_article_id") or "").strip()
                            if shopify_id:
                                await run_sync(
                                    st.update_scheduled_job_fields,
                                    jid,
                                    {
                                        "state": "posted",
                                        "shopify_article_id": shopify_id,
                                        "shopify_link": str(art_now.get("shopify_link") or j.get("shopify_link") or "")[:2000],
                                        "last_error": "",
                                        "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                                    },
                                )
                                reconciled = True
                        elif art_now:
                            wp_id = str((art_now).get("wp_post_id") or j.get("wp_post_id") or "").strip()
                            if wp_id:
                                await run_sync(
                                    st.update_scheduled_job_fields,
                                    jid,
                                    {
                                        "state": "posted",
                                        "wp_post_id": wp_id,
                                        "wp_link": str(art_now.get("wp_link") or j.get("wp_link") or "")[:2000],
                                        "last_error": "",
                                        "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                                    },
                                )
                                reconciled = True
                    except Exception:
                        pass
                    if not reconciled:
                        err = _friendly_scheduler_error(e)
                        await run_sync(
                            st.update_scheduled_job_fields,
                            jid,
                            {
                                "state": "failed",
                                "last_error": err,
                                "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                            },
                        )
        except Exception:
            log.exception("Scheduler loop top-level error")

        # Trial milestone notification check — once per hour
        now_mono = _time.monotonic()
        if now_mono - _last_trial_reminder_check >= _TRIAL_REMINDER_INTERVAL:
            _last_trial_reminder_check = now_mono
            try:
                from app.services.trial_reminder_service import check_trial_milestones
                _st = get_legacy_storage_module()
                await check_trial_milestones(_st)
            except Exception:
                log.exception("trial_reminder: unhandled error")

        await asyncio.sleep(poll_seconds)
