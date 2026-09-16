"""
Brand-citation detection: did an AI engine's answer mention this project's brand?

Pure functions, no I/O -- unit-testable in isolation (see
backend/tests/test_ai_citation_detection.py).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlparse


def normalize_domain(url_or_domain: str) -> str:
    """Bare lowercase host, `www.` stripped. `""` if nothing usable."""
    raw = (url_or_domain or "").strip()
    if not raw:
        return ""
    if "://" not in raw:
        raw = f"https://{raw}"
    try:
        host = (urlparse(raw).netloc or "").strip().lower()
    except Exception:
        return ""
    if host.startswith("www."):
        host = host[4:]
    return host.split(":")[0]


@dataclass
class DetectionResult:
    cited: bool
    match_type: str | None  # "domain_in_text" | "domain_in_citation_url" | "brand_name_in_text" | None
    matched_snippet: str | None


_SNIPPET_RADIUS = 80


def _snippet_around(text: str, start: int, end: int) -> str:
    lo = max(0, start - _SNIPPET_RADIUS)
    hi = min(len(text), end + _SNIPPET_RADIUS)
    prefix = "…" if lo > 0 else ""
    suffix = "…" if hi < len(text) else ""
    return f"{prefix}{text[lo:hi].strip()}{suffix}"


def detect_citation(
    *,
    response_text: str,
    citation_urls: list[str] | None,
    project_domain: str,
    brand_name: str,
) -> DetectionResult:
    """
    `cited=True` if the project's domain appears in the response text or in any
    engine-returned citation URL, or (weaker signal) the brand name appears as a
    whole word in the text.

    # ponytail: exact substring/host match, not fuzzy/NLP brand matching --
    # upgrade to fuzzy/alias matching only if false-negative rate becomes a
    # real problem in practice.
    """
    text = response_text or ""
    domain = normalize_domain(project_domain)

    if domain:
        idx = text.lower().find(domain)
        if idx >= 0:
            return DetectionResult(True, "domain_in_text", _snippet_around(text, idx, idx + len(domain)))

        for url in citation_urls or []:
            if normalize_domain(url) == domain:
                return DetectionResult(True, "domain_in_citation_url", url)

    brand = (brand_name or "").strip()
    if brand:
        pattern = re.compile(r"\b" + re.escape(brand) + r"\b", re.IGNORECASE)
        m = pattern.search(text)
        if m:
            return DetectionResult(True, "brand_name_in_text", _snippet_around(text, m.start(), m.end()))

    return DetectionResult(False, None, None)
