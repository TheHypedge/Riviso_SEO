from __future__ import annotations

import asyncio
import inspect
import logging
from datetime import datetime
from functools import lru_cache
from typing import Any, Callable

from app.core.config import settings
from app.services.content_sanitizer import (
    sanitize_article_body,
    sanitize_meta_description,
    sanitize_meta_title,
)
from app.services.openai_client import OpenAIClient
from app.services.generation_blocklist import format_banned_phrases_for_prompt
from app.services.prompt_validation import assert_image_prompt_allowed
from app.services.seo_guardrails import (
    ANCHOR_SYSTEM_PREFIX,
    build_programmatic_image_prompt,
    enforce_strict_article_json,
    estimate_generation_token_budget,
)

log = logging.getLogger(__name__)

# Bump when generation/token-estimate signatures change; surfaced on /api/health for deploy checks.
GENERATION_REVISION = "2026-05-15-image-prompt-param"

@lru_cache(maxsize=16)
def _callable_param_names(fn: Callable[..., Any]) -> frozenset[str]:
    """Parameter names accepted by ``fn`` (cached for hot scheduled-job paths)."""
    return frozenset(inspect.signature(fn).parameters.keys())


def filter_kwargs_for_callable(fn: Callable[..., Any], kwargs: dict[str, Any]) -> dict[str, Any]:
    """
    Drop keyword arguments that ``fn`` does not accept.

    If ``fn`` declares ``**extra_kwargs`` (VAR_KEYWORD), pass all kwargs through
    so keys like ``image_prompt_text`` are not stripped before the call.
    """
    sig = inspect.signature(fn)
    for param in sig.parameters.values():
        if param.kind == inspect.Parameter.VAR_KEYWORD:
            return dict(kwargs)
    allowed = _callable_param_names(fn)
    return {k: v for k, v in kwargs.items() if k in allowed}


def estimate_bundle_tokens(
    *,
    title: str,
    keywords: list[str],
    focus_keyphrase: str,
    writing_prompt_text: str,
    brand_identity: str | None = None,
    niche_identifier: str | None = None,
    generate_image: bool,
    image_prompt_text: str | None = None,
    max_completion_tokens: int = 6_000,
) -> int:
    """
    Canonical token budget for article + optional custom image prompt.

    Does not depend on ``estimate_tokens_for_generation_bundle``'s parameter list,
    so scheduled jobs and the editor never fail when only callers were updated.
    """
    sys, user = build_generation_messages(
        title=title,
        keywords=keywords,
        focus_keyphrase=focus_keyphrase,
        writing_prompt_text=writing_prompt_text,
        brand_identity=brand_identity,
        niche_identifier=niche_identifier,
    )
    estimate = estimate_generation_token_budget(
        system_prompt=sys,
        user_message=user,
        max_completion_tokens=max_completion_tokens,
        include_image=generate_image,
    )
    img = (str(image_prompt_text).strip() if image_prompt_text is not None else "") or None
    if generate_image and img:
        estimate += estimate_generation_token_budget(
            system_prompt="",
            user_message=img[:1200],
            max_completion_tokens=0,
            include_image=False,
        )
    return estimate


def estimate_tokens_for_generation_bundle_safe(**kwargs: Any) -> int:
    """Always accepts ``image_prompt_text``; falls back to :func:`estimate_bundle_tokens`."""
    img = kwargs.pop("image_prompt_text", None)
    filtered = filter_kwargs_for_callable(estimate_tokens_for_generation_bundle, kwargs)
    try:
        return estimate_tokens_for_generation_bundle(**filtered, image_prompt_text=img)
    except TypeError as e:
        if "image_prompt_text" not in str(e) or "unexpected keyword argument" not in str(e):
            raise
        return estimate_bundle_tokens(**filtered, image_prompt_text=img)


async def generate_article_bundle_safe(**kwargs: Any) -> dict:
    """Always accepts ``image_prompt_text``; strips it if the target signature cannot."""
    img = kwargs.pop("image_prompt_text", None)
    filtered = filter_kwargs_for_callable(generate_article_bundle, kwargs)
    try:
        return await generate_article_bundle(**filtered, image_prompt_text=img)
    except TypeError as e:
        if "image_prompt_text" not in str(e) or "unexpected keyword argument" not in str(e):
            raise
        return await generate_article_bundle(**filtered)


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
        f"{format_banned_phrases_for_prompt()}"
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
    image_prompt_text: str | None = None,
    max_completion_tokens: int = 6_000,
    **extra_kwargs: Any,
) -> int:
    """
    Token budget estimate for a full article + optional image.

    ``image_prompt_text`` is a first-class parameter (scheduled jobs and the editor
    pass it). ``**extra_kwargs`` absorbs any other forward-compatible keys.
    """
    if image_prompt_text is None and "image_prompt_text" in extra_kwargs:
        image_prompt_text = extra_kwargs.pop("image_prompt_text")
    else:
        extra_kwargs.pop("image_prompt_text", None)
    if extra_kwargs:
        log.debug("estimate_tokens_for_generation_bundle ignored keys: %s", sorted(extra_kwargs.keys()))
    return estimate_bundle_tokens(
        title=title,
        keywords=keywords,
        focus_keyphrase=focus_keyphrase,
        writing_prompt_text=writing_prompt_text,
        brand_identity=brand_identity,
        niche_identifier=niche_identifier,
        generate_image=generate_image,
        image_prompt_text=image_prompt_text,
        max_completion_tokens=max_completion_tokens,
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
    image_prompt_text: str | None = None,
    **extra_kwargs: Any,
) -> dict:
    """
    Generate article markdown + meta + optional image.

    If an image prompt is selected, it is validated as image-only visual/style
    direction and then augmented server-side with focus keyphrase, niche, brand,
    title, and keywords before being sent to the image model.
    """
    if image_prompt_text is None and "image_prompt_text" in extra_kwargs:
        image_prompt_text = extra_kwargs.pop("image_prompt_text")
    else:
        extra_kwargs.pop("image_prompt_text", None)
    image_prompt_text = (str(image_prompt_text).strip() if image_prompt_text is not None else "") or None
    if extra_kwargs:
        log.debug("generate_article_bundle ignored keys: %s", sorted(extra_kwargs.keys()))
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
        if image_prompt_text:
            assert_image_prompt_allowed(image_prompt_text)
        image_prompt = build_programmatic_image_prompt(
            title=title,
            keywords=keywords,
            focus_keyphrase=focus_keyphrase,
            brand_identity=brand_identity,
            niche_identifier=niche_identifier,
            image_prompt_text=image_prompt_text,
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


async def generate_featured_image_only(
    *,
    title: str,
    keywords: list[str],
    focus_keyphrase: str,
    brand_identity: str | None = None,
    niche_identifier: str | None = None,
    image_prompt_text: str | None = None,
) -> dict:
    """Generate only the featured image for an existing article."""
    if image_prompt_text:
        assert_image_prompt_allowed(image_prompt_text)
    image_prompt = build_programmatic_image_prompt(
        title=title,
        keywords=keywords,
        focus_keyphrase=focus_keyphrase,
        brand_identity=brand_identity,
        niche_identifier=niche_identifier,
        image_prompt_text=image_prompt_text,
    )
    client = OpenAIClient()
    image_url = await asyncio.wait_for(
        client.generate_image_url(model=settings.openai_image_model, prompt=image_prompt),
        timeout=300.0,
    )
    if not image_url:
        raise RuntimeError("Image generation did not return an image.")
    return {
        "image_url": image_url,
        "image_prompt": image_prompt,
        "generated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        "model": settings.openai_image_model,
    }
