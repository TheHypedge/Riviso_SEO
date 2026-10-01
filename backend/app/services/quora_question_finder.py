"""
Quora question discovery for the Social Media module.

Quora has no public API for posting (or searching) at all -- confirmed during planning.
Instead of scraping Quora directly, this reuses the app's existing shared Google-SERP
scraper (``app.services.serp_index.get_or_fetch_serp``, already used for keyword
research) with a ``site:quora.com`` query. This returns real, currently-indexed Quora
question titles + exact URLs with zero new scraping code and zero new ToS exposure
beyond what that function already does today for every other keyword-research query --
plus it benefits from the same shared cross-project cache.
"""

from __future__ import annotations

import re

_QUORA_SUFFIX_RE = re.compile(r"\s*-\s*Quora\s*$", re.IGNORECASE)


def _clean_question_title(raw_title: str) -> str:
    """Google indexes Quora question pages as "{Question} - Quora" -- strip the
    site-name suffix for a clean, standalone question to show the user."""
    return _QUORA_SUFFIX_RE.sub("", (raw_title or "").strip()).strip()


def _is_quora_question_url(url: str) -> bool:
    u = (url or "").strip().lower()
    return "quora.com" in u and "/search" not in u


async def discover_quora_questions(*, keywords: list[str], gl: str = "US", hl: str = "en", limit: int = 20) -> list[dict[str, str]]:
    """Runs one ``site:quora.com {keyword}`` SERP query per keyword (reusing the shared,
    rate-limited, cached SERP index), aggregates results across keywords, dedupes by
    URL, and returns real question/url pairs sorted by which keyword found them.

    Never raises on a single keyword's fetch failure -- a Quora discovery run should
    degrade to "fewer results" rather than fail outright because one query hiccuped.
    """
    from app.services.serp_index import get_or_fetch_serp

    seen_urls: set[str] = set()
    out: list[dict[str, str]] = []

    for kw in keywords:
        kw_clean = (kw or "").strip()
        if not kw_clean:
            continue
        try:
            extract = await get_or_fetch_serp(query=f"site:quora.com {kw_clean}", gl=gl, hl=hl)
        except Exception:
            continue
        for r in extract.results:
            if not isinstance(r, dict):
                continue
            url = (r.get("url") or "").strip()
            title = (r.get("title") or "").strip()
            if not url or not title or not _is_quora_question_url(url):
                continue
            if url in seen_urls:
                continue
            seen_urls.add(url)
            out.append({"question": _clean_question_title(title), "url": url, "matched_keyword": kw_clean})
            if len(out) >= limit:
                return out
    return out
