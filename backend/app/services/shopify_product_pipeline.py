"""
Shopify-only product mapping, prompt context, post-generation injection, and image reference helpers.

WordPress and other platforms must not import this module from shared hot paths unless
guarded by ``is_shopify_project``.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from app.services.shopify_product_context import format_product_context, select_relevant_shopify_products

log = logging.getLogger(__name__)

_HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9\-]*$", re.IGNORECASE)


@dataclass(frozen=True)
class ShopifyMappedProduct:
    title: str
    handle: str
    featured_image_url: str
    product_path: str

    def as_dict(self) -> dict[str, str]:
        return {
            "title": self.title,
            "handle": self.handle,
            "featured_image_url": self.featured_image_url,
            "product_path": self.product_path,
        }


@dataclass(frozen=True)
class ShopifyGenerationContext:
    """Resolved Shopify product inputs for a single generation run."""

    product_context: str | None
    mapped_products: list[ShopifyMappedProduct]
    reference_image_url: str | None


def is_shopify_project(proj: dict[str, Any]) -> bool:
    return ((proj.get("platform") or "").strip().lower() == "shopify")


def shopify_product_aware_enabled(proj: dict[str, Any]) -> bool:
    return bool(proj.get("shopify_product_aware_enabled", False))


def is_valid_product_image_url(raw: str) -> bool:
    s = (raw or "").strip()
    if not s:
        return False
    if s.startswith("//"):
        return True
    try:
        u = urlparse(s)
    except Exception:
        return False
    return u.scheme in ("http", "https") and bool(u.netloc)


def normalize_mapped_products(raw: Any, *, max_items: int = 5) -> list[ShopifyMappedProduct]:
    """
    Parse frontend / queue payload product objects.

    Accepts ``featured_image_url`` or ``image_url`` for the hero image field.
    Silently drops malformed rows (fallback: catalog auto-select).
    """
    if not isinstance(raw, list):
        return []
    out: list[ShopifyMappedProduct] = []
    for item in raw[: max(0, int(max_items))]:
        if not isinstance(item, dict):
            continue
        try:
            title = str(item.get("title") or item.get("name") or "").strip()[:500]
            handle = str(item.get("handle") or "").strip().lstrip("/").split("?")[0].split("#")[0][:256]
            if handle.startswith("products/"):
                handle = handle.split("/", 1)[1]
            image = (
                str(item.get("featured_image_url") or item.get("image_url") or item.get("image") or "")
                .strip()[:4000]
            )
            if not title or not handle or not _HANDLE_RE.match(handle):
                continue
            path = f"/products/{handle}"
            out.append(
                ShopifyMappedProduct(
                    title=title,
                    handle=handle,
                    featured_image_url=image if is_valid_product_image_url(image) else "",
                    product_path=path,
                )
            )
        except Exception:
            log.debug("Skipping malformed mapped Shopify product row", exc_info=True)
            continue
    return out


def _catalog_fallback_products(
    *,
    proj: dict[str, Any],
    title: str,
    keywords: list[str],
    focus_keyphrase: str,
    max_products: int,
) -> list[ShopifyMappedProduct]:
    try:
        rows = select_relevant_shopify_products(
            proj=proj,
            title=title,
            keywords=keywords,
            focus_keyphrase=focus_keyphrase,
            max_products=max_products,
        )
    except Exception:
        log.debug("Shopify catalog product selection failed", exc_info=True)
        return []
    out: list[ShopifyMappedProduct] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = (row.get("name") or "").strip()
        url = (row.get("url") or "").strip()
        handle = ""
        if "/products/" in url:
            handle = url.split("/products/", 1)[-1].split("?")[0].split("#")[0].strip()
        if not name or not handle:
            continue
        image = ""
        catalog_products = _load_shopify_catalog_products(proj)
        for p in catalog_products:
            if isinstance(p, dict) and str(p.get("handle") or "").strip() == handle:
                image = str(p.get("image_url") or p.get("featured_image_url") or "").strip()
                break
        out.append(
            ShopifyMappedProduct(
                title=name,
                handle=handle,
                featured_image_url=image if is_valid_product_image_url(image) else "",
                product_path=f"/products/{handle}",
            )
        )
    return out


def format_shopify_product_context(products: list[ShopifyMappedProduct]) -> str:
    if not products:
        return ""
    lines = [
        "Shopify product context (use naturally; do not invent products or URLs):",
        "Use relative product paths exactly as given (e.g. /products/handle) for markdown links.",
    ]
    for p in products:
        price_note = ""
        lines.append(f"- {p.title} — Path: {p.product_path}{price_note}")
        if p.featured_image_url:
            lines.append(f"  Featured image (reference only, do not embed as hotlink unless appropriate): {p.featured_image_url}")
    return "\n".join(lines).strip()


def resolve_shopify_generation_context(
    *,
    proj: dict[str, Any],
    title: str,
    keywords: list[str],
    focus_keyphrase: str,
    mapped_products_raw: Any | None = None,
    max_products: int = 3,
) -> ShopifyGenerationContext:
    """
    Build product prompt context and optional reference image URL for Shopify projects only.

    Returns empty context when platform is not Shopify, or when product-aware mode is off
    and the caller did not pass explicit mapped products.

  When ``mapped_products_raw`` is provided (including ``[]``), catalog auto-select is skipped
    so the run falls back to a standard non-product-mapped article (Fallback 2).
    """
    empty = ShopifyGenerationContext(product_context=None, mapped_products=[], reference_image_url=None)
    if not is_shopify_project(proj):
        return empty

    explicit_request = mapped_products_raw is not None
    products = (
        normalize_mapped_products(mapped_products_raw, max_items=max_products)
        if explicit_request
        else []
    )

    if not products:
        if explicit_request:
            # Caller sent [] or only malformed rows — standard informational article, no catalog.
            log.debug(
                "Shopify explicit product mapping empty; skipping catalog fallback (title=%r)",
                (title or "")[:80],
            )
            return empty
        if not shopify_product_aware_enabled(proj):
            return empty
        try:
            products = _catalog_fallback_products(
                proj=proj,
                title=title,
                keywords=keywords,
                focus_keyphrase=focus_keyphrase,
                max_products=max_products,
            )
        except Exception:
            log.debug("Shopify catalog fallback failed", exc_info=True)
            products = []

    if not products:
        return empty

    try:
        ctx = format_shopify_product_context(products)
    except Exception:
        log.exception("Shopify product context formatting failed")
        ctx = format_product_context(
            [{"name": p.title, "url": p.product_path, "price": ""} for p in products]
        )

    reference: str | None = None
    for p in products:
        if is_valid_product_image_url(p.featured_image_url):
            reference = p.featured_image_url
            break

    return ShopifyGenerationContext(
        product_context=ctx or None,
        mapped_products=products,
        reference_image_url=reference,
    )


def _body_contains_product_reference(body: str, product: ShopifyMappedProduct) -> bool:
    text = body or ""
    if not text.strip():
        return False
    handle = product.handle
    patterns = (
        product.product_path,
        f"/products/{handle}",
        f"]({product.product_path})",
        f"products/{handle}",
        product.title,
    )
    lower = text.lower()
    return any((p or "").lower() in lower for p in patterns if p)


def build_product_showcase_html(product: ShopifyMappedProduct) -> str:
    img = (
        f'<img src="{product.featured_image_url}" alt="{_html_escape(product.title)}" '
        f'style="max-width:100%;height:auto;border-radius:8px;display:block;margin:0 auto 12px;" loading="lazy" />'
        if is_valid_product_image_url(product.featured_image_url)
        else ""
    )
    return (
        '\n\n<div class="riviso-product-showcase" style="margin:2rem 0;padding:1.25rem;'
        'border:1px solid #e5e5e5;border-radius:12px;background:#fafafa;text-align:center;">\n'
        f"{img}"
        f'<p style="margin:0 0 0.75rem;font-size:1.05rem;font-weight:600;">{_html_escape(product.title)}</p>\n'
        f'<p style="margin:0;"><a href="{_html_escape(product.product_path)}" '
        f'style="display:inline-block;padding:0.6rem 1.25rem;background:#111;color:#fff;'
        f'text-decoration:none;border-radius:6px;font-weight:600;">View product</a></p>\n'
        "</div>\n"
    )


def _html_escape(s: str) -> str:
    return (
        (s or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def ensure_shopify_product_injection(
    article_body: str,
    products: list[ShopifyMappedProduct],
) -> str:
    """
    Ensure at least one product link exists; append a native HTML showcase card if missing.
    """
    body = (article_body or "").strip()
    if not products:
        return body
    primary = products[0]
    try:
        if _body_contains_product_reference(body, primary):
            return body
        for p in products[1:]:
            if _body_contains_product_reference(body, p):
                return body
        return f"{body}{build_product_showcase_html(primary)}"
    except Exception:
        log.exception("Shopify product injection failed; returning original body")
        return body


def serialize_mapped_products_for_storage(products: list[ShopifyMappedProduct]) -> list[dict[str, str]]:
    return [p.as_dict() for p in products if p.title and p.handle]
