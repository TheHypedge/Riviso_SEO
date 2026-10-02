"""Unit tests for the schema-markup (JSON-LD) builder used at WordPress publish/update."""

from __future__ import annotations

import json

from app.services.schema_markup import (
    build_article_jsonld,
    build_faq_jsonld,
    build_schema_meta,
    extract_faq_pairs,
)

NEW_FORMAT_FAQ = """## Frequently Asked Questions

### What is schema markup?

Schema markup is structured data that helps search engines understand a page.

### How long does it take to show up in search results?

It can take anywhere from a few days to a few weeks, depending on crawl frequency.

## Conclusion

Wrap-up text here.
"""

LEGACY_FORMAT_FAQ = """## Frequently Asked Questions

**What is schema markup?**

Schema markup is structured data that helps search engines understand a page.

**How long does it take to show up in search results?**

It can take anywhere from a few days to a few weeks.
"""

NO_FAQ_MARKDOWN = "## Intro\n\nJust a regular article with no FAQ section.\n"


def test_extract_faq_pairs_new_h3_format() -> None:
    pairs = extract_faq_pairs(NEW_FORMAT_FAQ)
    assert len(pairs) == 2
    assert pairs[0]["question"] == "What is schema markup?"
    assert "structured data" in pairs[0]["answer"]
    assert pairs[1]["question"].startswith("How long")


def test_extract_faq_pairs_legacy_bold_format() -> None:
    pairs = extract_faq_pairs(LEGACY_FORMAT_FAQ)
    assert len(pairs) == 2
    assert pairs[0]["question"] == "What is schema markup?"


def test_extract_faq_pairs_no_faq_section() -> None:
    assert extract_faq_pairs(NO_FAQ_MARKDOWN) == []
    assert extract_faq_pairs("") == []
    assert extract_faq_pairs(None) == []  # type: ignore[arg-type]


def test_build_faq_jsonld_shape() -> None:
    pairs = extract_faq_pairs(NEW_FORMAT_FAQ)
    data = build_faq_jsonld(pairs)
    assert data["@type"] == "FAQPage"
    assert len(data["mainEntity"]) == 2
    q0 = data["mainEntity"][0]
    assert q0["@type"] == "Question"
    assert q0["acceptedAnswer"]["@type"] == "Answer"


def test_build_faq_jsonld_empty() -> None:
    assert build_faq_jsonld([]) is None


def test_build_article_jsonld_requires_title_and_url() -> None:
    article = {"title": "", "wp_link": "https://example.com/post/"}
    assert build_article_jsonld(article, {"name": "Acme"}) is None
    article2 = {"title": "A Post", "wp_link": ""}
    assert build_article_jsonld(article2, {"name": "Acme"}) is None


def test_build_article_jsonld_full() -> None:
    article = {
        "title": "A Post",
        "wp_link": "https://example.com/post/",
        "meta_description": "A short description.",
        "posted_at": "2026-01-01 00:00:00",
        "wp_featured_image_url": "https://example.com/img.jpg",
    }
    data = build_article_jsonld(article, {"name": "Acme Co"})
    assert data["@type"] == "BlogPosting"
    assert data["headline"] == "A Post"
    assert data["publisher"]["name"] == "Acme Co"
    assert data["image"] == "https://example.com/img.jpg"


def test_build_schema_meta_disabled_returns_empty() -> None:
    article = {"article": NEW_FORMAT_FAQ, "title": "X", "wp_link": "https://example.com/x/"}
    project = {"schema_markup_enabled": False, "name": "Acme"}
    assert build_schema_meta(article, project, "yoast") == {}


def test_build_schema_meta_rank_math_platform() -> None:
    article = {"article": NEW_FORMAT_FAQ, "title": "X", "wp_link": "https://example.com/x/"}
    project = {"schema_markup_enabled": True, "name": "Acme"}
    meta = build_schema_meta(article, project, "rank_math")
    assert meta["rank_math_rich_snippet"] == "article"
    assert "_riviso_schema_article" not in meta
    faq = json.loads(meta["_riviso_schema_faq"])
    assert faq["@type"] == "FAQPage"


def test_build_schema_meta_yoast_platform() -> None:
    article = {"article": NEW_FORMAT_FAQ, "title": "X", "wp_link": "https://example.com/x/"}
    project = {"schema_markup_enabled": True, "name": "Acme"}
    meta = build_schema_meta(article, project, "yoast")
    assert meta["_yoast_wpseo_schema_page_type"] == "Article"
    assert meta["_yoast_wpseo_schema_article_type"] == "BlogPosting"
    assert "_riviso_schema_article" not in meta


def test_build_schema_meta_no_seo_plugin_falls_back_to_article_jsonld() -> None:
    article = {
        "article": NO_FAQ_MARKDOWN,
        "title": "X",
        "wp_link": "https://example.com/x/",
    }
    project = {"schema_markup_enabled": True, "name": "Acme"}
    meta = build_schema_meta(article, project, None)
    assert "_riviso_schema_faq" not in meta
    article_jsonld = json.loads(meta["_riviso_schema_article"])
    assert article_jsonld["@type"] == "BlogPosting"


def test_build_schema_meta_defaults_enabled_when_key_absent() -> None:
    article = {"article": NO_FAQ_MARKDOWN, "title": "X", "wp_link": "https://example.com/x/"}
    project = {"name": "Acme"}
    meta = build_schema_meta(article, project, None)
    assert "_riviso_schema_article" in meta
