"""Sync Shopify catalog into project storage for Riviso content workflows."""
from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any, Awaitable, Callable

import httpx

from app.services.shopify_api_errors import (
    RECOMMENDED_SCOPES,
    REQUIRED_SYNC_SCOPES,
    SCOPE_SETUP_MESSAGE,
    SCOPE_STALE_TOKEN_MESSAGE,
    ShopifyApiError,
    access_denied_diagnosis,
    format_token_scopes_list,
    http_error_to_shopify_api_error,
    parse_granted_scopes,
    resource_scope_satisfied,
    scope_confusion_note,
    scopes_missing_for_sync,
    warning_dict,
)
from app.services.shopify_client import ShopifyClient


async def _resolve_granted_scopes(
    *,
    client: ShopifyClient,
    granted_scope: str,
) -> set[str]:
    """Prefer live token scopes from Shopify over the stored scope string."""
    try:
        live = await client.fetch_access_scopes()
        if live:
            return set(live)
    except Exception:
        pass
    return parse_granted_scopes(granted_scope)


def _product_summary(p: dict[str, Any]) -> dict[str, Any]:
    image_url = ""
    images = p.get("images") or []
    if isinstance(images, list) and images and isinstance(images[0], dict):
        image_url = (images[0].get("src") or "").strip()
    price = ""
    variants = p.get("variants") or []
    if isinstance(variants, list) and variants and isinstance(variants[0], dict):
        price = str(variants[0].get("price") or "").strip()
    return {
        "id": p.get("id"),
        "title": (p.get("title") or "").strip(),
        "handle": (p.get("handle") or "").strip(),
        "product_type": (p.get("product_type") or "").strip(),
        "vendor": (p.get("vendor") or "").strip(),
        "status": (p.get("status") or "").strip(),
        "tags": (p.get("tags") or "").strip(),
        "image_url": image_url,
        "price": price,
        "updated_at": (p.get("updated_at") or "").strip(),
    }


def _collection_summary(c: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": c.get("id"),
        "title": (c.get("title") or "").strip(),
        "handle": (c.get("handle") or "").strip(),
        "updated_at": (c.get("updated_at") or "").strip(),
    }


def _blog_summary(b: dict[str, Any], *, articles_count: int = 0) -> dict[str, Any]:
    return {
        "id": b.get("id"),
        "title": (b.get("title") or "").strip(),
        "handle": (b.get("handle") or "").strip(),
        "updated_at": (b.get("updated_at") or "").strip(),
        "articles_count": max(0, int(articles_count or 0)),
    }


def _page_summary(pg: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": pg.get("id"),
        "title": (pg.get("title") or "").strip(),
        "handle": (pg.get("handle") or "").strip(),
        "updated_at": (pg.get("updated_at") or "").strip(),
    }


async def _fetch_resource(
    *,
    resource: str,
    fetcher: Callable[[], Awaitable[list[dict[str, Any]]]],
    warnings: list[dict[str, str]],
    granted: set[str] | None = None,
) -> list[dict[str, Any]]:
    granted_set = granted or set()
    try:
        return await fetcher()
    except httpx.HTTPStatusError as exc:
        warnings.append(
            warning_dict(
                resource=resource,
                exc=http_error_to_shopify_api_error(exc, resource=resource, granted=granted_set),
            )
        )
        return []
    except ShopifyApiError as exc:
        warnings.append(warning_dict(resource=resource, exc=exc))
        return []
    except Exception as exc:
        warnings.append(warning_dict(resource=resource, exc=exc))
        return []


def build_sync_status_message(*, counts: dict[str, int], warnings: list[dict[str, str]]) -> tuple[str, str]:
    """
    Returns (sync_status, human message).
    sync_status: ok | partial | error
    """
    products = int(counts.get("products") or 0)
    if warnings:
        product_warn = next((w for w in warnings if w.get("resource") == "products"), None)
        if product_warn and products == 0:
            scope = (product_warn.get("required_scope") or "read_products").strip()
            return (
                "partial",
                f"Store connected, but products could not be synced. Enable `{scope}` on your Shopify app "
                f"version, release it, then reconnect. {SCOPE_SETUP_MESSAGE}",
            )
        parts = [f"Synced {products} products"]
        if counts.get("blogs"):
            parts.append(f"{counts['blogs']} blogs")
        if counts.get("pages"):
            parts.append(f"{counts['pages']} pages")
        return ("partial", f"{', '.join(parts)}. Some resources were skipped — see sync warnings.")

    if products == 0:
        return (
            "ok",
            "Sync completed. No products were returned (store may have no products, or filters excluded all items).",
        )
    return (
        "ok",
        f"Synced {products} products, {counts.get('collections', 0)} collections, "
        f"{counts.get('blogs', 0)} blogs, {counts.get('pages', 0)} pages.",
    )


async def sync_shopify_catalog(
    *,
    shop: str,
    access_token: str,
    granted_scope: str = "",
) -> dict[str, Any]:
    """
    Best-effort catalog sync. Individual resource failures (e.g. missing read_products)
    are recorded in ``warnings`` instead of failing the entire sync.
    """
    client = ShopifyClient(shop=shop, access_token=access_token)
    warnings: list[dict[str, str]] = []

    granted = await _resolve_granted_scopes(client=client, granted_scope=granted_scope)
    confusion = scope_confusion_note(granted)
    for missing in scopes_missing_for_sync(granted):
        warnings.append(
            {
                "resource": "scopes",
                "code": "scope_not_granted",
                "required_scope": missing,
                "message": (
                    f"This store's API token does not include `{missing}` (live check via Shopify). "
                    f"On token now: {format_token_scopes_list(granted)}."
                    f"{confusion} {SCOPE_SETUP_MESSAGE} {SCOPE_STALE_TOKEN_MESSAGE}"
                ),
            }
        )

    if granted and not resource_scope_satisfied(granted, "products"):
        warnings.append(
            {
                "resource": "scopes",
                "code": "scope_not_granted",
                "required_scope": "read_products",
                "message": (
                    "Enable Admin API → Products → read_products (and write_products if you publish "
                    f"product updates). Feeds/listings scopes alone are not enough. "
                    f"Token scopes now: {format_token_scopes_list(granted)}."
                ),
            }
        )

    # P2.5: shop metadata + the five catalog resources are independent Shopify REST
    # reads; fetch them concurrently instead of serially. httpx.AsyncClient is built
    # for concurrent requests and get_paginated handles per-resource throttling.
    shop_data, products_raw, custom_cols, smart_cols, blogs_raw, pages_raw = await asyncio.gather(
        client.get_json("/shop.json"),
        _fetch_resource(
            resource="products",
            fetcher=lambda: client.get_paginated("/products.json", resource_key="products", max_pages=4),
            warnings=warnings,
            granted=granted,
        ),
        _fetch_resource(
            resource="collections",
            fetcher=lambda: client.get_paginated("/custom_collections.json", resource_key="custom_collections", max_pages=2),
            warnings=warnings,
            granted=granted,
        ),
        _fetch_resource(
            resource="collections",
            fetcher=lambda: client.get_paginated("/smart_collections.json", resource_key="smart_collections", max_pages=2),
            warnings=warnings,
            granted=granted,
        ),
        _fetch_resource(
            resource="blogs",
            fetcher=lambda: client.get_paginated("/blogs.json", resource_key="blogs", max_pages=2),
            warnings=warnings,
            granted=granted,
        ),
        _fetch_resource(
            resource="pages",
            fetcher=lambda: client.get_paginated("/pages.json", resource_key="pages", max_pages=2),
            warnings=warnings,
            granted=granted,
        ),
    )
    shop_info = shop_data.get("shop") if isinstance(shop_data.get("shop"), dict) else {}

    article_counts_by_blog: dict[int, int] = {}
    if blogs_raw and resource_scope_satisfied(granted, "blogs"):
        try:
            articles_for_count = await client.get_paginated(
                "/articles.json",
                resource_key="articles",
                max_pages=2,
                params={"limit": "250"},
            )
            for row in articles_for_count:
                if not isinstance(row, dict):
                    continue
                bid = row.get("blog_id")
                if bid is None:
                    continue
                try:
                    key = int(bid)
                except (TypeError, ValueError):
                    continue
                article_counts_by_blog[key] = article_counts_by_blog.get(key, 0) + 1
        except Exception:
            pass

    products = [_product_summary(p) for p in products_raw[:500]]
    collections = [_collection_summary(c) for c in (custom_cols + smart_cols)[:200]]
    blogs = []
    for b in blogs_raw[:50]:
        if not isinstance(b, dict):
            continue
        bid = b.get("id")
        try:
            count = article_counts_by_blog.get(int(bid), 0) if bid is not None else 0
        except (TypeError, ValueError):
            count = 0
        blogs.append(_blog_summary(b, articles_count=count))
    pages = [_page_summary(pg) for pg in pages_raw[:100]]

    metadata = {
        "name": (shop_info.get("name") or "").strip(),
        "email": (shop_info.get("email") or "").strip(),
        "domain": (shop_info.get("domain") or "").strip(),
        "myshopify_domain": (shop_info.get("myshopify_domain") or "").strip(),
        "currency": (shop_info.get("currency") or "").strip(),
        "country_code": (shop_info.get("country_code") or "").strip(),
        "plan_name": (shop_info.get("plan_name") or "").strip(),
    }

    counts = {
        "products": len(products),
        "collections": len(collections),
        "blogs": len(blogs),
        "pages": len(pages),
    }

    sync_status, sync_message = build_sync_status_message(counts=counts, warnings=warnings)

    return {
        "synced_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        "sync_status": sync_status,
        "sync_message": sync_message,
        "warnings": warnings,
        "granted_scopes": sorted(granted) if granted else [],
        "required_scopes": list(REQUIRED_SYNC_SCOPES),
        "recommended_scopes": list(RECOMMENDED_SCOPES),
        "counts": counts,
        "shop": metadata,
        "products": products,
        "collections": collections,
        "blogs": blogs,
        "pages": pages,
    }
