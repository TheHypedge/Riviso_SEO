"""Builds JSON-LD schema markup (Article/BlogPosting + FAQPage) for the WordPress
``meta`` payload sent on publish/update -- see ``build_wp_seo_meta_payload`` in
``wordpress_sync.py`` for the sibling Yoast/Rank Math/AIOSEO title+description payload
this rides alongside.

Design note: Yoast and Rank Math only generate FAQPage schema from their own Gutenberg
FAQ *block* markup inside ``post_content`` -- since Riviso publishes plain HTML, not
Gutenberg blocks, neither plugin's FAQ generator ever fires on our content regardless
of settings. So FAQPage schema here is always our own JSON-LD, handed to the
WordPress-side connector plugin via post meta and printed in ``<head>`` (never inside
``post_content``, which would depend on the publishing user having ``unfiltered_html``).

For Article/BlogPosting schema we defer to whichever SEO plugin is active (it already
knows the site's own publisher/author/logo settings) by setting a couple of per-post
meta keys that steer its own native schema generator -- we only emit our own fallback
Article JSON-LD when no SEO plugin is detected.
"""

from __future__ import annotations

import json
import re
from typing import Any

_FAQ_HEADING_RE = re.compile(r"^#{2,3}\s*frequently asked questions\s*$", re.IGNORECASE)
# New format (article_generation.py FAQ SECTION instructions): each question is its
# own H3 heading ending in "?", answer is the very next paragraph.
_H3_QUESTION_RE = re.compile(r"^###\s+(.+\?)\s*$")
# Legacy/fallback format for articles generated before that instruction existed:
# a bold line ending in "?" (e.g. "**How does X work?**").
_BOLD_QUESTION_RE = re.compile(r"^\*\*(.+\?)\*\*\s*$")


def extract_faq_pairs(markdown: str) -> list[dict[str, str]]:
    """Parses question/answer pairs out of the article's "## Frequently Asked
    Questions" section. Returns ``[]`` (never raises) when no FAQ section is found or
    nothing confidently parses -- callers must treat that as "no FAQ schema", not an
    error.
    """
    text = (markdown or "").strip()
    if not text:
        return []

    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if _FAQ_HEADING_RE.match(line.strip()):
            start = i + 1
            break
    if start is None:
        return []

    # The FAQ section runs until the next H1/H2 heading (its own H3 sub-headings are
    # the questions, so only H1/H2 end the section) or end of document.
    end = len(lines)
    for i in range(start, len(lines)):
        stripped = lines[i].strip()
        if re.match(r"^#{1,2}\s+\S", stripped):
            end = i
            break
    section = lines[start:end]

    pairs: list[dict[str, str]] = []
    current_q: str | None = None
    current_answer: list[str] = []

    def flush() -> None:
        if current_q and current_answer:
            answer = " ".join(p.strip() for p in current_answer if p.strip())
            if answer:
                pairs.append({"question": current_q.strip(), "answer": answer})

    for raw in section:
        line = raw.strip()
        if not line:
            continue
        h3_match = _H3_QUESTION_RE.match(line)
        bold_match = _BOLD_QUESTION_RE.match(line)
        if h3_match or bold_match:
            flush()
            current_q = (h3_match or bold_match).group(1).strip()
            current_answer = []
        elif current_q:
            current_answer.append(line)
    flush()

    return pairs


def build_faq_jsonld(pairs: list[dict[str, str]]) -> dict[str, Any] | None:
    if not pairs:
        return None
    return {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": p["question"],
                "acceptedAnswer": {"@type": "Answer", "text": p["answer"]},
            }
            for p in pairs
        ],
    }


def build_article_jsonld(article: dict[str, Any], project: dict[str, Any]) -> dict[str, Any] | None:
    title = (article.get("title") or "").strip()
    url = (article.get("wp_link") or "").strip()
    if not title or not url:
        return None
    description = (article.get("meta_description") or "").strip()
    published = (article.get("posted_at") or article.get("created_at") or "").strip()
    modified = (article.get("wp_modified_at") or article.get("updated_at") or published).strip()
    image = (article.get("wp_featured_image_url") or article.get("image_url") or "").strip()
    publisher_name = (project.get("name") or "").strip() or "Editorial Team"

    data: dict[str, Any] = {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": title,
        "mainEntityOfPage": {"@type": "WebPage", "@id": url},
        "url": url,
        "publisher": {"@type": "Organization", "name": publisher_name},
        "author": {"@type": "Organization", "name": publisher_name},
    }
    if description:
        data["description"] = description
    if published:
        data["datePublished"] = published
    if modified:
        data["dateModified"] = modified
    if image:
        data["image"] = image
    return data


def build_schema_meta(article: dict[str, Any], project: dict[str, Any], seo_platform: str | None) -> dict[str, str]:
    """Single entry point called at publish/update time. Returns WordPress post-meta
    keys (JSON-stringified where the value is a schema object) to merge into the
    existing ``build_wp_seo_meta_payload`` result -- ``{}`` when the project has
    schema markup turned off, or when nothing could be built.
    """
    if not project.get("schema_markup_enabled", True):
        return {}

    meta: dict[str, str] = {}

    faq_jsonld = build_faq_jsonld(extract_faq_pairs(article.get("article") or ""))
    if faq_jsonld:
        meta["_riviso_schema_faq"] = json.dumps(faq_jsonld, separators=(",", ":"))

    platform = (seo_platform or "").strip().lower()
    if platform == "rank_math":
        meta["rank_math_rich_snippet"] = "article"
    elif platform == "yoast":
        meta["_yoast_wpseo_schema_page_type"] = "Article"
        meta["_yoast_wpseo_schema_article_type"] = "BlogPosting"
    else:
        article_jsonld = build_article_jsonld(article, project)
        if article_jsonld:
            meta["_riviso_schema_article"] = json.dumps(article_jsonld, separators=(",", ":"))

    return meta
