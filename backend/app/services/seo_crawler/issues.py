"""Rule evaluation: crawled data -> `seo_audit_issues` records (§61-§66).

Runs once, after the crawl frontier is exhausted and `analysis.py` has annotated
inlink counts. Every produced issue is traceable to a URL and the rule input that
flagged it (§66/§Rule 4) -- no issue is ever produced without `evidence`.
"""

from __future__ import annotations

import secrets
from collections import defaultdict
from typing import Any

from app.services.seo_crawler.rules import RULE_ENGINE_VERSION, RULES

_TITLE_LEN_MAX = 60
_TITLE_LEN_MIN = 30
_META_LEN_MAX = 155

# fetcher.fetch_url error strings -> fetch-failure class. "ssrf_blocked" is Riviso's own
# SSRF guard refusing a private/loopback target (or a redirect to one): our policy, not a
# problem with the user's site, so it never becomes an issue.
_FETCH_ERROR_RULES = {"timeout": "crawl_timeout", "redirect_loop": "redirect_loop", "connection": "crawl_connection_error"}


def classify_fetch_error(status_text: str | None) -> str | None:
    """`timeout` | `redirect_loop` | `connection` | `ssrf_blocked`, or None when the
    text isn't a fetcher error (e.g. an ordinary HTTP reason phrase like "OK")."""
    s = (status_text or "").strip()
    if not s:
        return None
    if s == "timeout":
        return "timeout"
    if s.startswith("blocked"):  # "blocked: ..." and "blocked_redirect: ..."
        return "ssrf_blocked"
    if s.startswith("request_failed:"):
        # httpx raises TooManyRedirects once max_redirects (8, fetcher.build_http_client)
        # is exceeded -- a loop or an over-long chain; both leave the page unreachable.
        return "redirect_loop" if s.split(":", 1)[1].strip() == "TooManyRedirects" else "connection"
    return None


def _issue(audit_id: str, rule_id: str, url_doc: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    meta = RULES[rule_id]
    return {
        "id": secrets.token_hex(12),
        "audit_id": audit_id,
        "rule_id": rule_id,
        "rule_version": RULE_ENGINE_VERSION,
        "category": meta.category,
        "severity": meta.severity,
        "priority": meta.priority,
        "effort": meta.effort,
        "url_id": url_doc.get("id"),
        "url": url_doc.get("url"),
        "evidence": evidence,
        "recommendation": meta.recommendation,
    }


def evaluate(audit_id: str, urls: list[dict[str, Any]], links: list[dict[str, Any]], orphan_urls: set[str] | None = None) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    orphans = orphan_urls or set()
    by_normalized: dict[str, dict[str, Any]] = {u["normalized_url"]: u for u in urls if u.get("normalized_url")}

    title_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    meta_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    h1_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for u in urls:
        status = u.get("status_code")
        indexable = u.get("indexability") == "indexable"

        if isinstance(status, int) and 400 <= status <= 499:
            issues.append(_issue(audit_id, "response_4xx", u, {"status_code": status}))
        elif isinstance(status, int) and 500 <= status <= 599:
            issues.append(_issue(audit_id, "response_5xx", u, {"status_code": status}))

        hop_count = int(u.get("redirect_hop_count") or 0)
        if hop_count >= 2:
            issues.append(_issue(audit_id, "redirect_chain", u, {"hop_count": hop_count, "redirect_url": u.get("redirect_url")}))

        if u.get("indexability") == "non_indexable" and (u.get("indexability_reason") or "") == "noindex directive" and int(u.get("inlink_count") or 0) > 0:
            issues.append(_issue(audit_id, "noindex_indexable_target", u, {"inlink_count": u.get("inlink_count")}))

        # Fetch failures and robots-blocked URLs are never "indexable", so these run
        # before the gate below. Only a failed fetch has status_code None with text set.
        if status is None:
            error_class = classify_fetch_error(u.get("status_text"))
            rule_id = _FETCH_ERROR_RULES.get(error_class or "")
            if rule_id:
                issues.append(_issue(audit_id, rule_id, u, {"error": u.get("status_text"), "discovered_from": u.get("discovered_from")}))

        inlinks = u.get("inlink_count")
        if u.get("indexability") == "blocked" and isinstance(inlinks, int) and inlinks > 0:
            issues.append(_issue(audit_id, "blocked_by_robots_linked", u, {"inlink_count": inlinks, "reason": u.get("indexability_reason")}))

        if not indexable:
            continue  # on-page rules below only apply to pages meant to rank

        if u.get("normalized_url") in orphans:
            issues.append(_issue(audit_id, "orphan_page", u, {}))

        title = (u.get("title") or "").strip()
        if not title:
            issues.append(_issue(audit_id, "title_missing", u, {}))
        else:
            title_groups[title.lower()].append(u)
            tl = int(u.get("title_length") or len(title))
            if tl > _TITLE_LEN_MAX:
                issues.append(_issue(audit_id, "title_too_long", u, {"length": tl}))
            elif tl < _TITLE_LEN_MIN:
                issues.append(_issue(audit_id, "title_too_short", u, {"length": tl}))
        if int(u.get("title_count") or 0) > 1:
            issues.append(_issue(audit_id, "title_multiple", u, {"count": u.get("title_count")}))

        desc = (u.get("meta_description") or "").strip()
        if not desc:
            issues.append(_issue(audit_id, "meta_description_missing", u, {}))
        else:
            meta_groups[desc.lower()].append(u)
            dl = int(u.get("meta_description_length") or len(desc))
            if dl > _META_LEN_MAX:
                issues.append(_issue(audit_id, "meta_description_too_long", u, {"length": dl}))

        h1 = (u.get("h1") or "").strip()
        if not h1:
            issues.append(_issue(audit_id, "h1_missing", u, {}))
        else:
            h1_groups[h1.lower()].append(u)
        if int(u.get("h1_count") or 0) > 1:
            issues.append(_issue(audit_id, "h1_multiple", u, {"count": u.get("h1_count")}))

        canonical = (u.get("canonical") or "").strip()
        if not canonical:
            issues.append(_issue(audit_id, "canonical_missing", u, {}))
        else:
            target = by_normalized.get(canonical)
            if target is not None and target.get("indexability") not in ("indexable", None):
                issues.append(_issue(audit_id, "canonical_to_non_indexable", u, {"canonical": canonical, "target_indexability": target.get("indexability")}))

    for group in title_groups.values():
        if len(group) > 1:
            issues.extend(_issue(audit_id, "title_duplicate", u, {"duplicate_count": len(group)}) for u in group)
    for group in meta_groups.values():
        if len(group) > 1:
            issues.extend(_issue(audit_id, "meta_description_duplicate", u, {"duplicate_count": len(group)}) for u in group)
    for group in h1_groups.values():
        if len(group) > 1:
            issues.extend(_issue(audit_id, "h1_duplicate", u, {"duplicate_count": len(group)}) for u in group)

    # Broken internal links: any recorded anchor edge whose target resolved (within
    # this crawl) to a 4XX/5XX. Only edges we can resolve to a crawled URL count --
    # targets outside crawl scope aren't fetched in this phase (see crawler.py).
    by_id: dict[str, dict[str, Any]] = {u["id"]: u for u in urls if u.get("id")}
    for link in links:
        target = by_normalized.get(link.get("target_url"))
        if target is None:
            continue
        status = target.get("status_code")
        if isinstance(status, int) and status >= 400:
            source_doc = by_id.get(link.get("source_url_id")) or {"id": link.get("source_url_id"), "url": link.get("discovered_from") or "", "normalized_url": ""}
            issues.append(_issue(audit_id, "broken_internal_link", source_doc, {"target_url": link.get("target_url"), "target_status": status, "anchor_text": link.get("anchor_text")}))

    return issues
