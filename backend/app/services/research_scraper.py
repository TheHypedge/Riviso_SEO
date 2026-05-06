from __future__ import annotations

import hashlib
import os
import random
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote_plus

import httpx
from bs4 import BeautifulSoup


_UA_POOL = [
    # Keep lightweight and realistic; avoid overly-identifying strings.
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
]


@dataclass(frozen=True)
class SerpExtract:
    query: str
    gl: str
    hl: str
    fetched_at: float
    html_sha256: str
    results: list[dict[str, Any]]
    related_searches: list[str]


def _sha256_text(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8", errors="ignore")).hexdigest()


def _normalize_kw(s: str) -> str:
    return " ".join((s or "").strip().split())[:200]


async def fetch_google_serp_html(*, query: str, gl: str, hl: str, timeout_s: float = 12.0) -> str:
    """
    Best-effort Google SERP HTML fetch.

    Notes:
    - This can be brittle (HTML shape changes) and may be blocked/rate-limited.
    - Keep strict timeouts; caller should handle partial data.
    """
    q = _normalize_kw(query)
    gl2 = (gl or "US").strip()[:8]
    hl2 = (hl or "en").strip()[:8]
    url = f"https://www.google.com/search?q={quote_plus(q)}&gl={quote_plus(gl2)}&hl={quote_plus(hl2)}&num=10&pws=0"
    headers = {
        "user-agent": random.choice(_UA_POOL),
        "accept-language": f"{hl2},{hl2}-US;q=0.9,en;q=0.8",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "cache-control": "no-cache",
        "pragma": "no-cache",
    }
    proxy = (os.environ.get("SCRAPER_HTTP_PROXY") or os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY") or "").strip() or None
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(timeout_s, connect=min(5.0, timeout_s), read=timeout_s),
        follow_redirects=True,
        proxy=proxy,
    ) as client:
        res = await client.get(url, headers=headers)
        res.raise_for_status()
        return res.text or ""


def extract_serp(*, query: str, gl: str, hl: str, html: str) -> SerpExtract:
    """
    Parse HTML and extract a minimal SERP representation.

    We deliberately keep extraction conservative: titles + hrefs from visible result blocks and
    "related searches" text, when present.
    """
    soup = BeautifulSoup(html or "", "lxml")

    results: list[dict[str, Any]] = []
    # Common pattern: <div class="g"> ... <h3>Title</h3> ... <a href="...">
    for h3 in soup.select("h3"):
        title = " ".join(h3.get_text(" ", strip=True).split())
        if not title:
            continue
        a = h3.find_parent("a")
        if not a:
            # Sometimes: <a> contains <h3>, not vice-versa.
            a = h3.find_previous("a")
        href = ""
        if a and a.has_attr("href"):
            href = str(a.get("href") or "")
        # Filter out internal navigation links.
        if href.startswith("/"):
            continue
        results.append({"title": title[:200], "url": href[:2048]})
        if len(results) >= 12:
            break

    related: list[str] = []
    # Related searches blocks often contain <a> with text; keep unique.
    for a in soup.select("a"):
        t = " ".join(a.get_text(" ", strip=True).split())
        if not t or len(t) < 3:
            continue
        if any(ch.isalnum() for ch in t) and len(t) <= 80:
            related.append(t)
        if len(related) >= 20:
            break

    # De-dupe preserving order
    seen = set()
    related2: list[str] = []
    for t in related:
        k = t.casefold()
        if k in seen:
            continue
        seen.add(k)
        related2.append(t)

    now = time.time()
    return SerpExtract(
        query=_normalize_kw(query),
        gl=(gl or "US").strip()[:8],
        hl=(hl or "en").strip()[:8],
        fetched_at=now,
        html_sha256=_sha256_text(html or ""),
        results=results,
        related_searches=related2,
    )

