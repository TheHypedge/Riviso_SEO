"""Self-check for the continuous worker-pool rewrite of `_drain_frontier`
(replaced the old wave-synchronized `asyncio.gather` batching, which stalled
every worker on whichever page in a round was slowest). Verifies: all
same-host pages linked transitively get crawled without a real network call,
newly discovered links feed back into the pool via `_enqueue`, and the
status-code breakdown is tallied correctly."""

import asyncio
from collections import deque
from unittest.mock import AsyncMock, patch

from app.services.seo_crawler.crawler import CrawlCounts, _FrontierItem, _drain_frontier
from app.services.seo_crawler.fetcher import FetchResult

PAGES = {
    "https://example.com/": (200, '<html><body><a href="/a">a</a><a href="/b">b</a></body></html>'),
    "https://example.com/a": (200, '<html><body><a href="/c">c</a></body></html>'),
    "https://example.com/b": (404, "<html><body>missing</body></html>"),
    "https://example.com/c": (200, "<html><body>leaf</body></html>"),
}


async def _fake_fetch_url(client, url):
    status, body = PAGES[url]
    return FetchResult(url=url, final_url=url, status_code=status, status_text="OK", content_type="text/html", body=body)


class _FakeStorage:
    def __init__(self):
        self.urls: list[dict] = []
        self.links: list[dict] = []

    def insert_seo_audit_urls_bulk(self, rows):
        self.urls.extend(rows)

    def insert_seo_audit_links_bulk(self, rows):
        self.links.extend(rows)

    def update_seo_audit_fields(self, audit_id, fields):
        return True


def test_worker_pool_crawls_all_linked_pages_and_tallies_status_codes():
    st = _FakeStorage()
    frontier = deque([_FrontierItem(url="https://example.com/", normalized_url="https://example.com/", discovered_from=None, discovery_type="seed", depth=0)])
    counts = CrawlCounts()
    counts.discovered = 1
    counts.queued = 1

    with patch("app.services.seo_crawler.crawler.fetch_url", _fake_fetch_url):
        result = asyncio.run(
            _drain_frontier(
                st,
                client=None,
                rp=None,
                respect_robots=False,
                user_agent="test-agent",
                audit_id="audit1",
                seed_host="example.com",
                max_urls=100,
                concurrency_per_host=3,
                max_duration_seconds=30.0,
                should_cancel=None,
                flush_every=1000,
                progress_every_seconds=999.0,
                frontier=frontier,
                visited={"https://example.com/"},
                counts=counts,
                url_id_by_normalized={},
            )
        )

    assert len(st.urls) == 4  # /, /a, /b, /c all crawled exactly once
    assert result["status_breakdown"]["2xx"] == 3
    assert result["status_breakdown"]["4xx"] == 1


if __name__ == "__main__":
    test_worker_pool_crawls_all_linked_pages_and_tallies_status_codes()
    print("ok")
