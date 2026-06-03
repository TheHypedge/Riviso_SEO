"""SSRF protection for outbound HTTP to user-supplied URLs (S1.6a/b/c).

Use :func:`assert_public_http_url` before fetching any URL whose host can be
influenced by a user (WordPress site URL, featured-image URLs, OpenAI reference
images, Shopify shop domains). It blocks non-HTTP(S) schemes and any host that
resolves to a private, loopback, link-local, reserved, multicast, or cloud
metadata address — the classic SSRF pivots (e.g. ``169.254.169.254``, ``10.x``).

For redirect-following requests, pair it with :func:`raise_on_private_redirect`
as an httpx response event hook so a 3xx to an internal address is rejected too.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urljoin, urlparse

import httpx

# Hostnames that must never be fetched even if DNS would resolve them publicly.
_BLOCKED_HOSTNAMES = frozenset(
    {
        "metadata.google.internal",
        "metadata",
    }
)


class SsrfError(ValueError):
    """Raised when a URL is rejected by the SSRF guard."""


def _ip_is_disallowed(addr: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def _resolved_ips_are_public(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return False
    if not infos:
        return False
    for info in infos:
        ip = info[4][0]
        # Strip IPv6 scope id if present (e.g. "fe80::1%eth0").
        ip = ip.split("%", 1)[0]
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return False
        if _ip_is_disallowed(addr):
            return False
    return True


def is_public_http_url(url: str) -> tuple[bool, str]:
    """Return (ok, reason). ``ok`` is True only for public http(s) hosts."""
    try:
        parsed = urlparse((url or "").strip())
    except Exception:
        return False, "invalid_url"
    if parsed.scheme not in ("http", "https"):
        return False, "scheme_not_allowed"
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not host:
        return False, "missing_host"
    if host in _BLOCKED_HOSTNAMES:
        return False, "blocked_host"
    # Literal IP in the URL — check directly, no DNS.
    try:
        addr = ipaddress.ip_address(host)
        return (False, "private_ip") if _ip_is_disallowed(addr) else (True, "")
    except ValueError:
        pass
    if not _resolved_ips_are_public(host):
        return False, "private_or_unresolvable_host"
    return True, ""


def assert_public_http_url(url: str) -> None:
    """Raise :class:`SsrfError` if ``url`` is not a public http(s) URL."""
    ok, reason = is_public_http_url(url)
    if not ok:
        raise SsrfError(f"Refusing to fetch non-public URL ({reason})")


async def raise_on_private_redirect(response: "httpx.Response") -> None:
    """httpx response hook: reject redirects whose target is non-public."""
    if response.is_redirect:
        location = response.headers.get("location")
        if location:
            target = urljoin(str(response.url), location)
            assert_public_http_url(target)


def ssrf_guarded_event_hooks() -> dict:
    """Event-hooks dict for ``httpx.AsyncClient`` that blocks redirect-based SSRF."""
    return {"response": [raise_on_private_redirect]}
