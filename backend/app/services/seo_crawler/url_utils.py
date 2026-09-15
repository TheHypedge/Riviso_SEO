"""URL normalization, crawl scope, and folder-depth helpers.

Implements Site-Audit-Design.md §8 (URL Normalisation) and §6 (Crawl Scope, default
same-protocol + same-hostname). ``normalize_url`` is the crawl key: two discovered
URLs that normalize identically are the same crawl target and are only fetched once.
"""

from __future__ import annotations

import posixpath
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlsplit, urlunsplit

# Recognised tracking parameters stripped for the *normalized* (dedup) URL only —
# the originally discovered URL is preserved untouched. Never strips anything else;
# spec §9 explicitly forbids removing business-critical parameters automatically.
_TRACKING_PARAMS = frozenset(
    {
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "gclid",
        "fbclid",
        "msclkid",
    }
)

_DEFAULT_PORTS = {"http": 80, "https": 443}


def normalize_url(raw_url: str, base_url: str | None = None) -> str | None:
    """Resolve + normalize a discovered URL into a stable crawl key, or None if invalid."""
    raw = (raw_url or "").strip()
    if not raw:
        return None
    try:
        resolved = urljoin(base_url, raw) if base_url else raw
        parts = urlsplit(resolved)
    except Exception:
        return None
    scheme = (parts.scheme or "").lower()
    if scheme not in ("http", "https"):
        return None
    host = (parts.hostname or "").lower().rstrip(".")
    if not host:
        return None
    port = parts.port
    netloc = host if (port is None or port == _DEFAULT_PORTS.get(scheme)) else f"{host}:{port}"

    had_trailing_slash = parts.path.endswith("/") if parts.path else False
    path = posixpath.normpath(parts.path or "/")
    if path == ".":
        path = "/"
    if not path.startswith("/"):
        path = "/" + path
    # Trailing-slash policy: preserve exactly as discovered/linked. Stripping it
    # unconditionally (the naive approach) means the fetch target no longer matches
    # what the site actually links to -- on a server whose canonical form has the
    # slash (WordPress's default), that self-inflicted mismatch makes every single
    # page 301 right back to itself, which the crawler then misreports as a real
    # "URL redirects" indexability problem. Confirmed against a real site: this was
    # producing a false non-indexable finding on 64 of 65 real, perfectly indexable
    # pages. `posixpath.normpath` above already strips a trailing slash as part of
    # dot-segment resolution, so re-add it here when the original path had one.
    if had_trailing_slash and len(path) > 0 and not path.endswith("/"):
        path = path + "/"

    query_pairs = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k not in _TRACKING_PARAMS]
    query_pairs.sort()
    query = urlencode(query_pairs)

    # Fragments never create separate crawl targets (§8) unless a future SPA/fragment
    # routing mode is added — not in Phase 1 scope.
    return urlunsplit((scheme, netloc, path, query, ""))


def encoded_url(normalized: str) -> str:
    """The normalized URL is already percent-safe via urlencode/urlsplit; kept as its own
    accessor so callers match the CrawlUrl model's `encodedUrl` field name (§18)."""
    return normalized


def registrable_host(url: str) -> str | None:
    try:
        return (urlparse(url).hostname or "").lower().rstrip(".") or None
    except Exception:
        return None


def same_scope(url: str, seed_host: str) -> bool:
    """Default crawl scope (§6): same hostname. Subdomains are out of scope by default."""
    host = registrable_host(url)
    return bool(host) and host == (seed_host or "").lower().rstrip(".")


def folder_depth(url: str) -> int:
    """Number of non-empty path segments — kept distinct from crawl depth (§46)."""
    try:
        path = urlparse(url).path or "/"
    except Exception:
        return 0
    return len([seg for seg in path.split("/") if seg])


def is_html_content_type(content_type: str | None) -> bool:
    ct = (content_type or "").split(";", 1)[0].strip().lower()
    return ct in ("text/html", "application/xhtml+xml")
