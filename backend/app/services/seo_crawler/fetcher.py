"""SSRF-guarded HTTP fetcher for the SEO crawler.

Implements Site-Audit-Design.md §11 (HTTP Fetcher) and §13 (Redirects) for Phase
1+2's scope: fetch one URL, capture status/timing/redirect chain/body, never touch
a private/internal address. Every fetch goes through the same `url_guard.py` used
by Technical Audit's PageSpeed calls (backend/app/services/pagespeed_client.py).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import httpx

from app.services.url_guard import SsrfError, assert_public_http_url, ssrf_guarded_event_hooks

# Cap how much of a response body we read into memory — Phase 1 only needs the
# HTML for on-page parsing, never a full binary/media download.
MAX_BODY_BYTES = 3 * 1024 * 1024


@dataclass
class RedirectHop:
    url: str
    status_code: int


@dataclass
class FetchResult:
    url: str
    final_url: str
    status_code: int | None = None
    status_text: str | None = None
    content_type: str | None = None
    body: str | None = None
    size_bytes: int | None = None
    response_time_ms: int | None = None
    redirect_chain: list[RedirectHop] = field(default_factory=list)
    headers: dict[str, str] = field(default_factory=dict)
    error: str | None = None


def build_http_client(*, user_agent: str, timeout_seconds: float) -> httpx.AsyncClient:
    """One shared client per crawl run — connection pooling per spec §11.

    http2=True matters more than it looks: httpx defaults to HTTP/1.1-only, but an
    HTTPS client that never offers HTTP/2 in its TLS ALPN is itself a bot signal --
    essentially no real browser (or Googlebot, or Screaming Frog) does that anymore.
    Confirmed directly against a real site protected by Cloudflare: identical
    User-Agent, identical request, HTTP/1.1 -> 403 bot-challenge page, HTTP/2 -> 200
    with real content. Never spoof the User-Agent to impersonate a browser or
    Googlebot -- RivisoBot identifies itself honestly; this only fixes a transport
    detail that was making an honest request look automated.
    """
    return httpx.AsyncClient(
        http2=True,
        headers={
            "User-Agent": user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
        timeout=httpx.Timeout(timeout_seconds, connect=10.0),
        follow_redirects=True,
        max_redirects=8,
        event_hooks=ssrf_guarded_event_hooks(),
    )


async def fetch_url(client: httpx.AsyncClient, url: str) -> FetchResult:
    """Fetch one URL. Never raises for ordinary HTTP failures -- errors land in `.error`
    so a single bad page never aborts the crawl (§Rule: malformed responses must not
    terminate the crawl, mirrored from §14's HTML-parsing rule)."""
    try:
        assert_public_http_url(url)
    except SsrfError as exc:
        return FetchResult(url=url, final_url=url, error=f"blocked: {exc}")

    started = time.monotonic()
    try:
        resp = await client.get(url)
    except SsrfError as exc:
        return FetchResult(url=url, final_url=url, error=f"blocked_redirect: {exc}")
    except httpx.TimeoutException:
        return FetchResult(url=url, final_url=url, error="timeout")
    except httpx.HTTPError as exc:
        return FetchResult(url=url, final_url=url, error=f"request_failed: {exc.__class__.__name__}")
    elapsed_ms = int((time.monotonic() - started) * 1000)

    chain = [RedirectHop(url=str(r.url), status_code=r.status_code) for r in resp.history]
    content_type = resp.headers.get("content-type")

    body: str | None = None
    size_bytes: int | None = None
    try:
        raw = resp.content
        size_bytes = len(raw)
        if raw and size_bytes <= MAX_BODY_BYTES:
            body = resp.text
    except Exception:
        body = None

    return FetchResult(
        url=url,
        final_url=str(resp.url),
        status_code=resp.status_code,
        status_text=resp.reason_phrase,
        content_type=content_type,
        body=body,
        size_bytes=size_bytes,
        response_time_ms=elapsed_ms,
        redirect_chain=chain,
        headers={k.lower(): v for k, v in resp.headers.items()},
    )
