"""Unit tests for Shopify-only product mapping helpers."""

from __future__ import annotations

from app.services.shopify_product_pipeline import (
    build_product_showcase_html,
    ensure_shopify_product_injection,
    is_valid_product_image_url,
    normalize_mapped_products,
    resolve_shopify_generation_context,
)


def test_normalize_mapped_products_accepts_aliases() -> None:
    raw = [
        {
            "title": "Organic Serum",
            "handle": "organic-serum",
            "image_url": "https://cdn.shopify.com/serum.jpg",
        },
        {"title": "", "handle": "bad"},
        {"name": "Ignored", "handle": "not valid handle!!!"},
    ]
    products = normalize_mapped_products(raw)
    assert len(products) == 1
    assert products[0].title == "Organic Serum"
    assert products[0].handle == "organic-serum"
    assert products[0].product_path == "/products/organic-serum"
    assert products[0].featured_image_url.startswith("https://")


def test_normalize_mapped_products_strips_products_prefix() -> None:
    products = normalize_mapped_products(
        [{"title": "Hat", "handle": "products/wool-hat", "featured_image_url": ""}]
    )
    assert len(products) == 1
    assert products[0].handle == "wool-hat"


def test_ensure_shopify_product_injection_appends_showcase_when_missing_link() -> None:
    products = normalize_mapped_products(
        [{"title": "Hat", "handle": "wool-hat", "featured_image_url": "https://cdn.example/hat.png"}]
    )
    body = "## Guide\n\nNo product links here."
    out = ensure_shopify_product_injection(body, products)
    assert "/products/wool-hat" in out
    assert "riviso-product-showcase" in out
    assert "View product" in out


def test_ensure_shopify_product_injection_skips_when_link_present() -> None:
    products = normalize_mapped_products([{"title": "Hat", "handle": "wool-hat"}])
    body = "See our [Hat](/products/wool-hat) for details."
    out = ensure_shopify_product_injection(body, products)
    assert "riviso-product-showcase" not in out


def test_resolve_shopify_generation_context_explicit_products_without_toggle() -> None:
    ctx = resolve_shopify_generation_context(
        proj={"platform": "shopify", "shopify_product_aware_enabled": False},
        title="Serum guide",
        keywords=["serum"],
        focus_keyphrase="serum",
        mapped_products_raw=[
            {
                "title": "Organic Serum",
                "handle": "organic-serum",
                "featured_image_url": "https://cdn.shopify.com/serum.jpg",
            }
        ],
    )
    assert ctx.product_context
    assert len(ctx.mapped_products) == 1
    assert ctx.reference_image_url == "https://cdn.shopify.com/serum.jpg"


def test_resolve_shopify_generation_context_non_shopify_returns_empty() -> None:
    ctx = resolve_shopify_generation_context(
        proj={"platform": "wordpress", "shopify_product_aware_enabled": True},
        title="Test",
        keywords=["a"],
        focus_keyphrase="test",
        mapped_products_raw=[{"title": "X", "handle": "x"}],
    )
    assert ctx.product_context is None
    assert ctx.mapped_products == []


def test_resolve_shopify_generation_context_uses_mapped_when_enabled() -> None:
    ctx = resolve_shopify_generation_context(
        proj={"platform": "shopify", "shopify_product_aware_enabled": True},
        title="Serum guide",
        keywords=["serum"],
        focus_keyphrase="serum",
        mapped_products_raw=[
            {
                "title": "Organic Serum",
                "handle": "organic-serum",
                "featured_image_url": "https://cdn.shopify.com/serum.jpg",
            }
        ],
    )
    assert ctx.product_context
    assert "/products/organic-serum" in ctx.product_context
    assert len(ctx.mapped_products) == 1
    assert ctx.reference_image_url == "https://cdn.shopify.com/serum.jpg"


def test_is_valid_product_image_url() -> None:
    assert is_valid_product_image_url("https://cdn.shopify.com/a.jpg")
    assert not is_valid_product_image_url("")
    assert not is_valid_product_image_url("not-a-url")


def test_resolve_explicit_empty_list_skips_catalog_fallback() -> None:
    ctx = resolve_shopify_generation_context(
        proj={
            "platform": "shopify",
            "shopify_product_aware_enabled": True,
            "shopify_catalog": {
                "products": [{"name": "Fallback", "handle": "fallback", "url": "/products/fallback"}],
            },
        },
        title="Guide",
        keywords=["guide"],
        focus_keyphrase="guide",
        mapped_products_raw=[],
    )
    assert ctx.product_context is None
    assert ctx.mapped_products == []


def test_resolve_malformed_explicit_products_no_catalog() -> None:
    ctx = resolve_shopify_generation_context(
        proj={"platform": "shopify", "shopify_product_aware_enabled": True},
        title="Guide",
        keywords=["guide"],
        focus_keyphrase="guide",
        mapped_products_raw=[{"title": "", "handle": "!!!"}],
    )
    assert ctx.mapped_products == []


def test_build_product_showcase_html_without_image() -> None:
    from app.services.shopify_product_pipeline import ShopifyMappedProduct

    html = build_product_showcase_html(
        ShopifyMappedProduct(
            title="Hat",
            handle="hat",
            featured_image_url="",
            product_path="/products/hat",
        )
    )
    assert "<img" not in html
    assert "/products/hat" in html
