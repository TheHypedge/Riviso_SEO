"""
Platform-scoped generation extras — routes Shopify vs WordPress without cross-contamination.

WordPress publish/generation code paths that do not call this module remain unchanged.
"""
from __future__ import annotations

import logging
from typing import Any

from app.services.shopify_product_pipeline import (
    is_shopify_project,
    resolve_shopify_generation_context,
    serialize_mapped_products_for_storage,
    shopify_product_aware_enabled,
)
from app.services.wordpress_content_pipeline import (
    is_wordpress_project,
    resolve_wordpress_generation_context,
    serialize_mapped_pages_for_storage,
    wp_internal_link_aware_enabled,
)

_log = logging.getLogger(__name__)


def resolve_platform_generation_extras(
    *,
    proj: dict[str, Any],
    title: str,
    keywords: list[str],
    focus: str,
    mapped_products: list[dict] | None = None,
    mapped_pages: list[dict] | None = None,
) -> dict[str, Any]:
    """
    Return optional keys for :func:`generate_article_bundle_safe`:

    - ``product_context`` — LLM prompt block (Shopify products or WordPress pages)
    - ``reference_image_url`` — img2img style reference when valid
    - ``shopify_mapped_products`` / ``wp_mapped_pages`` — persisted on the article row
    """
    if is_shopify_project(proj):
        return _shopify_extras(
            proj=proj,
            title=title,
            keywords=keywords,
            focus=focus,
            mapped_products=mapped_products,
        )
    if is_wordpress_project(proj):
        return _wordpress_extras(
            proj=proj,
            title=title,
            keywords=keywords,
            focus=focus,
            mapped_pages=mapped_pages,
        )
    return {}


def _shopify_extras(
    *,
    proj: dict[str, Any],
    title: str,
    keywords: list[str],
    focus: str,
    mapped_products: list[dict] | None,
) -> dict[str, Any]:
    has_explicit = mapped_products is not None
    if not has_explicit and not shopify_product_aware_enabled(proj):
        return {}
    try:
        ctx = resolve_shopify_generation_context(
            proj=proj,
            title=title,
            keywords=keywords,
            focus_keyphrase=focus,
            mapped_products_raw=mapped_products if has_explicit else None,
        )
    except Exception:
        _log.debug("Shopify generation extras failed; continuing without product mapping", exc_info=True)
        return {}
    extras: dict[str, Any] = {}
    if ctx.product_context:
        extras["product_context"] = ctx.product_context
    if ctx.reference_image_url:
        extras["reference_image_url"] = ctx.reference_image_url
    if ctx.mapped_products:
        extras["shopify_mapped_products"] = serialize_mapped_products_for_storage(ctx.mapped_products)
    return extras


def _wordpress_extras(
    *,
    proj: dict[str, Any],
    title: str,
    keywords: list[str],
    focus: str,
    mapped_pages: list[dict] | None,
) -> dict[str, Any]:
    has_explicit = mapped_pages is not None
    if not has_explicit and not wp_internal_link_aware_enabled(proj):
        return {}
    try:
        ctx = resolve_wordpress_generation_context(
            proj=proj,
            title=title,
            keywords=keywords,
            focus_keyphrase=focus,
            mapped_pages_raw=mapped_pages if has_explicit else None,
        )
    except Exception:
        _log.debug("WordPress generation extras failed; continuing without page mapping", exc_info=True)
        return {}
    extras: dict[str, Any] = {}
    if ctx.product_context:
        extras["product_context"] = ctx.product_context
    if ctx.reference_image_url:
        extras["reference_image_url"] = ctx.reference_image_url
    if ctx.mapped_pages:
        extras["wp_mapped_pages"] = serialize_mapped_pages_for_storage(ctx.mapped_pages)
    return extras
