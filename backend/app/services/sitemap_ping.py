from __future__ import annotations

from urllib.parse import quote

import httpx


async def ping_sitemap(*, sitemap_url: str) -> None:
    """
    Best-effort discovery signal for new content.
    Google/Bing "ping" is not a guarantee of indexing; it helps crawlers discover sitemap updates.
    """
    su = (sitemap_url or "").strip()
    if not su:
        return
    enc = quote(su, safe="")
    urls = [
        f"https://www.google.com/ping?sitemap={enc}",
        f"https://www.bing.com/ping?sitemap={enc}",
    ]
    async with httpx.AsyncClient(timeout=15.0) as client:
        for u in urls:
            try:
                await client.get(u)
            except Exception:
                # ignore network failures
                pass


def default_sitemap_url(*, wp_site_url: str) -> str:
    base = (wp_site_url or "").strip().rstrip("/")
    if not base:
        return ""
    # Works for modern WordPress core sitemap. Some SEO plugins use /sitemap_index.xml;
    # user can override by setting a custom sitemap URL later if needed.
    return f"{base}/sitemap.xml"

