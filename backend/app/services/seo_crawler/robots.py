"""robots.txt fetch + parse (Site-Audit-Design.md §10).

The robots.txt body is fetched through the same SSRF-guarded client as every other
crawl request (never `urllib.request`, which `RobotFileParser.read()` would use
internally and which bypasses the SSRF guard entirely) -- then handed to the stdlib
parser via `.parse(lines)` instead of `.read()`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from urllib.parse import urljoin
from urllib.robotparser import RobotFileParser

import httpx

from app.services.seo_crawler.fetcher import fetch_url

MAX_ROBOTS_BYTES = 512 * 1024  # robots.txt is conventionally tiny; cap defensively


@dataclass
class RobotsPolicy:
    host: str
    fetched: bool
    status_code: int | None
    raw_content: str
    sitemap_urls: list[str] = field(default_factory=list)


async def fetch_robots_policy(client: httpx.AsyncClient, site_url: str) -> tuple[RobotsPolicy, RobotFileParser]:
    """Fetch + parse robots.txt for `site_url`'s host. Missing/unreachable robots.txt is
    treated as "allow everything" (default-permissive), matching real crawler behavior."""
    robots_url = urljoin(site_url, "/robots.txt")
    result = await fetch_url(client, robots_url)

    rp = RobotFileParser()
    rp.set_url(robots_url)
    raw = (result.body or "")[:MAX_ROBOTS_BYTES]
    if result.status_code and 200 <= result.status_code < 300 and raw:
        rp.parse(raw.splitlines())
    else:
        # No robots.txt (404) or fetch failure -- allow-all is the standard interpretation.
        rp.parse([])

    sitemaps = []
    try:
        sitemaps = list(rp.site_maps() or [])
    except Exception:
        sitemaps = []

    from app.services.seo_crawler.url_utils import registrable_host

    policy = RobotsPolicy(
        host=registrable_host(site_url) or "",
        fetched=bool(result.status_code),
        status_code=result.status_code,
        raw_content=raw,
        sitemap_urls=sitemaps,
    )
    return policy, rp


def can_fetch(rp: RobotFileParser, user_agent: str, url: str) -> bool:
    try:
        return rp.can_fetch(user_agent, url)
    except Exception:
        return True
