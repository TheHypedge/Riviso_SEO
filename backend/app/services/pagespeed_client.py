"""
Google PageSpeed Insights client + response normalizer (Technical Audit, Phase 1).

Every value the normalizer produces is read directly out of Google's own response --
scores, Core Web Vitals, opportunities, diagnostics. Nothing here invents a metric,
threshold, or classification that Google/Lighthouse didn't already supply (see
backend/docs/SITE-AUDIT-GUIDE.md §16-24/§70 for why that matters).
"""

from __future__ import annotations

import logging
from typing import Any, Literal

import httpx

from app.core.config import settings
from app.services.url_guard import assert_public_http_url

log = logging.getLogger(__name__)

PAGESPEED_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"

# Lighthouse audit ids that back the metrics we surface -- lab data, always present when
# the audit ran at all (unlike `loadingExperience`, which needs enough real-user traffic).
_CWV_AUDIT_IDS: dict[str, str] = {
    "lcp": "largest-contentful-paint",
    "inp": "interaction-to-next-paint",
    "cls": "cumulative-layout-shift",
    "fcp": "first-contentful-paint",
    "speed_index": "speed-index",
    "tbt": "total-blocking-time",
    "ttfb": "server-response-time",
}
# CrUX field-data metric keys (real user data; may be entirely absent for low-traffic sites).
_CWV_FIELD_KEYS: dict[str, str] = {
    "lcp": "LARGEST_CONTENTFUL_PAINT_MS",
    "inp": "INTERACTION_TO_NEXT_PAINT",
    "cls": "CUMULATIVE_LAYOUT_SHIFT_SCORE",
    "fcp": "FIRST_CONTENTFUL_PAINT_MS",
}


def pagespeed_configured() -> bool:
    return bool((settings.google_pagespeed_api_key or "").strip())


async def fetch_pagespeed_result(*, url: str, strategy: Literal["mobile", "desktop"], timeout_s: float = 45.0) -> dict[str, Any]:
    """Raw PSI v5 response for one strategy. Raises RuntimeError with the API's own message on failure."""
    api_key = (settings.google_pagespeed_api_key or "").strip()
    if not api_key:
        raise RuntimeError("Google PageSpeed Insights is not configured (GOOGLE_PAGESPEED_API_KEY unset).")
    assert_public_http_url(url)

    params = {
        "url": url,
        "key": api_key,
        "strategy": strategy,
        "category": ["performance", "accessibility", "best-practices", "seo"],
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_s, connect=10.0), follow_redirects=True) as client:
        res = await client.get(PAGESPEED_ENDPOINT, params=params)
    data = res.json() if res.content else {}
    if res.status_code != 200:
        msg = ((data.get("error") or {}).get("message") if isinstance(data, dict) else None) or f"HTTP {res.status_code}"
        raise RuntimeError(f"PageSpeed Insights request failed ({strategy}): {msg}")
    return data


def _category_score(raw: dict[str, Any], key: str) -> int | None:
    cat = ((raw.get("lighthouseResult") or {}).get("categories") or {}).get(key)
    score = (cat or {}).get("score")
    if score is None:
        return None
    try:
        return round(float(score) * 100)
    except (TypeError, ValueError):
        return None


def _lab_status_from_score(score: float | None) -> str | None:
    """Lighthouse's own conventional score bands (0.9/0.5 cutoffs) -- not a Riviso threshold."""
    if score is None:
        return None
    if score >= 0.9:
        return "good"
    if score >= 0.5:
        return "needs_improvement"
    return "poor"


def _field_status(category: str | None) -> str | None:
    if not category:
        return None
    c = category.strip().upper()
    if c in ("FAST", "GOOD"):
        return "good"
    if c in ("AVERAGE", "NEEDS_IMPROVEMENT"):
        return "needs_improvement"
    if c in ("SLOW", "POOR"):
        return "poor"
    return None


def _extract_core_web_vitals(raw: dict[str, Any]) -> dict[str, Any]:
    audits = ((raw.get("lighthouseResult") or {}).get("audits") or {})
    field_metrics = ((raw.get("loadingExperience") or {}).get("metrics") or {})

    out: dict[str, Any] = {}
    for key, audit_id in _CWV_AUDIT_IDS.items():
        audit = audits.get(audit_id)
        if not isinstance(audit, dict):
            continue
        lab_score = audit.get("score")
        entry: dict[str, Any] = {
            "display_value": audit.get("displayValue"),
            "numeric_value": audit.get("numericValue"),
            # Field data (real users) wins when available; else fall back to Lighthouse's
            # own lab-score bands -- both are Google's classification, never a custom one.
            "status": None,
            "source": None,
        }
        field_key = _CWV_FIELD_KEYS.get(key)
        field_entry = field_metrics.get(field_key) if field_key else None
        if isinstance(field_entry, dict) and field_entry.get("category"):
            entry["status"] = _field_status(field_entry.get("category"))
            entry["source"] = "field"
        elif lab_score is not None:
            entry["status"] = _lab_status_from_score(float(lab_score))
            entry["source"] = "lab"
        if entry["display_value"] is None and entry["numeric_value"] is None and entry["status"] is None:
            continue
        out[key] = entry
    return out


def _extract_opportunities_and_diagnostics(raw: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    audits = ((raw.get("lighthouseResult") or {}).get("audits") or {})
    opportunities: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []

    cwv_audit_ids = set(_CWV_AUDIT_IDS.values())

    for audit_id, audit in audits.items():
        if not isinstance(audit, dict):
            continue
        # Already shown prominently in the Core Web Vitals section (doc §18: primary
        # metrics first, diagnostics separately below) -- don't repeat them here.
        if audit_id in cwv_audit_ids:
            continue
        score = audit.get("score")
        display_mode = audit.get("scoreDisplayMode")
        details = audit.get("details") if isinstance(audit.get("details"), dict) else {}
        # Only surface audits that actually found something to report -- a passing
        # audit (score == 1, or informative/notApplicable) has nothing actionable to show.
        if display_mode not in ("binary", "numeric", "metricSavings"):
            continue
        if score is not None and float(score) >= 0.9:
            continue

        if details.get("type") == "opportunity":
            opportunities.append(
                {
                    "id": audit_id,
                    "title": audit.get("title"),
                    "description": audit.get("description"),
                    "display_value": audit.get("displayValue"),
                    "overall_savings_ms": details.get("overallSavingsMs"),
                    "overall_savings_bytes": details.get("overallSavingsBytes"),
                    "affected_resources": len(details.get("items") or []),
                }
            )
        elif score is not None:
            diagnostics.append(
                {
                    "id": audit_id,
                    "title": audit.get("title"),
                    "description": audit.get("description"),
                    "display_value": audit.get("displayValue"),
                    "score": round(float(score) * 100),
                }
            )
    return opportunities, diagnostics


def _extract_category_failures(raw: dict[str, Any], category_key: str) -> list[dict[str, Any]]:
    lighthouse = raw.get("lighthouseResult") or {}
    audits = lighthouse.get("audits") or {}
    cat = (lighthouse.get("categories") or {}).get(category_key) or {}
    out: list[dict[str, Any]] = []
    for ref in cat.get("auditRefs") or []:
        audit_id = (ref or {}).get("id")
        audit = audits.get(audit_id)
        if not isinstance(audit, dict):
            continue
        score = audit.get("score")
        if audit.get("scoreDisplayMode") not in ("binary", "numeric"):
            continue
        if score is None or float(score) >= 0.9:
            continue
        out.append(
            {
                "id": audit_id,
                "title": audit.get("title"),
                "description": audit.get("description"),
                "score": round(float(score) * 100),
            }
        )
    return out


def _extract_category_summary(raw: dict[str, Any], category_key: str) -> dict[str, int]:
    """Passed/warnings/failed counts for a category's scored audits.

    Walks the same `auditRefs` list as `_extract_category_failures`, using the same
    binary/numeric-only filter and the same 0.9/0.5 cutoffs `_lab_status_from_score`
    uses elsewhere -- so these counts and the failures list can never disagree.
    """
    lighthouse = raw.get("lighthouseResult") or {}
    audits = lighthouse.get("audits") or {}
    cat = (lighthouse.get("categories") or {}).get(category_key) or {}
    passed = warnings = failed = 0
    for ref in cat.get("auditRefs") or []:
        audit_id = (ref or {}).get("id")
        audit = audits.get(audit_id)
        if not isinstance(audit, dict):
            continue
        if audit.get("scoreDisplayMode") not in ("binary", "numeric"):
            continue
        score = audit.get("score")
        if score is None:
            continue
        score = float(score)
        if score >= 0.9:
            passed += 1
        elif score >= 0.5:
            warnings += 1
        else:
            failed += 1
    return {"passed": passed, "warnings": warnings, "failed": failed}


def normalize_pagespeed_result(raw: dict[str, Any]) -> dict[str, Any]:
    """Compact shape the Technical Audit UI reads -- only fields actually present in `raw`."""
    opportunities, diagnostics = _extract_opportunities_and_diagnostics(raw)
    return {
        "scores": {
            "performance": _category_score(raw, "performance"),
            "accessibility": _category_score(raw, "accessibility"),
            "best_practices": _category_score(raw, "best-practices"),
            # Explicitly the PageSpeed/Lighthouse SEO category -- never "Riviso SEO Score" (§23).
            "pagespeed_seo": _category_score(raw, "seo"),
        },
        "core_web_vitals": _extract_core_web_vitals(raw),
        "opportunities": opportunities,
        "diagnostics": diagnostics,
        "accessibility_failures": _extract_category_failures(raw, "accessibility"),
        "best_practices_failures": _extract_category_failures(raw, "best-practices"),
        "accessibility_summary": _extract_category_summary(raw, "accessibility"),
        "best_practices_summary": _extract_category_summary(raw, "best-practices"),
        "fetch_time": (raw.get("lighthouseResult") or {}).get("fetchTime"),
        "final_url": (raw.get("lighthouseResult") or {}).get("finalUrl") or raw.get("id"),
    }
