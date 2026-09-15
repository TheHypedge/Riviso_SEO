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

import logging
from xml.etree import ElementTree

import httpx

from app.services.seo_crawler.fetcher import fetch_url

log = logging.getLogger(__name__)

_SITEMAP_NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
_MAX_SITEMAP_DEPTH = 3  # sitemap index -> child sitemap -> (no further nesting expected)
_MAX_SITEMAPS_FETCHED = 50  # safety ceiling on number of sitemap *files*, not URLs
_MAX_URLS_COLLECTED = 20000  # safety ceiling on total <loc> URLs collected


async def collect_sitemap_urls(client: httpx.AsyncClient, sitemap_urls: list[str]) -> list[str]:
    """Fetch each sitemap (following sitemap-index nesting), return every discovered
    page URL. Never raises -- a malformed or unreachable sitemap file is skipped,
    same "don't abort the crawl over one bad input" discipline as HTML parsing."""
    collected: list[str] = []
    seen_files: set[str] = set()
    queue: list[tuple[str, int]] = [(u, 0) for u in sitemap_urls if u]

    while queue and len(seen_files) < _MAX_SITEMAPS_FETCHED and len(collected) < _MAX_URLS_COLLECTED:
        url, depth = queue.pop(0)
        if url in seen_files or depth > _MAX_SITEMAP_DEPTH:
            continue
        seen_files.add(url)

        result = await fetch_url(client, url)
        if result.error or not result.body or not result.status_code or result.status_code >= 400:
            continue

        try:
            root = ElementTree.fromstring(result.body.encode("utf-8", errors="ignore"))
        except ElementTree.ParseError:
            log.debug("sitemap: failed to parse XML for %s", url)
            continue

        tag = root.tag.rsplit("}", 1)[-1] if "}" in root.tag else root.tag
        if tag == "sitemapindex":
            for sm in root.findall("sm:sitemap/sm:loc", _SITEMAP_NS) or root.findall(".//{*}sitemap/{*}loc"):
                loc = (sm.text or "").strip()
                if loc:
                    queue.append((loc, depth + 1))
        elif tag == "urlset":
            for loc_el in root.findall("sm:url/sm:loc", _SITEMAP_NS) or root.findall(".//{*}url/{*}loc"):
                loc = (loc_el.text or "").strip()
                if loc and len(collected) < _MAX_URLS_COLLECTED:
                    collected.append(loc)

    return collected
