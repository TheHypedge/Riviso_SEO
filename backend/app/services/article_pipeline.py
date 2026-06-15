"""
Shared article generation pipeline (OpenAI bundle + quota + persistence).

Extracted from :mod:`app.api.routes.articles` so topic-cluster fan-out and the
``POST .../generate`` route stay behaviour-identical without importing API routers
from services (avoids circular imports).
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from fastapi import HTTPException

from app.core.config import settings
from datetime import datetime
from app.services.article_generation import (
    estimate_bundle_tokens,
    generate_article_bundle_safe,
    generate_featured_image_only,
)
from app.services.prompt_validation import assert_image_prompt_allowed, assert_writing_prompt_allowed
from app.services.integrity_engine import AIDetectionAuditor
from app.services.platform_generation import resolve_platform_generation_extras
from app.services.shopify_product_pipeline import is_shopify_project
from app.services.wordpress_content_pipeline import is_wordpress_project
from app.services.cluster_internal_link_service import resolve_cluster_mapped_pages
from app.services.context_links import apply_context_links_markdown
from app.services.pipeline_streamer import (
    MSG_FEATURED_IMAGE,
    MSG_GENERATION_COMPLETE,
    MSG_INTEGRITY,
    MSG_INTERNAL_LINKS,
    MSG_OPENAI,
    STAGE_COMPLETE,
    STAGE_FEATURED_IMAGE,
    STAGE_INTEGRITY_VERIFY,
    STAGE_INTERNAL_LINKS,
    STAGE_OPENAI_DISPATCH,
    publish_pipeline_error,
    publish_pipeline_status,
)

_log = logging.getLogger(__name__)


def _effective_mapped_pages(
    *,
    st: Any,
    proj: dict,
    project_id: str,
    row: dict,
    mapped_pages: list[dict] | None,
) -> list[dict] | None:
    """
    When the client did not send an explicit page list, auto-link live cluster
    siblings before falling back to the synced site map.
    """
    if mapped_pages is not None:
        return mapped_pages
    if not is_wordpress_project(proj):
        return None
    try:
        cluster_pages = resolve_cluster_mapped_pages(
            st,
            project_id=project_id,
            article_row=row,
        )
    except Exception:
        _log.debug("Cluster mapped-page resolution failed", exc_info=True)
        cluster_pages = []
    if cluster_pages:
        return [p.as_dict() for p in cluster_pages]
    return None


def _resolve_writing_prompt(*, proj: dict, writing_prompt_id: str | None) -> dict | None:
    pid = (writing_prompt_id or "").strip() or (proj.get("default_prompt_id") or "").strip() or None
    if not pid:
        return None
    for p in proj.get("prompts") or []:
        if isinstance(p, dict) and (p.get("id") or "").strip() == pid:
            return {"id": pid, "name": (p.get("name") or "").strip(), "text": (p.get("text") or "").strip()}
    raise HTTPException(status_code=404, detail="Prompt not found")


def _resolve_image_prompt(*, proj: dict, image_prompt_id: str | None) -> dict | None:
    pid = (image_prompt_id or "").strip() or (proj.get("default_image_prompt_id") or "").strip() or None
    if not pid:
        return None
    for p in proj.get("image_prompts") or []:
        if isinstance(p, dict) and (p.get("id") or "").strip() == pid:
            return {"id": pid, "name": (p.get("name") or "").strip(), "text": (p.get("text") or "").strip()}
    raise HTTPException(status_code=404, detail="Image prompt not found")


async def execute_article_generation(
    *,
    st: Any,
    user: dict,
    proj: dict,
    project_id: str,
    article_id: str,
    row: dict,
    writing_prompt_id: str | None,
    generate_image: bool,
    image_prompt_id: str | None = None,
    focus_keyphrase_override: str | None = None,
    mapped_products: list[dict] | None = None,
    mapped_pages: list[dict] | None = None,
) -> dict:
    """
    Run the same steps as ``POST /projects/{id}/articles/{article_id}/generate``.

    Persists generated HTML/meta/image onto ``article_id`` and returns the JSON payload
    the route would return (``ok``, ``status``, ``message``, ``resolved``, ``generated``).
    """
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()

    resolved_writing = _resolve_writing_prompt(proj=proj, writing_prompt_id=writing_prompt_id)
    resolved_image = _resolve_image_prompt(proj=proj, image_prompt_id=image_prompt_id) if generate_image else None
    if not (settings.openai_api_key or "").strip():
        raise HTTPException(status_code=501, detail="OPENAI_API_KEY is not configured on the backend")

    title = (row.get("title") or "").strip()
    keywords = [str(x).strip() for x in (row.get("keywords") or []) if str(x).strip()]
    _ov = focus_keyphrase_override
    _ov_s = (_ov or "").strip() if _ov is not None else ""
    focus = (_ov_s or (row.get("focus_keyphrase") or "")).strip()

    if not title:
        raise HTTPException(status_code=400, detail="Article title is required for generation")
    if not resolved_writing:
        raise HTTPException(status_code=400, detail="No writing prompt selected and no project default set")

    try:
        assert_writing_prompt_allowed(resolved_writing["text"], user_id=uid or None)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if generate_image and resolved_image:
        try:
            assert_image_prompt_allowed(resolved_image["text"])
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

    platform_extras = resolve_platform_generation_extras(
        proj=proj,
        title=title,
        keywords=keywords,
        focus=focus,
        mapped_products=mapped_products if is_shopify_project(proj) else None,
        mapped_pages=_effective_mapped_pages(
            st=st,
            proj=proj,
            project_id=project_id,
            row=row,
            mapped_pages=mapped_pages,
        )
        if is_wordpress_project(proj)
        else None,
    )

    token_estimate = estimate_bundle_tokens(
        title=title,
        keywords=keywords,
        focus_keyphrase=focus,
        writing_prompt_text=resolved_writing["text"],
        brand_identity=(proj.get("brand_identity") or ""),
        niche_identifier=(proj.get("niche_identifier") or ""),
        product_context=platform_extras.get("product_context"),
        generate_image=generate_image,
        image_prompt_text=(resolved_image or {}).get("text") or None,
    )

    plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
    plan: dict = {}
    try:
        plans = st.load_plans() or {}
        plan = plans.get(plan_key) if isinstance(plans, dict) else {}
        if not isinstance(plan, dict):
            plan = {}
    except Exception:
        plan = {}

    if role != "admin" and uid:
        ok_t, msg_t = st.check_llm_token_budget(uid, token_estimate, plan.get("max_llm_tokens_per_month"))
        if not ok_t:
            raise HTTPException(status_code=403, detail=msg_t or "Token budget exceeded")

    quota_consumed = False
    if role != "admin" and uid and hasattr(st, "consume_article_usage"):
        day_lim = plan.get("max_articles_per_day")
        month_lim = plan.get("max_articles_per_month")
        ok, msg = st.consume_article_usage(uid, day_limit=day_lim, month_limit=month_lim, amount=1)
        if not ok:
            raise HTTPException(status_code=403, detail=msg or "Limit reached for your plan")
        quota_consumed = True

    if platform_extras.get("wp_mapped_pages"):
        await publish_pipeline_status(article_id, MSG_INTERNAL_LINKS, STAGE_INTERNAL_LINKS)

    await publish_pipeline_status(article_id, MSG_OPENAI, STAGE_OPENAI_DISPATCH)

    try:
        gen = await generate_article_bundle_safe(
            title=title,
            keywords=keywords,
            focus_keyphrase=focus,
            writing_prompt_text=resolved_writing["text"],
            brand_identity=(proj.get("brand_identity") or ""),
            niche_identifier=(proj.get("niche_identifier") or ""),
            product_context=platform_extras.get("product_context"),
            reference_image_url=platform_extras.get("reference_image_url"),
            shopify_mapped_products=platform_extras.get("shopify_mapped_products"),
            wordpress_mapped_pages=platform_extras.get("wp_mapped_pages"),
            generate_image=generate_image,
            image_prompt_text=(resolved_image or {}).get("text") or None,
        )
    except HTTPException:
        if quota_consumed and hasattr(st, "refund_article_usage"):
            try:
                st.refund_article_usage(uid, amount=1)
            except Exception:
                pass
        await publish_pipeline_error(article_id, "Generation failed — see server logs for details.")
        raise
    except Exception:
        if quota_consumed and hasattr(st, "refund_article_usage"):
            try:
                st.refund_article_usage(uid, amount=1)
            except Exception:
                pass
        await publish_pipeline_error(article_id, "Generation failed — see server logs for details.")
        raise

    await publish_pipeline_status(article_id, MSG_INTEGRITY, STAGE_INTEGRITY_VERIFY)
    if generate_image:
        await publish_pipeline_status(article_id, MSG_FEATURED_IMAGE, STAGE_FEATURED_IMAGE)

    if role != "admin" and uid:
        st.consume_llm_generation_tokens(uid, token_estimate)

    image_url = (gen.get("image_url") or "").strip()

    # Inject context links into the generated Markdown before persisting.
    # All generation workflow paths (manual, worker queue, scheduler, topic cluster)
    # reach this point, so this is the single mandatory application site.
    _ctx_items = [
        {"label": (x.get("label") or "").strip(), "url": (x.get("url") or "").strip()}
        for x in (proj.get("context_links") or [])
        if isinstance(x, dict)
        and (x.get("label") or "").strip()
        and (x.get("url") or "").strip()
    ]
    _article_md = apply_context_links_markdown(gen["article"], _ctx_items)

    # Strip em dashes and en dashes that the LLM slips through despite prompt directives.
    # Replace with a plain hyphen surrounded by spaces, then collapse any double spaces.
    _article_md = re.sub(r"\s*[—–]\s*", " - ", _article_md)
    _article_md = re.sub(r" {2,}", " ", _article_md)

    updates = {
        "article": _article_md,
        "meta_title": gen["meta_title"],
        "meta_description": gen["meta_description"],
        "generated_at": gen["generated_at"],
        # image_url is NOT set here by default — it is only written when a new
        # image was successfully generated so we never erase an existing image.
        "status": "draft"
        if ((row.get("status") or "pending").strip().lower() != "published")
        else (row.get("status") or "published"),
    }
    if generate_image and image_url:
        # New image generated successfully — write it
        updates["image_url"] = image_url
        updates["featured_image_generated_at"] = gen.get("generated_at") or ""
        updates["featured_image_source"] = "generated"
        updates["featured_image_prompt_id"] = (resolved_image or {}).get("id") or ""
        updates["featured_image_model"] = (gen.get("models") or {}).get("image") or ""
    elif generate_image and not image_url:
        # Image was requested but failed (e.g. API error) — keep existing image,
        # only clear the metadata fields to avoid stale prompt/model attribution
        updates["featured_image_generated_at"] = ""
        updates["featured_image_source"] = ""
        updates["featured_image_prompt_id"] = ""
    # generate_image=False → touch no image fields; existing image is preserved
    if platform_extras.get("shopify_mapped_products"):
        updates["shopify_mapped_products"] = platform_extras.get("shopify_mapped_products")
    elif gen.get("shopify_mapped_products"):
        updates["shopify_mapped_products"] = gen.get("shopify_mapped_products")
    if platform_extras.get("wp_mapped_pages"):
        updates["wp_mapped_pages"] = platform_extras.get("wp_mapped_pages")
    elif gen.get("wp_mapped_pages"):
        updates["wp_mapped_pages"] = gen.get("wp_mapped_pages")
    # AI-score audit — always runs so the score is stored for visibility.
    try:
        auditor = AIDetectionAuditor()
        audit2 = auditor.audit_markdown(updates.get("article") or "")
        updates["integrity_ai_percentage"] = audit2.get("ai_percentage")
        updates["integrity_flagged_paragraphs"] = audit2.get("flagged_paragraphs")
        updates["integrity_last_audited_at"] = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        pass

    persist = getattr(st, "patch_article_fields", None) or st.update_article_fields
    from app.services.storage_db import call_storage

    await asyncio.to_thread(call_storage, persist, article_id, updates)

    await publish_pipeline_status(article_id, MSG_GENERATION_COMPLETE, STAGE_COMPLETE)

    image_warning: str | None = None
    if generate_image and not image_url:
        image_warning = (gen.get("image_error") or "").strip() or "Featured image could not be generated."

    message = "Article generated successfully."
    if image_warning:
        message = f"Article generated, but featured image failed: {image_warning}"

    return {
        "ok": True,
        "status": "generated",
        "message": message,
        "image_warning": image_warning,
        "resolved": {
            "writing_prompt": {"id": resolved_writing["id"], "name": resolved_writing["name"]}
            if resolved_writing
            else None,
            "image_prompt": {"id": resolved_image["id"], "name": resolved_image["name"]}
            if resolved_image
            else None,
            "image_prompt_source": "custom_plus_brand_niche" if resolved_image else "programmatic",
            "focus_keyphrase": focus,
            "generate_image": generate_image,
            "models": gen.get("models"),
        },
        "generated": {
            "article": _article_md,
            "meta_title": gen["meta_title"],
            "meta_description": gen["meta_description"],
            "image_url": gen.get("image_url"),
        },
    }


def image_regeneration_limit_snapshot(*, used: int, limit: int | None) -> dict[str, Any]:
    try:
        lim = int(limit) if limit is not None else 0
    except Exception:
        lim = 0
    used_norm = max(0, int(used or 0))
    if lim <= 0:
        return {
            "used": used_norm,
            "limit": 0,
            "remaining": None,
            "unlimited": True,
        }
    return {
        "used": used_norm,
        "limit": lim,
        "remaining": max(0, lim - used_norm),
        "unlimited": False,
    }


async def execute_featured_image_regeneration(
    *,
    st: Any,
    user: dict,
    proj: dict,
    article_id: str,
    row: dict,
    image_prompt_id: str | None = None,
    custom_image_prompt: str | None = None,
) -> dict:
    """Regenerate only the stored featured image and enforce the per-article plan cap."""
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
    plan: dict = {}
    try:
        plans = st.load_plans() or {}
        plan = plans.get(plan_key) if isinstance(plans, dict) else {}
        if not isinstance(plan, dict):
            plan = {}
    except Exception:
        plan = {}

    used_before = int(row.get("featured_image_regeneration_count") or 0)
    had_prior_image = bool(row.get("has_featured_image")) or bool(
        (row.get("featured_image_generated_at") or "").strip()
    )
    limit = plan.get("max_article_image_regenerations")
    before = image_regeneration_limit_snapshot(used=used_before, limit=limit)
    if had_prior_image and role != "admin" and not before["unlimited"] and before["remaining"] <= 0:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "image_regeneration_limit_reached",
                "message": (
                    "The max featured image regeneration limit for this article is exhausted."
                ),
                "used": before["used"],
                "limit": before["limit"],
                "remaining": 0,
                "plan_key": plan_key,
            },
        )

    if not (settings.openai_api_key or "").strip():
        raise HTTPException(status_code=501, detail="OPENAI_API_KEY is not configured on the backend")

    title = (row.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Article title is required for image regeneration")

    keywords = [str(x).strip() for x in (row.get("keywords") or []) if str(x).strip()]
    focus = (row.get("focus_keyphrase") or title).strip()
    custom_text = (custom_image_prompt or "").strip()
    if custom_text:
        resolved_image = {"id": "", "name": "Custom (one-time)", "text": custom_text}
        image_prompt_text = custom_text
    else:
        resolved_image = _resolve_image_prompt(proj=proj, image_prompt_id=image_prompt_id)
        image_prompt_text = (resolved_image or {}).get("text") or None

    ref_image: str | None = None
    if is_shopify_project(proj) or is_wordpress_project(proj):
        try:
            stored_products = row.get("shopify_mapped_products") if is_shopify_project(proj) else None
            stored_pages = row.get("wp_mapped_pages") if is_wordpress_project(proj) else None
            mapped_products = (
                stored_products if isinstance(stored_products, list) and stored_products else None
            )
            mapped_pages = stored_pages if isinstance(stored_pages, list) and stored_pages else None
            if mapped_products or mapped_pages:
                extras = resolve_platform_generation_extras(
                    proj=proj,
                    title=title,
                    keywords=keywords,
                    focus=focus,
                    mapped_products=mapped_products,
                    mapped_pages=mapped_pages,
                )
                ref_image = extras.get("reference_image_url")
        except Exception:
            _log.debug("Platform image regen reference resolution failed", exc_info=True)
            ref_image = None

    await publish_pipeline_status(article_id, MSG_FEATURED_IMAGE, STAGE_FEATURED_IMAGE)

    try:
        gen = await generate_featured_image_only(
            title=title,
            keywords=keywords,
            focus_keyphrase=focus,
            brand_identity=(proj.get("brand_identity") or ""),
            niche_identifier=(proj.get("niche_identifier") or ""),
            image_prompt_text=image_prompt_text,
            reference_image_url=ref_image,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        _log.exception("Featured image generation failed for article %s", article_id)
        raise HTTPException(
            status_code=502,
            detail=f"Featured image generation failed: {str(e)[:400]}",
        ) from e

    image_url = (gen.get("image_url") or "").strip()
    if not image_url:
        raise HTTPException(status_code=502, detail="Image model returned no image.")

    used_after = used_before + (1 if had_prior_image else 0)
    image_source = "regenerated" if had_prior_image else "generated"
    updates = {
        "image_url": image_url,
        "featured_image_generated_at": gen["generated_at"],
        "featured_image_regeneration_count": used_after,
        "featured_image_prompt_id": (resolved_image or {}).get("id") or "" if not custom_text else "",
        "featured_image_source": image_source,
        "featured_image_prompt_final": gen.get("image_prompt") or "",
        "featured_image_model": gen.get("model") or "",
    }
    from app.services.storage_db import call_storage

    persist = getattr(st, "patch_article_fields", None) or st.update_article_fields
    file_exists = getattr(st, "featured_image_file_exists", None)
    save_warning: str | None = None
    saved = False
    try:
        saved = await asyncio.to_thread(call_storage, persist, article_id, updates)
    except Exception as persist_exc:
        _log.warning("Featured image metadata save failed for %s: %s", article_id, persist_exc)
        if callable(file_exists) and file_exists(article_id):
            save_warning = (
                "Featured image was generated and saved locally, but database metadata could not "
                "be updated. Retry when your connection is stable."
            )
        else:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "database_unavailable",
                    "message": "Featured image was generated but could not be saved. Check database connectivity and retry.",
                    "image_url": image_url,
                },
            ) from persist_exc
    if not saved:
        if callable(file_exists) and file_exists(article_id):
            save_warning = (
                "Featured image preview is ready, but database metadata was not updated. "
                "Save again or retry when MongoDB is reachable."
            )
        else:
            raise HTTPException(
                status_code=500,
                detail="Featured image was generated but could not be saved. Check database connectivity and retry.",
            )
    after = image_regeneration_limit_snapshot(used=used_after, limit=limit)
    msg = (
        "Featured image regenerated successfully."
        if had_prior_image
        else "Featured image generated successfully."
    )
    if save_warning:
        msg = f"{msg} {save_warning}"
    await publish_pipeline_status(
        article_id,
        MSG_GENERATION_COMPLETE if not had_prior_image else "✨ Featured image regeneration complete.",
        STAGE_COMPLETE,
    )
    return {
        "ok": True,
        "status": "image_regenerated" if had_prior_image else "image_generated",
        "message": msg,
        "image_url": image_url,
        "has_featured_image": True,
        "save_warning": save_warning,
        "resolved": {
            "image_prompt": {"id": resolved_image["id"], "name": resolved_image["name"]}
            if resolved_image
            else None,
            "image_prompt_source": "custom_plus_brand_niche" if resolved_image else "programmatic",
            "models": {"image": gen.get("model")},
        },
        "usage": after,
    }
