"""SEO Health Score (Site-Audit-Design.md §106-§107), scoped to the 4 dimensions
this build's data actually supports: Crawlability, Indexability, On-Page, Internal
Linking. Content/Schema/Security/Performance are omitted entirely (never a
fabricated sub-score) until their own phases ship real data for them.

Crawlability and Indexability are computed directly from crawl counts/status (not
issue density -- more accurate, since not every non-indexable state has a matching
issue record). On-Page and Internal Linking use the same deterministic
"start at 100, subtract per-rule penalty scaled by affected fraction" pattern
already used by Technical Audit's Riviso Health Score, so both audit types read the
same way to a user.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from app.services.seo_crawler.rules import RULES

_SEVERITY_WEIGHT = {"issue": 18.0, "warning": 8.0, "opportunity": 3.0}
_ON_PAGE_CATEGORIES = {"Page Titles", "Meta Description", "H1", "Canonicals"}
_LINKING_CATEGORIES = {"Links"}


def _issue_density_score(issues: list[dict[str, Any]], categories: set[str], total_urls: int) -> int | None:
    if total_urls <= 0:
        return None
    by_rule: dict[str, set[str]] = defaultdict(set)
    for iss in issues:
        if iss.get("category") in categories and iss.get("url_id"):
            by_rule[iss["rule_id"]].add(iss["url_id"])
    score = 100.0
    for rule_id, url_ids in by_rule.items():
        meta = RULES.get(rule_id)
        weight = _SEVERITY_WEIGHT.get(meta.severity if meta else "warning", 5.0)
        fraction = len(url_ids) / total_urls
        score -= weight * min(fraction, 1.0)
    return max(0, round(score))


def compute_health_score(urls: list[dict[str, Any]], issues: list[dict[str, Any]], counts: dict[str, int]) -> dict[str, Any]:
    total_urls = len(urls)
    discovered = int(counts.get("discovered") or 0)

    crawlability: int | None = None
    if discovered > 0:
        fetched = int(counts.get("fetched") or 0)
        failed = int(counts.get("failed") or 0)
        blocked = int(counts.get("blocked") or 0)
        healthy = max(0, fetched - failed)
        crawlability = round(100 * healthy / discovered) if discovered else None
        if blocked:
            crawlability = max(0, crawlability - round(15 * blocked / discovered))

    indexability: int | None = None
    if total_urls > 0:
        indexable_n = sum(1 for u in urls if u.get("indexability") == "indexable")
        resolved_n = sum(1 for u in urls if u.get("indexability") in ("indexable", "non_indexable", "blocked"))
        indexability = round(100 * indexable_n / resolved_n) if resolved_n else None

    on_page = _issue_density_score(issues, _ON_PAGE_CATEGORIES, total_urls)
    internal_links = _issue_density_score(issues, _LINKING_CATEGORIES, total_urls)

    dims = {"crawlability": crawlability, "indexability": indexability, "on_page": on_page, "internal_links": internal_links}
    present = [v for v in dims.values() if v is not None]
    overall = round(sum(present) / len(present)) if present else None
    return {"overall": overall, **dims}
