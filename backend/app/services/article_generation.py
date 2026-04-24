from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from app.core.config import settings
from app.services.openai_client import OpenAIClient

log = logging.getLogger(__name__)


def _apply_placeholders(prompt: str, *, title: str, keywords: list[str], focus_keyphrase: str) -> str:
    # Back-compat placeholders from legacy UI (best-effort).
    out = (prompt or "").replace("{article_title}", title)
    out = out.replace("{targeting_keywords}", ", ".join([k for k in keywords if k]))
    out = out.replace("{focus_keyphrase}", focus_keyphrase or "")
    out = out.replace("{short_focus_keyphrase}", (focus_keyphrase or "").split(" ")[0] if focus_keyphrase else "")
    return out


async def generate_article_bundle(
    *,
    title: str,
    keywords: list[str],
    focus_keyphrase: str,
    writing_prompt_text: str,
    generate_image: bool,
    image_prompt_text: str | None,
) -> dict:
    client = OpenAIClient()

    sys = (
        "You are an expert SEO content writer.\n"
        "Return ONLY a JSON object with keys: article_markdown, meta_title, meta_description.\n"
        "Write in clear, human-friendly tone. Use headings and lists where helpful.\n"
        "Meta title must be <= 60 chars if possible. Meta description <= 155 chars if possible."
    )

    up = _apply_placeholders(
        writing_prompt_text,
        title=title,
        keywords=keywords,
        focus_keyphrase=focus_keyphrase,
    ).strip()

    user = (
        f"Article title: {title}\n"
        f"Target keywords: {', '.join(keywords)}\n"
        f"Focus keyphrase: {focus_keyphrase}\n\n"
        f"Prompt:\n{up}\n"
    )

    obj = await client.chat_json(model=settings.openai_text_model, system=sys, user=user)

    article_md = str(obj.get("article_markdown") or "").strip()
    meta_title = str(obj.get("meta_title") or "").strip()
    meta_desc = str(obj.get("meta_description") or "").strip()

    if not article_md:
        raise RuntimeError("Generated article is empty")

    image_url: str | None = None
    if generate_image and image_prompt_text:
        ip = _apply_placeholders(
            image_prompt_text,
            title=title,
            keywords=keywords,
            focus_keyphrase=focus_keyphrase,
        ).strip()
        # Force "ultra realistic" photography-style image direction.
        # Keep prompts consistent and avoid text overlays / logos.
        realism = (
            "Ultra-realistic professional photography, 8k detail, natural skin/textures, "
            "cinematic lighting, shallow depth of field, high dynamic range, sharp focus.\n"
            "No text, no letters, no logos, no watermarks, no UI.\n"
            "Photorealistic, not illustration, not 3D render, not cartoon."
        )
        image_prompt = f"{ip}\n\n{realism}\n\nTitle: {title}\nFocus: {focus_keyphrase}\nKeywords: {', '.join(keywords[:12])}\n"
        # Image generation can be slow and may exceed reverse-proxy timeouts in dev.
        # We fail open: return the article even if image generation times out/fails.
        try:
            image_url = await asyncio.wait_for(
                client.generate_image_url(model=settings.openai_image_model, prompt=image_prompt),
                timeout=240.0,
            )
        except Exception:
            log.exception("Image generation failed (returning without image_url)")
            image_url = None

    return {
        "article": article_md,
        "meta_title": meta_title,
        "meta_description": meta_desc,
        "image_url": image_url,
        "generated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        "models": {"text": settings.openai_text_model, "image": settings.openai_image_model},
    }

