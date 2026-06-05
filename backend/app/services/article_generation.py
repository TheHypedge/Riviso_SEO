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
from app.services.human_writing_guardrail import (
    HUMAN_FIRST_SYSTEM_ANCHOR,
    format_ai_detector_banned_phrases_for_prompt,
    format_human_writing_guardrail_for_system_prompt,
)
from app.services.prompt_validation import assert_image_prompt_allowed
from app.services.seo_guardrails import (
    build_programmatic_image_prompt,
    enforce_strict_article_json,
    estimate_generation_token_budget,
)

log = logging.getLogger(__name__)

# Bump when generation/token-estimate signatures change; surfaced on /api/health for deploy checks.
GENERATION_REVISION = "2026-06-05-depth-faq-aeo-geo"

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
    product_context: str | None = None,
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
        product_context=product_context,
        shopify_product_mapping="Shopify product context" in (product_context or ""),
        wordpress_content_mapping="WordPress internal page" in (product_context or ""),
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
    product_context: str | None = None,
    shopify_product_mapping: bool = False,
    wordpress_content_mapping: bool = False,
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
    human_guardrail = format_human_writing_guardrail_for_system_prompt(
        title=title,
        focus_keyphrase=focus_keyphrase,
        keywords=keywords,
    )

    platform_mapping = shopify_product_mapping or wordpress_content_mapping
    pc = (product_context or "").strip() if platform_mapping else ""
    product_rules = ""
    if shopify_product_mapping and pc:
        product_rules = (
            "\n\nShopify product rules (required when context is provided):\n"
            "- Use ONLY the products listed in the product context.\n"
            "- Link products with markdown using the exact relative paths given "
            "(e.g. [Product name](/products/handle)).\n"
            "- Include at least one natural inline product link in the article body.\n"
            "- Do not fabricate pricing, availability, SKU details, or extra products.\n"
            "- Do not use absolute storefront URLs unless explicitly provided.\n"
        )
    elif wordpress_content_mapping and pc:
        product_rules = (
            "\n\nWordPress internal linking rules (required when context is provided):\n"
            "- Use ONLY the pages listed in the page context.\n"
            "- Link with markdown using the exact post URLs given "
            "(e.g. [Page title](https://yoursite.com/post-slug/)).\n"
            "- Include at least one natural inline internal link in the article body.\n"
            "- Do not invent posts, slugs, or URLs that are not in the context.\n"
        )

    sys = (
        HUMAN_FIRST_SYSTEM_ANCHOR
        + human_guardrail
        + "\n\nCONTENT STRUCTURE REQUIREMENTS (non-negotiable — apply to every article):\n"
        "- Use ## H2 headings for every main section (minimum 4 H2 sections required).\n"
        "- Use ### H3 sub-headings when a section has 2 or more distinct sub-topics.\n"
        "- Use bullet points (- item) for any list of 3 or more parallel items, tips, or features.\n"
        "- Use numbered lists (1. step) for sequential processes or step-by-step instructions.\n"
        "- Use **bold** for 2–4 key terms, statistics, or critical phrases per article.\n"
        "- Keep paragraphs to 2–4 sentences. Long text must be broken into bullets or sub-sections.\n"
        "\n\nCONTENT DEPTH REQUIREMENTS (apply unless the user's writing instructions specify otherwise):\n"
        "- Write a comprehensive, in-depth article — minimum 1,500 words of substantive content.\n"
        "- Cover the topic fully: explain what it is, why it matters, how it works, common mistakes, and best practices.\n"
        "- Each H2 section must have meaningful depth — at least 2–4 paragraphs or equivalent structured content.\n"
        "- Include concrete details: numbers, named processes, comparisons, or specific examples — not vague generalities.\n"
        "- Do not pad with repetition; every paragraph must add new information or a new angle.\n"
        "\n\nFAQ SECTION — AEO + GEO OPTIMIZATION (apply unless the user's writing instructions specify otherwise):\n"
        "- Include a ## Frequently Asked Questions section near the end, placed before the conclusion.\n"
        "- Write 4–6 Q&A pairs. Questions must mirror real user search queries (how to, what is, why, best, vs).\n"
        "- Each answer: 2–4 direct sentences — written to be cited by AI answer engines (Google AI Overview, Perplexity, ChatGPT).\n"
        "- At least one answer should include a short numbered process or bullet list for featured-snippet eligibility.\n"
        "- Do NOT write vague FAQ answers — each must be specific, factual, and standalone-readable.\n"
        "\nUSER PROMPT AUTHORITY: The writing instructions in the user message are the HIGHEST PRIORITY "
        "directive for this article. Follow them precisely and completely — they define the article's "
        "angle, tone, structure, depth, and focus. All other system requirements (including depth and FAQ) "
        "are subordinate to the user's prompt and should be adjusted or skipped if the user instructs it.\n"
        "\nReturn ONLY a JSON object with exactly these keys and no others: "
        '"article_markdown", "meta_title", "meta_description".\n'
        "Do not add commentary, explanations, or keys such as title, body, keywords, or choices.\n"
        "article_markdown must be well-structured with the required headings and lists, written in natural human voice.\n"
        "Meta title must be <= 60 chars if possible. Meta description <= 155 chars if possible.\n"
        "STRICT OUTPUT RULES — article_markdown MUST contain ONLY the article body:\n"
        "- Do NOT include 'Meta Title:', 'Meta Description:', 'SEO Title:' or any meta block inside article_markdown.\n"
        "- Do NOT include 'Focus Keyphrase:', 'Keywords:', 'Tags:', 'Slug:' or 'AI suggested keywords' inside article_markdown.\n"
        "- Do NOT include AI preamble or postamble.\n"
        "- Do NOT wrap article_markdown in code fences. Output it as plain markdown.\n"
        "- meta_title and meta_description must be plain text only — no quotes, no 'Meta Title:' prefix, no markdown.\n"
        "- Do NOT output code, poetry, scripts, or conversational text outside the JSON object."
        f"{format_ai_detector_banned_phrases_for_prompt()}"
        f"{format_banned_phrases_for_prompt()}"
        f"{flavor}"
        f"{product_rules}"
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
        f"Writing instructions (MANDATORY — follow every requirement below):\n{up}\n"
        "\nOutput the JSON object now.\n"
    )
    if platform_mapping and pc:
        user = f"{user}\n\n{pc}\n"
    return sys, user


def estimate_tokens_for_generation_bundle(
    *,
    title: str,
    keywords: list[str],
    focus_keyphrase: str,
    writing_prompt_text: str,
    brand_identity: str | None = None,
    niche_identifier: str | None = None,
    product_context: str | None = None,
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
    extra_kwargs.pop("content_optimization_profile", None)
    if extra_kwargs:
        log.debug("estimate_tokens_for_generation_bundle ignored keys: %s", sorted(extra_kwargs.keys()))
    return estimate_bundle_tokens(
        title=title,
        keywords=keywords,
        focus_keyphrase=focus_keyphrase,
        writing_prompt_text=writing_prompt_text,
        brand_identity=brand_identity,
        niche_identifier=niche_identifier,
        product_context=product_context,
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
    product_context: str | None = None,
    generate_image: bool,
    image_prompt_text: str | None = None,
    reference_image_url: str | None = None,
    shopify_mapped_products: list[dict[str, str]] | None = None,
    wordpress_mapped_pages: list[dict[str, str]] | None = None,
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
    extra_kwargs.pop("content_optimization_profile", None)
    extra_kwargs.pop("humanization_settings", None)
    image_prompt_text = (str(image_prompt_text).strip() if image_prompt_text is not None else "") or None
    if extra_kwargs:
        log.debug("generate_article_bundle ignored keys: %s", sorted(extra_kwargs.keys()))
    shopify_for_injection: list[Any] = []
    if shopify_mapped_products:
        try:
            from app.services.shopify_product_pipeline import (
                ensure_shopify_product_injection,
                normalize_mapped_products,
            )

            shopify_for_injection = normalize_mapped_products(shopify_mapped_products)
        except Exception:
            log.debug("Shopify mapped product normalization skipped", exc_info=True)
            shopify_for_injection = []

    wp_for_injection: list[Any] = []
    if wordpress_mapped_pages:
        try:
            from app.services.wordpress_content_pipeline import (
                ensure_wordpress_page_injection,
                normalize_mapped_pages,
            )

            wp_for_injection = normalize_mapped_pages(wordpress_mapped_pages)
        except Exception:
            log.debug("WordPress mapped page normalization skipped", exc_info=True)
            wp_for_injection = []

    client = OpenAIClient()

    pc_raw = product_context or ""
    shopify_mapping = bool(shopify_for_injection) or "Shopify product context" in pc_raw
    wp_mapping = bool(wp_for_injection) or "WordPress internal page" in pc_raw

    sys, user = build_generation_messages(
        title=title,
        keywords=keywords,
        focus_keyphrase=focus_keyphrase,
        writing_prompt_text=writing_prompt_text,
        brand_identity=brand_identity,
        niche_identifier=niche_identifier,
        product_context=product_context,
        shopify_product_mapping=shopify_mapping or bool(shopify_for_injection),
        wordpress_content_mapping=wp_mapping or bool(wp_for_injection),
    )

    obj = await client.chat_json(model=settings.openai_text_model, system=sys, user=user)
    obj = enforce_strict_article_json(dict(obj))

    article_md = sanitize_article_body(obj.get("article_markdown"))
    meta_title = sanitize_meta_title(obj.get("meta_title"))
    meta_desc = sanitize_meta_description(obj.get("meta_description"))

    if not article_md:
        raise RuntimeError("Generated article is empty")

    if shopify_for_injection:
        try:
            from app.services.shopify_product_pipeline import ensure_shopify_product_injection

            article_md = ensure_shopify_product_injection(article_md, shopify_for_injection)
        except Exception:
            log.exception("Shopify post-generation product injection failed")

    if wp_for_injection:
        try:
            from app.services.wordpress_content_pipeline import ensure_wordpress_page_injection

            article_md = ensure_wordpress_page_injection(article_md, wp_for_injection)
        except Exception:
            log.exception("WordPress post-generation page injection failed")

    image_url: str | None = None
    image_error: str | None = None
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
        ref_url = (reference_image_url or "").strip() or None
        try:
            image_url = await asyncio.wait_for(
                client.generate_image_url(
                    model=settings.openai_image_model,
                    prompt=image_prompt,
                    reference_image_url=ref_url,
                ),
                timeout=300.0,
            )
            if not image_url:
                image_error = "Image model returned no image (empty response)."
        except Exception as e:
            log.exception("Image generation failed (returning without image_url)")
            image_error = str(e)[:500] or "Image generation failed"

    return {
        "article": article_md,
        "meta_title": meta_title,
        "meta_description": meta_desc,
        "image_url": image_url,
        "image_error": image_error,
        "generated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        "models": {"text": settings.openai_text_model, "image": settings.openai_image_model},
        "shopify_mapped_products": [
            p.as_dict() if hasattr(p, "as_dict") else dict(p) for p in (shopify_for_injection or [])
        ],
        "wp_mapped_pages": [
            p.as_dict() if hasattr(p, "as_dict") else dict(p) for p in (wp_for_injection or [])
        ],
    }


async def generate_featured_image_only(
    *,
    title: str,
    keywords: list[str],
    focus_keyphrase: str,
    brand_identity: str | None = None,
    niche_identifier: str | None = None,
    image_prompt_text: str | None = None,
    reference_image_url: str | None = None,
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
    ref_url = (reference_image_url or "").strip() or None
    try:
        image_url = await asyncio.wait_for(
            client.generate_image_url(
                model=settings.openai_image_model,
                prompt=image_prompt,
                reference_image_url=ref_url,
            ),
            timeout=300.0,
        )
    except Exception as e:
        log.exception("Featured image generation failed")
        raise RuntimeError(f"OpenAI image request failed: {e}") from e
    if not image_url:
        raise RuntimeError("Image generation did not return an image (empty response from model).")
    return {
        "image_url": image_url,
        "image_prompt": image_prompt,
        "generated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        "model": settings.openai_image_model,
    }
