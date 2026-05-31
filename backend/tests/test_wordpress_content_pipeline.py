"""Unit tests for WordPress-only page mapping helpers."""

from __future__ import annotations

from app.services.platform_generation import resolve_platform_generation_extras
from app.services.wordpress_content_pipeline import (
    build_page_showcase_html,
    ensure_wordpress_page_injection,
    is_wordpress_project,
    normalize_mapped_pages,
    resolve_wordpress_generation_context,
)


def test_is_wordpress_project_default() -> None:
    assert is_wordpress_project({"platform": "wordpress"})
    assert not is_wordpress_project({"platform": "shopify"})


def test_normalize_mapped_pages() -> None:
    pages = normalize_mapped_pages(
        [{"title": "About Us", "post_url": "https://example.com/about-us/", "featured_image_url": "https://cdn/x.jpg"}],
        site_base="https://example.com",
    )
    assert len(pages) == 1
    assert pages[0].post_url.startswith("https://")


def test_ensure_wordpress_page_injection_appends_showcase() -> None:
    pages = normalize_mapped_pages([{"title": "Guide", "post_url": "https://example.com/guide/"}])
    out = ensure_wordpress_page_injection("## Intro\n\nNo links.", pages)
    assert "https://example.com/guide/" in out
    assert "riviso-wp-page-showcase" in out


def test_resolve_explicit_empty_skips_site_map() -> None:
    ctx = resolve_wordpress_generation_context(
        proj={
            "platform": "wordpress",
            "wp_internal_link_aware_enabled": True,
            "id": "p1",
        },
        title="Test",
        keywords=["test"],
        focus_keyphrase="test",
        mapped_pages_raw=[],
    )
    assert ctx.mapped_pages == []


def test_platform_generation_wordpress_extras() -> None:
    extras = resolve_platform_generation_extras(
        proj={"platform": "wordpress", "wp_internal_link_aware_enabled": False},
        title="T",
        keywords=["k"],
        focus="k",
        mapped_pages=[
            {"title": "Post", "post_url": "https://blog.example.com/post/", "featured_image_url": "https://cdn/p.jpg"},
        ],
    )
    assert extras.get("product_context")
    assert extras.get("reference_image_url")
    assert extras.get("wp_mapped_pages")


def test_platform_generation_shopify_unchanged() -> None:
    extras = resolve_platform_generation_extras(
        proj={"platform": "shopify", "shopify_product_aware_enabled": False},
        title="T",
        keywords=["k"],
        focus="k",
        mapped_products=[{"title": "Hat", "handle": "hat", "featured_image_url": "https://cdn/h.jpg"}],
    )
    assert extras.get("shopify_mapped_products")
    assert "wp_mapped_pages" not in extras


def test_build_page_showcase_without_image() -> None:
    from app.services.wordpress_content_pipeline import WordPressMappedPage

    html = build_page_showcase_html(
        WordPressMappedPage(title="Post", post_url="https://x.com/p/", featured_image_url="", post_id="1"),
    )
    assert "<img" not in html
    assert "Read more" in html
