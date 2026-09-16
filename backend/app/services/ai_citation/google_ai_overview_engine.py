"""
Google AI Overview engine adapter -- self-built, best-effort scraper (no paid
SERP API vendor; see the AI Citation Tracking plan's "Google AI Overview"
section for the full tradeoff writeup).

Google renders the AI Overview block client-side via JS in most locales/
sessions, so a plain httpx fetch (research_scraper.py, used by the rest of
this repo's scraping) structurally cannot read it. This uses a headless
Chromium (Playwright) to actually render the page.

IMPORTANT, verified in testing (not a guess): Google's bot detection blocks
plain headless-Chromium requests outright in many network environments --
you get an "Our systems have detected unusual traffic" interstitial instead
of real results, consistently, regardless of query. This function detects
that page explicitly and reports error="blocked_by_google" rather than ever
treating a block as "not cited" (a false negative would be worse than no
data at all). Whether this happens in *your* deployment depends on the
server's IP reputation -- datacenter/VPS IPs are generally more likely to be
flagged than residential ones, so this needs to be verified against the
actual production network before the feature flag is trusted, not assumed
from local testing alone.

Kept off by default (AI_CITATION_GOOGLE_AI_OVERVIEW_ENABLED=0) until that's
verified. If blocking turns out to be the norm rather than an artifact of one
network, the realistic paths forward are a paid SERP API vendor with real
AI-Overview extraction (e.g. SerpApi, DataForSEO) or residential-proxy
infrastructure -- both are business/infra decisions, not something to bolt on
silently here.
"""

from __future__ import annotations

import logging
from urllib.parse import quote_plus

from app.services.ai_citation.engine_types import EngineResult

log = logging.getLogger(__name__)

ENGINE = "google_ai_overview"

_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
_BLOCK_MARKERS = ("unusual traffic", "detected unusual traffic", "/sorry/index")
_HEADING_MARKERS = ("ai overview", "ai-powered overview")

_playwright = None
_browser = None


async def _get_browser():
    """Lazily launch one shared headless Chromium instance, reused across calls --
    launching a fresh browser process per check would be far too expensive for a
    worker processing many cells."""
    global _playwright, _browser
    if _browser is not None:
        return _browser
    from playwright.async_api import async_playwright

    _playwright = await async_playwright().start()
    _browser = await _playwright.chromium.launch(headless=True)
    return _browser


def _looks_blocked(text: str, url: str) -> bool:
    low = (text or "").lower()
    return any(marker in low for marker in _BLOCK_MARKERS) or "/sorry/" in (url or "")


async def _extract_ai_overview(page) -> tuple[str, list[str]] | None:
    """Runs in the rendered DOM (post-JS) -- looks for a heading whose text matches
    Google's AI Overview label, then reads the surrounding block's text + links.
    Google's generated class names are unstable and not worth hardcoding."""
    heading = page.get_by_text(_HEADING_MARKERS[0], exact=False).first
    try:
        if await heading.count() == 0:
            return None
    except Exception:
        return None

    container = heading
    body_text = ""
    for _ in range(6):
        try:
            parent = container.locator("xpath=..")
            if await parent.count() == 0:
                break
            container = parent
            body_text = " ".join((await container.inner_text()).split())
            if len(body_text) > 200:
                break
        except Exception:
            break

    if not body_text or len(body_text) < 40:
        return None

    links: list[str] = []
    try:
        hrefs = await container.locator("a[href^='http']").evaluate_all("els => els.map(e => e.href)")
        links = [h[:2048] for h in hrefs][:20]
    except Exception:
        pass

    return body_text[:8000], links


async def check(prompt: str) -> EngineResult:
    try:
        browser = await _get_browser()
    except Exception as e:
        return EngineResult(error=f"Could not launch headless browser: {e}")

    page = None
    try:
        page = await browser.new_page(user_agent=_USER_AGENT)
        url = f"https://www.google.com/search?q={quote_plus(prompt)}&gl=US&hl=en&num=10&pws=0"
        await page.goto(url, timeout=20000)
        await page.wait_for_timeout(2000)

        body_text = await page.inner_text("body")
        if _looks_blocked(body_text, page.url):
            log.warning("ai_citation: Google AI Overview scrape blocked (bot detection) for prompt=%r", prompt)
            return EngineResult(error="blocked_by_google")

        extracted = await _extract_ai_overview(page)
        if extracted is None:
            return EngineResult(error="ai_overview_not_present")
        text, links = extracted
        return EngineResult(response_text=text, citation_urls=links)
    except Exception as e:
        return EngineResult(error=str(e))
    finally:
        if page is not None:
            await page.close()
