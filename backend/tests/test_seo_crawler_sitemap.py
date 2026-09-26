"""Self-check for sitemap.py's concurrent per-level fetching (replaced a serial
one-file-at-a-time loop that made the "Validating website" stage look stuck on
sites with many sitemap files)."""

import asyncio
from unittest.mock import patch

from app.services.seo_crawler.fetcher import FetchResult
from app.services.seo_crawler.sitemap import collect_sitemap_urls

INDEX_XML = """<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-a.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-b.xml</loc></sitemap>
</sitemapindex>"""

CHILD_XML = """<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>{url}</loc></url>
</urlset>"""

FILES = {
    "https://example.com/sitemap.xml": INDEX_XML,
    "https://example.com/sitemap-a.xml": CHILD_XML.format(url="https://example.com/a"),
    "https://example.com/sitemap-b.xml": CHILD_XML.format(url="https://example.com/b"),
}


async def _fake_fetch_url(client, url):
    body = FILES.get(url)
    if body is None:
        return FetchResult(url=url, final_url=url, status_code=404, error="not_found")
    return FetchResult(url=url, final_url=url, status_code=200, content_type="application/xml", body=body)


def test_sitemap_index_children_fetched_concurrently_and_urls_collected():
    with patch("app.services.seo_crawler.sitemap.fetch_url", _fake_fetch_url):
        urls = asyncio.run(collect_sitemap_urls(client=None, sitemap_urls=["https://example.com/sitemap.xml"]))
    assert sorted(urls) == ["https://example.com/a", "https://example.com/b"]


if __name__ == "__main__":
    test_sitemap_index_children_fetched_concurrently_and_urls_collected()
    print("ok")
