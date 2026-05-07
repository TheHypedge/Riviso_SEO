from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from app.core.config import settings
from app.services.content_sanitizer import (
    sanitize_article_body,
    sanitize_meta_description,
    sanitize_meta_title,
)
from app.services.openai_client import OpenAIClient
from app.services.seo_guardrails import (
    ANCHOR_SYSTEM_PREFIX,
    build_programmatic_image_prompt,
    enforce_strict_article_json,
    estimate_generation_token_budget,
)

log = logging.getLogger(__name__)


def _apply_placeholders(prompt: str, *, title: str, keywords: list[str], focus_keyphrase: str) -> str:
    out = (prompt or "").replace("{article_title}", title)
    out = out.replace("{targeting_keywords}", ", ".join([k for k in keywords if k]))
    out = out.replace("{focus_keyphrase}", focus_keyphrase or "")
    out = out.replace("{short_focus_keyphrase}", (focus_keyphrase or "").split(" ")[0] if focus_keyphrase else "")
    return out


def build_generation_messages(
    *,
    title: str,
    keywords: list[str],
    focus_keyphrase: str,
    writing_prompt_text: str,
    brand_identity: str | None = None,
    niche_identifier: str | None = None,
) -> tuple[str, str]:
    """Build (system, user) chat payloads — single source of truth for token estimation and generation."""
    bi = (brand_identity or "").strip()
    ni = (niche_identifier or "").strip()
    flavor = ""
    if bi or ni:
        flavor = (
            "\n\nProject context (must follow):\n"
            f"- Brand identity: {bi or '(not set)'}\n"
            f"- Niche identifier: {ni or '(not set)'}\n"
        )

    sys = (
        ANCHOR_SYSTEM_PREFIX
        + "You are an expert SEO content writer.\n"
        "Return ONLY a JSON object with exactly these keys and no others: "
        '"article_markdown", "meta_title", "meta_description".\n'
        "Do not add commentary, explanations, or keys such as title, body, keywords, or choices.\n"
        "Write in clear, human-friendly tone. Use headings and lists where helpful.\n"
        "Meta title must be <= 60 chars if possible. Meta description <= 155 chars if possible.\n"
        "STRICT OUTPUT RULES — article_markdown MUST contain ONLY the article body:\n"
        "- Do NOT include 'Meta Title:', 'Meta Description:', 'SEO Title:' or any meta block inside article_markdown.\n"
        "- Do NOT include 'Focus Keyphrase:', 'Keywords:', 'Tags:', 'Slug:' or 'AI suggested keywords' inside article_markdown.\n"
        "- Do NOT include AI preamble or postamble.\n"
        "- Do NOT wrap article_markdown in code fences. Output it as plain markdown.\n"
        "- meta_title and meta_description must be plain text only — no quotes, no 'Meta Title:' prefix, no markdown.\n"
        "- Do NOT output code, poetry, scripts, or conversational text outside the JSON object."
        f"{flavor}"
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
    return sys, user


def estimate_tokens_for_generation_bundle(
    *,
    title: str,
    keywords: list[str],
    focus_keyphrase: str,
    writing_prompt_text: str,
    brand_identity: str | None = None,
    niche_identifier: str | None = None,
    generate_image: bool,
    max_completion_tokens: int = 6_000,
) -> int:
    sys, user = build_generation_messages(
        title=title,
        keywords=keywords,
        focus_keyphrase=focus_keyphrase,
        writing_prompt_text=writing_prompt_text,
        brand_identity=brand_identity,
        niche_identifier=niche_identifier,
    )
    return estimate_generation_token_budget(
        system_prompt=sys,
        user_message=user,
        max_completion_tokens=max_completion_tokens,
        include_image=generate_image,
    )


async def generate_article_bundle(
    *,
    title: str,
    keywords: list[str],
    focus_keyphrase: str,
    writing_prompt_text: str,
    brand_identity: str | None = None,
    niche_identifier: str | None = None,
    generate_image: bool,
) -> dict:
    """
    Generate article markdown + meta + optional image.

    Image prompts are never taken from user-authored template text; they are derived
    server-side from focus keyphrase, niche, brand, title, and keywords.
    """
    client = OpenAIClient()

    sys, user = build_generation_messages(
        title=title,
        keywords=keywords,
        focus_keyphrase=focus_keyphrase,
        writing_prompt_text=writing_prompt_text,
        brand_identity=brand_identity,
        niche_identifier=niche_identifier,
    )

    obj = await client.chat_json(model=settings.openai_text_model, system=sys, user=user)
    obj = enforce_strict_article_json(dict(obj))

    article_md = sanitize_article_body(obj.get("article_markdown"))
    meta_title = sanitize_meta_title(obj.get("meta_title"))
    meta_desc = sanitize_meta_description(obj.get("meta_description"))

    if not article_md:
        raise RuntimeError("Generated article is empty")

    image_url: str | None = None
    if generate_image:
        image_prompt = build_programmatic_image_prompt(
            title=title,
            keywords=keywords,
            focus_keyphrase=focus_keyphrase,
            brand_identity=brand_identity,
            niche_identifier=niche_identifier,
        )
        try:
            image_url = await asyncio.wait_for(
                client.generate_image_url(model=settings.openai_image_model, prompt=image_prompt),
                timeout=300.0,
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
