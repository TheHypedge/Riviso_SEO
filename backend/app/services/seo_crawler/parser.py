"""HTML parsing for one crawled page (Site-Audit-Design.md §14, §25-§29, §36, §41).

Uses BeautifulSoup (already a Riviso dependency — see research_scraper.py /
wordpress_sync.py). Malformed HTML must never abort the crawl (§14), so every
extraction here degrades to an empty/None value rather than raising.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urljoin

from bs4 import BeautifulSoup

# Word count excludes chrome that isn't the page's own content, per §30's default.
_EXCLUDED_TAGS = ("script", "style", "noscript", "header", "nav", "footer", "template")


@dataclass
class ParsedLink:
    href: str
    anchor_text: str
    rel: list[str]
    nofollow: bool


@dataclass
class ParsedPage:
    title: str | None = None
    title_count: int = 0
    meta_description: str | None = None
    meta_description_count: int = 0
    h1: str | None = None
    h1_count: int = 0
    h2: str | None = None
    h2_count: int = 0
    canonical: str | None = None
    meta_robots: str | None = None
    word_count: int = 0
    links: list[ParsedLink] = field(default_factory=list)


def _clean_text(s: str | None) -> str | None:
    if s is None:
        return None
    t = re.sub(r"\s+", " ", s).strip()
    return t or None


def parse_html(html: str, page_url: str) -> ParsedPage:
    try:
        soup = BeautifulSoup(html or "", "html.parser")
    except Exception:
        return ParsedPage()

    out = ParsedPage()

    try:
        titles = soup.find_all("title")
        out.title_count = len(titles)
        if titles:
            out.title = _clean_text(titles[0].get_text())
    except Exception:
        pass

    try:
        metas_desc = [m for m in soup.find_all("meta") if (m.get("name") or "").strip().lower() == "description"]
        out.meta_description_count = len(metas_desc)
        if metas_desc:
            out.meta_description = _clean_text(metas_desc[0].get("content"))
    except Exception:
        pass

    try:
        h1s = soup.find_all("h1")
        out.h1_count = len(h1s)
        if h1s:
            out.h1 = _clean_text(h1s[0].get_text())
    except Exception:
        pass

    try:
        h2s = soup.find_all("h2")
        out.h2_count = len(h2s)
        if h2s:
            out.h2 = _clean_text(h2s[0].get_text())
    except Exception:
        pass

    try:
        canon = soup.find("link", rel=lambda v: v and "canonical" in [x.lower() for x in (v if isinstance(v, list) else [v])])
        if canon and canon.get("href"):
            out.canonical = urljoin(page_url, canon.get("href").strip())
    except Exception:
        pass

    try:
        robots_meta = [m for m in soup.find_all("meta") if (m.get("name") or "").strip().lower() in ("robots", "googlebot")]
        if robots_meta:
            out.meta_robots = _clean_text(",".join(filter(None, (m.get("content") for m in robots_meta))))
    except Exception:
        pass

    try:
        body = soup.body or soup
        for tag in body.find_all(_EXCLUDED_TAGS):
            tag.decompose()
        text = body.get_text(separator=" ")
        out.word_count = len([w for w in re.split(r"\s+", text.strip()) if w])
    except Exception:
        pass

    try:
        for a in soup.find_all("a"):
            href = (a.get("href") or "").strip()
            if not href or href.startswith(("javascript:", "mailto:", "tel:", "#")):
                continue
            resolved = urljoin(page_url, href)
            rel_attr = a.get("rel") or []
            rel_list = rel_attr if isinstance(rel_attr, list) else [rel_attr]
            rel_list = [r.lower() for r in rel_list if r]
            out.links.append(
                ParsedLink(
                    href=resolved,
                    anchor_text=_clean_text(a.get_text()) or "",
                    rel=rel_list,
                    nofollow="nofollow" in rel_list,
                )
            )
    except Exception:
        pass

    return out
