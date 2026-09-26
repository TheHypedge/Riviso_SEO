"""XML sitemap discovery (Site-Audit-Design.md §5.2, §48 — discovery use only here;
the full reconciliation audit in §48 is a later phase).

Pure link-following BFS from the homepage routinely misses most of a real site: a
WordPress blog's homepage might link 3-5 "featured" articles while its sitemap
lists hundreds. Confirmed against a real site (sheokandlegal.com): 66 pages
reachable by links alone vs 533 in the articles sitemap alone. Every URL a sitemap
lists is fed into the same crawl frontier as a regular discovered link — sitemap
inclusion doesn't skip the fetch, it just makes sure the page is *found*.
"""

from __future__ import annotations

import asyncio
import logging
from xml.etree import ElementTree

import httpx

from app.services.seo_crawler.fetcher import fetch_url

log = logging.getLogger(__name__)

_SITEMAP_NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
_MAX_SITEMAP_DEPTH = 3  # sitemap index -> child sitemap -> (no further nesting expected)
_MAX_SITEMAPS_FETCHED = 50  # safety ceiling on number of sitemap *files*, not URLs
_MAX_URLS_COLLECTED = 20000  # safety ceiling on total <loc> URLs collected
_FETCH_CONCURRENCY = 8  # a sitemap index's child sitemaps are independent -- fetch
# the whole level at once instead of one-at-a-time, same reasoning as the main
# crawl's worker pool. Depth is capped at 3 and file count at 50, so (unlike the
# main crawl's ever-growing BFS frontier) simple per-level batching is enough --
# no continuous queue needed here.


async def collect_sitemap_urls(client: httpx.AsyncClient, sitemap_urls: list[str]) -> list[str]:
    """Fetch each sitemap (following sitemap-index nesting), return every discovered
    page URL. Never raises -- a malformed or unreachable sitemap file is skipped,
    same "don't abort the crawl over one bad input" discipline as HTML parsing.

    Fetches each nesting level concurrently: a real sitemap index can point at
    dozens of child sitemaps, and fetching them one at a time serially was the
    actual cause of the crawl looking "stuck" before a single page had even
    started -- the audit doc has nothing real to report progress on until this
    function returns."""
    collected: list[str] = []
    seen_files: set[str] = set()
    semaphore = asyncio.Semaphore(_FETCH_CONCURRENCY)
    level: list[tuple[str, int]] = [(u, 0) for u in sitemap_urls if u]

    async def _fetch_one(url: str, depth: int) -> list[tuple[str, int]]:
        async with semaphore:
            result = await fetch_url(client, url)
        if result.error or not result.body or not result.status_code or result.status_code >= 400:
            return []

        try:
            root = ElementTree.fromstring(result.body.encode("utf-8", errors="ignore"))
        except ElementTree.ParseError:
            log.debug("sitemap: failed to parse XML for %s", url)
            return []

        tag = root.tag.rsplit("}", 1)[-1] if "}" in root.tag else root.tag
        if tag == "sitemapindex":
            next_level = []
            for sm in root.findall("sm:sitemap/sm:loc", _SITEMAP_NS) or root.findall(".//{*}sitemap/{*}loc"):
                loc = (sm.text or "").strip()
                if loc:
                    next_level.append((loc, depth + 1))
            return next_level
        if tag == "urlset":
            for loc_el in root.findall("sm:url/sm:loc", _SITEMAP_NS) or root.findall(".//{*}url/{*}loc"):
                loc = (loc_el.text or "").strip()
                if loc and len(collected) < _MAX_URLS_COLLECTED:
                    collected.append(loc)
        return []

    while level and len(seen_files) < _MAX_SITEMAPS_FETCHED and len(collected) < _MAX_URLS_COLLECTED:
        batch = []
        for url, depth in level:
            if url in seen_files or depth > _MAX_SITEMAP_DEPTH:
                continue
            if len(seen_files) >= _MAX_SITEMAPS_FETCHED:
                break
            seen_files.add(url)
            batch.append((url, depth))
        if not batch:
            break

        results = await asyncio.gather(*(_fetch_one(url, depth) for url, depth in batch))
        level = [item for next_level in results for item in next_level]

    return collected
