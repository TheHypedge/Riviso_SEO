"""
SSRF-guarded fetch + lightweight main-content extraction for one arbitrary,
user-supplied URL — powers the Add Article modal's "Through Source" tab.

Not part of seo_crawler/ (a different concern: drafting one article from one
page, not auditing a whole site), but follows the exact same SSRF-guard and
tag-stripping conventions as seo_crawler/fetcher.py and seo_crawler/parser.py.
No new dependency — beautifulsoup4/httpx are already Riviso dependencies, and
no readability/trafilatura-style extractor exists anywhere in this codebase.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import httpx
from bs4 import BeautifulSoup

from app.services.seo_crawler.fetcher import MAX_BODY_BYTES
from app.services.url_guard import assert_public_http_url, ssrf_guarded_event_hooks

# Word cap applied once, here, before this text is ever used in a prompt —
# article_generation.py does not need its own separate truncation.
MAX_EXTRACTED_WORDS = 4000
MIN_EXTRACTED_WORDS = 80

_EXCLUDED_TAGS = ("script", "style", "noscript", "header", "nav", "footer", "template")


@dataclass
class ExtractedPage:
    title: str | None
    meta_description: str | None
    text: str
    word_count: int
    final_url: str


def _clean_text(s: str | None) -> str | None:
    if s is None:
        return None
    t = re.sub(r"\s+", " ", s).strip()
    return t or None


def _extract(html: str, page_url: str) -> ExtractedPage:
    soup = BeautifulSoup(html or "", "html.parser")
    for tag in soup.find_all(_EXCLUDED_TAGS):
        tag.decompose()

    title = None
    title_tag = soup.find("title")
    if title_tag:
        title = _clean_text(title_tag.get_text())

    meta_description = None
    for m in soup.find_all("meta"):
        if (m.get("name") or "").strip().lower() == "description":
            meta_description = _clean_text(m.get("content"))
            break

    main = soup.find("article") or soup.find("main")
    text_source = main if (main and len(main.get_text(strip=True)) > 200) else (soup.body or soup)
    text = re.sub(r"\s+", " ", text_source.get_text(separator=" ")).strip()
    words = text.split(" ") if text else []
    word_count = len(words)
    if word_count < MIN_EXTRACTED_WORDS:
        raise ValueError("content_too_short")
    truncated = " ".join(words[:MAX_EXTRACTED_WORDS])

    return ExtractedPage(
        title=title,
        meta_description=meta_description,
        text=truncated,
        word_count=word_count,
        final_url=page_url,
    )


async def fetch_and_extract_url(url: str) -> ExtractedPage:
    """SSRF-guarded fetch + main-content extraction.

    Raises ``SsrfError`` (from ``url_guard``), ``httpx.HTTPStatusError``/``httpx.HTTPError``,
    or ``ValueError`` with one of ``"not_html"``, ``"body_too_large"``, ``"content_too_short"``
    — callers map each to a clear, user-facing 4xx.
    """
    assert_public_http_url(url)
    async with httpx.AsyncClient(
        headers={"User-Agent": "RivisoBot/1.0 (+article-source-fetch)"},
        timeout=httpx.Timeout(20.0, connect=10.0),
        follow_redirects=True,
        max_redirects=8,
        event_hooks=ssrf_guarded_event_hooks(),
    ) as client:
        resp = await client.get(url)
    resp.raise_for_status()

    content_type = resp.headers.get("content-type", "")
    if "html" not in content_type.lower():
        raise ValueError("not_html")
    if len(resp.content) > MAX_BODY_BYTES:
        raise ValueError("body_too_large")

    return _extract(resp.text, str(resp.url))
