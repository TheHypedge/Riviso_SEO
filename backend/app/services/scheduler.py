from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from app.legacy.storage import get_legacy_storage_module
from app.services.wordpress_client import WordpressClient
from app.services.context_links import apply_context_links_html
from app.services.article_generation import generate_article_bundle


log = logging.getLogger(__name__)


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


def _resolve_prompt_text(*, prompts: list, pid: str | None) -> str | None:
    pid = (pid or "").strip()
    if pid:
        for p in prompts or []:
            if isinstance(p, dict) and (p.get("id") or "").strip() == pid:
                return (p.get("text") or "").strip() or None
    return None


def _fallback_first_prompt_text(prompts: list) -> str | None:
    for p in prompts or []:
        if isinstance(p, dict) and (p.get("text") or "").strip():
            return (p.get("text") or "").strip()
    return None


async def prepare_article_for_scheduled_job(*, st, jid: str, proj: dict, art: dict, job: dict) -> dict:
    """
    Ensure article has generated content/meta and (optionally) image, saving results to storage.
    This is used both:
    - immediately after scheduling (background task)
    - right before posting in the scheduler loop (safety net)
    """
    aid = (art.get("id") or "").strip()
    if not aid:
        raise RuntimeError("Article not found")

    needs_content = not (str(art.get("article") or "").strip())
    needs_image = not (str(art.get("image_url") or "").strip())
    generate_image = bool(job.get("generate_image", True))
    if not (needs_content or (generate_image and needs_image)):
        return art

    st.update_scheduled_job_fields(jid, {"state": "content_generating" if needs_content else "image_generating", "last_error": ""})

    # Resolve prompt texts: job override > project default > first prompt
    writing_text = _resolve_prompt_text(
        prompts=(proj.get("prompts") or []),
        pid=(job.get("writing_prompt_id") or "") or (proj.get("default_prompt_id") or ""),
    ) or _fallback_first_prompt_text(proj.get("prompts") or [])
    if not writing_text:
        raise RuntimeError("No writing prompt available for scheduled generation")

    image_text = _resolve_prompt_text(
        prompts=(proj.get("image_prompts") or []),
        pid=(job.get("image_prompt_id") or "") or (proj.get("default_image_prompt_id") or ""),
    ) or _fallback_first_prompt_text(proj.get("image_prompts") or [])

    gen = await generate_article_bundle(
        title=(art.get("title") or "").strip(),
        keywords=[str(x).strip() for x in (art.get("keywords") or []) if str(x).strip()],
        focus_keyphrase=(art.get("focus_keyphrase") or "").strip(),
        writing_prompt_text=writing_text,
        generate_image=generate_image,
        image_prompt_text=image_text,
    )

    st.update_article_fields(
        aid,
        {
            "article": gen.get("article") or art.get("article") or "",
            "meta_title": gen.get("meta_title") or art.get("meta_title") or "",
            "meta_description": gen.get("meta_description") or art.get("meta_description") or "",
            "image_url": gen.get("image_url") or art.get("image_url") or "",
            "generated_at": gen.get("generated_at") or art.get("generated_at") or "",
            "status": "draft" if (art.get("status") or "pending").lower() != "published" else (art.get("status") or "published"),
        },
    )

    # Reload and return updated row (best effort)
    art2 = next((a for a in (st.load_articles() or []) if isinstance(a, dict) and (a.get("id") or "") == aid), None)
    return art2 if isinstance(art2, dict) else art


async def publish_article_to_wordpress(*, proj: dict, article: dict, post_type: str, wp_status: str, category_ids: list[int]) -> dict:
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

    # Featured image from stored data URL (if present)
    featured_media_id: int | None = None
    img_url = (article.get("image_url") or "").strip()
    if img_url.startswith("data:image/") and ";base64," in img_url:
        import base64
        import binascii

        try:
            b64 = img_url.split(";base64,", 1)[1]
            data = base64.b64decode(b64, validate=False)
        except (IndexError, binascii.Error, ValueError):
            data = b""
        if data:
            up = await wp.upload_media(filename="scheduled-generated.png", content_type="image/png", data=data, timeout=90.0)
            if isinstance(up, dict) and isinstance(up.get("id"), int):
                featured_media_id = int(up["id"])

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

    try:
        created = await wp.post_json(f"/wp-json/wp/v2/{post_type}", payload, timeout=60.0)
    except Exception:
        # Retry without tags for CPTs that don't support them.
        if "tags" in payload:
            payload.pop("tags", None)
            created = await wp.post_json(f"/wp-json/wp/v2/{post_type}", payload, timeout=60.0)
        else:
            raise
    if not isinstance(created, dict):
        raise RuntimeError("Unexpected WordPress response")
    return created


async def scheduler_loop(*, poll_seconds: float = 10.0) -> None:
    """
    In-process scheduler loop.
    Dev-friendly: polls scheduled_jobs and posts due items.
    For production: move to a dedicated worker.
    """
    while True:
        try:
            st = get_legacy_storage_module()
            jobs = st.load_scheduled_jobs(project_id=None) if hasattr(st, "load_scheduled_jobs") else []
            now = datetime.now(timezone.utc)

            for j in jobs or []:
                if not isinstance(j, dict):
                    continue
                # A job can be "ready_to_post" if background preparation finished early.
                # Both states should be eligible once run_at is due.
                if (j.get("state") or "scheduled") not in {"scheduled", "ready_to_post"}:
                    continue
                run_at = _parse_run_at_utc(j.get("run_at") or "")
                if not run_at or run_at > now:
                    continue

                jid = (j.get("id") or "").strip()
                pid = (j.get("project_id") or "").strip()
                aid = (j.get("article_id") or "").strip()
                if not jid or not pid or not aid:
                    continue

                # Mark posting
                st.update_scheduled_job_fields(
                    jid,
                    {
                        "state": "posting",
                        "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                        "attempts": int(j.get("attempts") or 0) + 1,
                        "last_attempt_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                        "last_error": "",
                    },
                )

                try:
                    # Lookup project + article rows
                    proj = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
                    if not proj:
                        raise RuntimeError("Project not found")
                    art = next((a for a in (st.load_articles() or []) if isinstance(a, dict) and (a.get("id") or "") == aid and (a.get("project_id") or "") == pid), None)
                    if not art:
                        raise RuntimeError("Article not found")

                    # If article isn't generated yet, generate it now using scheduled prompts/defaults.
                    art = await prepare_article_for_scheduled_job(st=st, jid=jid, proj=proj, art=art, job=j)

                    st.update_scheduled_job_fields(jid, {"state": "ready_to_post"})

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
                        proj=proj,
                        article=art,
                        post_type=(j.get("post_type") or "posts"),
                        wp_status=(j.get("wp_status") or "draft"),
                        category_ids=cats,
                    )

                    wp_post_id = created.get("id")
                    wp_link = created.get("link") or ""
                    st.update_scheduled_job_fields(
                        jid,
                        {
                            "state": "posted",
                            "wp_post_id": wp_post_id,
                            "wp_link": wp_link,
                            "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                        },
                    )
                    st.update_article_fields(
                        aid,
                        {
                            "wp_post_id": wp_post_id,
                            "wp_link": wp_link,
                            "wp_rest_base": (j.get("post_type") or "posts"),
                            "wp_last_wp_status": (j.get("wp_status") or "draft"),
                            # Once posted, clear schedule marker so UI shows draft/published instead of scheduled.
                            "wp_scheduled_at": "",
                            "wp_schedule_error": "",
                            "posted_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S") if (j.get("wp_status") or "").lower() == "publish" else (art.get("posted_at") or ""),
                            "status": "published" if (j.get("wp_status") or "").lower() == "publish" else (art.get("status") or "draft"),
                        },
                    )
                except Exception as e:
                    log.exception("Scheduled job failed jid=%s", jid)
                    st.update_scheduled_job_fields(
                        jid,
                        {
                            "state": "failed",
                            "last_error": str(e),
                            "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                        },
                    )
        except Exception:
            log.exception("Scheduler loop top-level error")

        await asyncio.sleep(poll_seconds)

