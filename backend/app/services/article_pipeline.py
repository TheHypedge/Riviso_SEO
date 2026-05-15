"""
Shared article generation pipeline (OpenAI bundle + quota + persistence).

Extracted from :mod:`app.api.routes.articles` so topic-cluster fan-out and the
``POST .../generate`` route stay behaviour-identical without importing API routers
from services (avoids circular imports).
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import HTTPException

from app.core.config import settings
from app.services.article_generation import (
    estimate_bundle_tokens,
    generate_article_bundle_safe,
    generate_featured_image_only,
)
from app.services.prompt_validation import assert_image_prompt_allowed, assert_writing_prompt_allowed


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

    token_estimate = estimate_bundle_tokens(
        title=title,
        keywords=keywords,
        focus_keyphrase=focus,
        writing_prompt_text=resolved_writing["text"],
        brand_identity=(proj.get("brand_identity") or ""),
        niche_identifier=(proj.get("niche_identifier") or ""),
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

    try:
        gen = await generate_article_bundle_safe(
            title=title,
            keywords=keywords,
            focus_keyphrase=focus,
            writing_prompt_text=resolved_writing["text"],
            brand_identity=(proj.get("brand_identity") or ""),
            niche_identifier=(proj.get("niche_identifier") or ""),
            generate_image=generate_image,
            image_prompt_text=(resolved_image or {}).get("text") or None,
        )
    except HTTPException:
        if quota_consumed and hasattr(st, "refund_article_usage"):
            try:
                st.refund_article_usage(uid, amount=1)
            except Exception:
                pass
        raise
    except Exception:
        if quota_consumed and hasattr(st, "refund_article_usage"):
            try:
                st.refund_article_usage(uid, amount=1)
            except Exception:
                pass
        raise

    if role != "admin" and uid:
        st.consume_llm_generation_tokens(uid, token_estimate)

    updates = {
        "article": gen["article"],
        "meta_title": gen["meta_title"],
        "meta_description": gen["meta_description"],
        "generated_at": gen["generated_at"],
        "image_url": gen.get("image_url") or "",
        "status": "draft"
        if ((row.get("status") or "pending").strip().lower() != "published")
        else (row.get("status") or "published"),
    }
    await asyncio.to_thread(st.update_article_fields, article_id, updates)

    return {
        "ok": True,
        "status": "generated",
        "message": "Article generated successfully.",
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
            "article": gen["article"],
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
    limit = plan.get("max_article_image_regenerations")
    before = image_regeneration_limit_snapshot(used=used_before, limit=limit)
    if role != "admin" and not before["unlimited"] and before["remaining"] <= 0:
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
    resolved_image = _resolve_image_prompt(proj=proj, image_prompt_id=image_prompt_id)
    try:
        gen = await generate_featured_image_only(
            title=title,
            keywords=keywords,
            focus_keyphrase=focus,
            brand_identity=(proj.get("brand_identity") or ""),
            niche_identifier=(proj.get("niche_identifier") or ""),
            image_prompt_text=(resolved_image or {}).get("text") or None,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    used_after = used_before + 1
    updates = {
        "image_url": gen["image_url"],
        "featured_image_generated_at": gen["generated_at"],
        "featured_image_regeneration_count": used_after,
        "featured_image_prompt_id": (resolved_image or {}).get("id") or "",
        "featured_image_source": "regenerated",
        "featured_image_prompt_final": gen.get("image_prompt") or "",
        "featured_image_model": gen.get("model") or "",
    }
    await asyncio.to_thread(st.update_article_fields, article_id, updates)
    after = image_regeneration_limit_snapshot(used=used_after, limit=limit)
    return {
        "ok": True,
        "status": "image_regenerated",
        "message": "Featured image regenerated successfully.",
        "image_url": gen["image_url"],
        "resolved": {
            "image_prompt": {"id": resolved_image["id"], "name": resolved_image["name"]}
            if resolved_image
            else None,
            "image_prompt_source": "custom_plus_brand_niche" if resolved_image else "programmatic",
            "models": {"image": gen.get("model")},
        },
        "usage": after,
    }
