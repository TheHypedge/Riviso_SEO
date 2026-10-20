"""
Google PageSpeed Insights client + response normalizer (Technical Audit, Phase 1).

Every value the normalizer produces is read directly out of Google's own response --
scores, Core Web Vitals, opportunities, diagnostics. Nothing here invents a metric,
threshold, or classification that Google/Lighthouse didn't already supply (see
backend/docs/SITE-AUDIT-GUIDE.md §16-24/§70 for why that matters).
"""

from __future__ import annotations

import logging
import re
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
        # Google's strings (titles, descriptions, displayValues) in one consistent language.
        "locale": "en",
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


def _field_metrics(raw: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    """CrUX metrics for this exact page, else for the whole origin (low-traffic pages often
    have no page-level data). The second value says which one, so the UI never presents
    origin-wide data as if it were this page's."""
    page = (raw.get("loadingExperience") or {}).get("metrics") or {}
    if page:
        return page, "field"
    origin = (raw.get("originLoadingExperience") or {}).get("metrics") or {}
    if origin:
        return origin, "field_origin"
    return {}, None


def _extract_core_web_vitals(raw: dict[str, Any]) -> dict[str, Any]:
    """Lab (Lighthouse) values. Status always comes from the same audit's own score, so a
    value and its status can never come from different sources -- real-user (field) data
    lives separately in `field` (see _extract_field)."""
    audits = ((raw.get("lighthouseResult") or {}).get("audits") or {})

    out: dict[str, Any] = {}
    for key, audit_id in _CWV_AUDIT_IDS.items():
        audit = audits.get(audit_id)
        if not isinstance(audit, dict):
            continue
        lab_score = audit.get("score")
        display = audit.get("displayValue")
        numeric = audit.get("numericValue")
        if key == "ttfb" and isinstance(numeric, (int, float)):
            # server-response-time's displayValue is a sentence ("Root document took 60 ms").
            display = f"{round(numeric)} ms"
        entry: dict[str, Any] = {
            "display_value": display,
            "numeric_value": numeric,
            "score": lab_score,
            "status": _lab_status_from_score(float(lab_score)) if lab_score is not None else None,
            "source": "lab",
        }
        if entry["display_value"] is None and entry["numeric_value"] is None and entry["status"] is None:
            continue
        out[key] = entry
    return out


# CrUX keys -> our metric keys. TTFB is still reported under an EXPERIMENTAL_ name.
_FIELD_KEYS: dict[str, str] = {**_CWV_FIELD_KEYS, "ttfb": "EXPERIMENTAL_TIME_TO_FIRST_BYTE"}


def _field_value(metric: str, v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    # CrUX reports CLS percentiles and distribution bounds multiplied by 100.
    return round(v / 100, 3) if metric == "cls" else float(v)


def _extract_field(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Chrome real-user data (CrUX) for this URL, else for the whole origin -- never mixed:
    one scope for every metric, labelled. None when PageSpeed returned no field data."""
    metrics_src, source = _field_metrics(raw)
    if not metrics_src:
        return None
    exp_key = "loadingExperience" if source == "field" else "originLoadingExperience"
    metrics: dict[str, Any] = {}
    for key, crux_key in _FIELD_KEYS.items():
        m = metrics_src.get(crux_key)
        if not isinstance(m, dict):
            continue
        dist = []
        for d in (m.get("distributions") or [])[:3]:
            if isinstance(d, dict) and isinstance(d.get("proportion"), (int, float)):
                dist.append({"min": _field_value(key, d.get("min")), "max": _field_value(key, d.get("max")), "proportion": round(float(d["proportion"]), 4)})
        metrics[key] = {"percentile": _field_value(key, m.get("percentile")), "status": _field_status(m.get("category")), "distributions": dist}
    return {
        "scope": "url" if source == "field" else "origin",
        "overall_status": _field_status((raw.get(exp_key) or {}).get("overall_category")),
        "metrics": metrics,
    }


# Lighthouse categories with their own findings list, in claim order: an audit referenced
# by more than one of them is listed only under the first (and never in diagnostics).
_FINDING_CATEGORIES: tuple[tuple[str, str], ...] = (
    ("accessibility", "accessibility_failures"),
    ("best-practices", "best_practices_failures"),
    ("seo", "seo_failures"),
)

# Affected-resource samples kept per finding. Full Lighthouse `details` can be hundreds of
# KB per audit; only a handful of examples plus the total count is stored.
_MAX_SAMPLES = 5
_MAX_SAMPLE_STR = 200


_DATA_URI_RE = re.compile(r"data:[^\s\"'()<>]+", re.IGNORECASE)


def _clip(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    # Never store inline base64 resources (e.g. an <img src="data:..."> snippet).
    s = _DATA_URI_RE.sub("data:…", " ".join(value.split()))
    if not s or s == "data:…":
        return None
    return s if len(s) <= _MAX_SAMPLE_STR else s[: _MAX_SAMPLE_STR - 1] + "…"


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return round(float(value), 1)


def _detail_items(details: dict[str, Any]) -> list[dict[str, Any]]:
    """Table/opportunity items, flattening Lighthouse's `list` wrapper of sub-tables."""
    if details.get("type") == "list":
        out: list[dict[str, Any]] = []
        for sub in details.get("items") or []:
            if isinstance(sub, dict):
                out.extend(i for i in (sub.get("items") or []) if isinstance(i, dict))
        return out
    return [i for i in (details.get("items") or []) if isinstance(i, dict)]


def _sample(item: dict[str, Any]) -> dict[str, Any] | None:
    node = item.get("node") if isinstance(item.get("node"), dict) else {}
    source = item.get("source") if isinstance(item.get("source"), dict) else {}
    url = item.get("url")
    if isinstance(url, dict):  # some audits nest a typed url value
        url = url.get("value")
    sample = {
        "url": _clip(url) or _clip(source.get("url")),
        "label": _clip(node.get("nodeLabel")) or _clip(item.get("label")),
        "snippet": _clip(node.get("snippet")),
        "selector": _clip(node.get("selector")),
        "wasted_bytes": _number(item.get("wastedBytes")),
        "wasted_ms": _number(item.get("wastedMs")),
    }
    sample = {k: v for k, v in sample.items() if v is not None}
    return sample or None


def _affected(details: dict[str, Any]) -> dict[str, Any]:
    items = _detail_items(details)
    samples = [s for s in (_sample(i) for i in items[: _MAX_SAMPLES * 2]) if s][:_MAX_SAMPLES]
    return {"item_count": len(items), "samples": samples}


# Performance auditRef groups: "insights" (Lighthouse 13+) / "load-opportunities" (older)
# are opportunities; "metrics"/"hidden" are measurements already shown as Core Web Vitals.
_OPPORTUNITY_GROUPS = {"insights", "load-opportunities"}
_METRIC_GROUPS = {"metrics", "hidden"}


def _metric_savings(audit: dict[str, Any]) -> dict[str, float]:
    """Google's per-metric estimated savings (e.g. {"LCP": 2500, "FCP": 300}), non-zero only."""
    raw = audit.get("metricSavings") if isinstance(audit.get("metricSavings"), dict) else {}
    out = {str(k): v for k, v in ((k, _number(v)) for k, v in raw.items()) if v}
    return out


def _best_savings_ms(finding: dict[str, Any]) -> float:
    """The largest time saving Google estimated for a finding: its `overallSavingsMs`, or
    the largest single per-metric saving (different metrics are never summed)."""
    values = [_number(finding.get("overall_savings_ms")) or 0.0, *((finding.get("metric_savings") or {}).values())]
    return max(float(v) for v in values)


def _category_audit_ids(raw: dict[str, Any], category_key: str) -> list[str]:
    cat = (((raw.get("lighthouseResult") or {}).get("categories") or {}).get(category_key)) or {}
    return [r.get("id") for r in (cat.get("auditRefs") or []) if isinstance(r, dict) and r.get("id")]


def _claimed_category_ids(raw: dict[str, Any]) -> dict[str, str]:
    """audit id -> the one findings list that owns it (first category wins)."""
    owner: dict[str, str] = {}
    for category_key, list_key in _FINDING_CATEGORIES:
        for audit_id in _category_audit_ids(raw, category_key):
            owner.setdefault(audit_id, list_key)
    return owner


def _extract_opportunities_and_diagnostics(raw: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    audits = ((raw.get("lighthouseResult") or {}).get("audits") or {})
    opportunities: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []

    cwv_audit_ids = set(_CWV_AUDIT_IDS.values())
    category_owned = _claimed_category_ids(raw)
    perf_group = {
        r.get("id"): r.get("group")
        for r in ((((raw.get("lighthouseResult") or {}).get("categories") or {}).get("performance") or {}).get("auditRefs") or [])
        if isinstance(r, dict)
    }

    for audit_id, audit in audits.items():
        if not isinstance(audit, dict):
            continue
        # Already shown prominently in the Core Web Vitals section (doc §18: primary
        # metrics first, diagnostics separately below) -- don't repeat them here.
        if audit_id in cwv_audit_ids:
            continue
        # Metric audits (incl. ones Lighthouse itself hides, e.g. "interactive") are
        # measurements, not findings.
        if perf_group.get(audit_id) in _METRIC_GROUPS:
            continue
        # Accessibility / Best Practices / SEO audits are listed under their own labeled
        # section; without this they also leaked into diagnostics unlabeled.
        if audit_id in category_owned:
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

        affected = _affected(details)
        metric_savings = _metric_savings(audit)
        # Lighthouse's own grouping decides opportunity vs diagnostic. Lighthouse 13 reports
        # most opportunities as "insights" (table/list details + per-metric `metricSavings`),
        # so `details.type == "opportunity"` alone now misses them.
        if perf_group.get(audit_id) in _OPPORTUNITY_GROUPS or details.get("type") == "opportunity":
            opportunities.append(
                {
                    "id": audit_id,
                    "title": audit.get("title"),
                    "description": audit.get("description"),
                    "display_value": audit.get("displayValue"),
                    "score": round(float(score) * 100) if score is not None else None,
                    "overall_savings_ms": details.get("overallSavingsMs"),
                    "overall_savings_bytes": details.get("overallSavingsBytes"),
                    "metric_savings": metric_savings,
                    # Kept for old clients; same number as item_count.
                    "affected_resources": affected["item_count"],
                    **affected,
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
                    "metric_savings": metric_savings,
                    **affected,
                }
            )
    return opportunities, diagnostics


def _extract_category_failures(raw: dict[str, Any], category_key: str) -> list[dict[str, Any]]:
    lighthouse = raw.get("lighthouseResult") or {}
    audits = lighthouse.get("audits") or {}
    list_key = dict(_FINDING_CATEGORIES).get(category_key)
    owner = _claimed_category_ids(raw)
    out: list[dict[str, Any]] = []
    for audit_id in _category_audit_ids(raw, category_key):
        if list_key and owner.get(audit_id) != list_key:
            continue  # already listed under an earlier category
        audit = audits.get(audit_id)
        if not isinstance(audit, dict):
            continue
        score = audit.get("score")
        if audit.get("scoreDisplayMode") not in ("binary", "numeric"):
            continue
        if score is None or float(score) >= 0.9:
            continue
        details = audit.get("details") if isinstance(audit.get("details"), dict) else {}
        out.append(
            {
                "id": audit_id,
                "title": audit.get("title"),
                "description": audit.get("description"),
                "display_value": audit.get("displayValue"),
                "score": round(float(score) * 100),
                **_affected(details),
            }
        )
    return out


_FIX_FIRST_LIMIT = 5


def _fix_first(sections: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """Top findings across every section, ranked only by Google's own numbers: estimated
    time savings (see `_best_savings_ms`), then bytes, then the lowest audit score. No Riviso
    impact/effort labels."""
    ranked: list[tuple[tuple[float, float, float], dict[str, Any]]] = []
    for section, findings in sections.items():
        for f in findings:
            ms = _best_savings_ms(f)
            by = _number(f.get("overall_savings_bytes")) or 0.0
            score = f.get("score")
            key = (-ms, -by, float(score) if isinstance(score, (int, float)) else 101.0)
            samples = f.get("samples") or []
            ranked.append(
                (
                    key,
                    {
                        "id": f.get("id"),
                        "section": section,
                        "title": f.get("title"),
                        "display_value": f.get("display_value"),
                        "score": score,
                        "overall_savings_ms": f.get("overall_savings_ms"),
                        "overall_savings_bytes": f.get("overall_savings_bytes"),
                        "metric_savings": f.get("metric_savings") or {},
                        "sample": samples[0] if samples else None,
                        "item_count": f.get("item_count", 0),
                    },
                )
            )
    ranked.sort(key=lambda kv: kv[0])  # stable: ties keep section order
    return [item for _, item in ranked[:_FIX_FIRST_LIMIT]]


def _extract_category_summary(raw: dict[str, Any], category_key: str) -> dict[str, int]:
    """Passed/warnings/failed counts for a category's scored audits.

    Walks the same `auditRefs` list as `_extract_category_failures`, using the same
    binary/numeric-only filter and the same 0.9/0.5 cutoffs `_lab_status_from_score`
    uses elsewhere -- so these counts and the failures list can never disagree.
    """
    audits = (raw.get("lighthouseResult") or {}).get("audits") or {}
    list_key = dict(_FINDING_CATEGORIES).get(category_key)
    owner = _claimed_category_ids(raw)
    passed = warnings = failed = 0
    for audit_id in _category_audit_ids(raw, category_key):
        if list_key and owner.get(audit_id) != list_key:
            continue
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


# Lighthouse category ids -> the keys this app uses everywhere else.
_CATEGORY_KEYS: tuple[tuple[str, str], ...] = (
    ("performance", "performance"),
    ("accessibility", "accessibility"),
    ("best-practices", "best_practices"),
    ("seo", "seo"),
)
_MAX_DESCRIPTION = 600


def classify_audit(audit: dict[str, Any]) -> str:
    """failed | warning | passed | informational | manual | not_applicable | error, using
    only Lighthouse's own scoreDisplayMode and score bands (0.9 / 0.5)."""
    mode = audit.get("scoreDisplayMode")
    if mode == "notApplicable":
        return "not_applicable"
    if mode == "manual":
        return "manual"
    if mode == "error":
        return "error"
    if mode == "informative":
        return "informational"
    score = audit.get("score")
    if score is None:
        return "informational"
    score = float(score)
    if score >= 0.9:
        return "passed"
    return "warning" if score >= 0.5 else "failed"


def _extract_audits_index(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """Every audit Lighthouse ran, listed once under the category that owns it (first
    category wins, e.g. `image-alt` is Accessibility, not SEO). Metric measurements and
    Lighthouse's hidden audits are excluded; they are shown as metrics, not findings.
    Passed / not-applicable audits keep only title + status to stay small."""
    lh = raw.get("lighthouseResult") or {}
    audits = lh.get("audits") or {}
    groups = {k: (v or {}).get("title") for k, v in (lh.get("categoryGroups") or {}).items()}
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for lh_key, key in _CATEGORY_KEYS:
        cat = (lh.get("categories") or {}).get(lh_key) or {}
        for ref in cat.get("auditRefs") or []:
            audit_id = (ref or {}).get("id")
            group = ref.get("group")
            audit = audits.get(audit_id)
            if not audit_id or audit_id in seen or not isinstance(audit, dict) or group in _METRIC_GROUPS:
                continue
            seen.add(audit_id)
            kind = classify_audit(audit)
            score = audit.get("score")
            row: dict[str, Any] = {
                "id": audit_id,
                "title": _clip(audit.get("title")),
                "category": key,
                "group": group,
                "group_title": groups.get(group) if group else None,
                "kind": kind,
                "score": round(float(score) * 100) if score is not None and kind not in ("not_applicable", "manual") else None,
                "display_value": _clip(audit.get("displayValue")),
            }
            if kind in ("failed", "warning", "informational", "manual", "error"):
                details = audit.get("details") if isinstance(audit.get("details"), dict) else {}
                desc = " ".join(str(audit.get("description") or "").split())
                row["description"] = desc[:_MAX_DESCRIPTION] or None
                row["metric_savings"] = _metric_savings(audit)
                if details.get("type") == "opportunity":
                    row["overall_savings_ms"] = details.get("overallSavingsMs")
                    row["overall_savings_bytes"] = details.get("overallSavingsBytes")
                if kind == "error":
                    row["error_message"] = _clip(audit.get("errorMessage"))
                row.update(_affected(details))
            out.append(row)
    return out


_MAX_WARNINGS = 10


def _extract_run_meta(raw: dict[str, Any]) -> dict[str, Any]:
    lh = raw.get("lighthouseResult") or {}
    env = lh.get("environment") or {}
    cfg = lh.get("configSettings") or {}
    return {
        "requested_url": lh.get("requestedUrl"),
        "lighthouse_version": lh.get("lighthouseVersion"),
        "form_factor": cfg.get("formFactor"),
        "locale": cfg.get("locale"),
        # Emulated device user agent, e.g. "...Android 11; moto g power (2022)...".
        "emulated_user_agent": _clip(env.get("networkUserAgent")),
        "benchmark_index": _number(env.get("benchmarkIndex")),
        # Never hide a Lighthouse warning (e.g. "unable to reliably load the page ... 502").
        "run_warnings": [w for w in (_clip(x) for x in (lh.get("runWarnings") or [])[:_MAX_WARNINGS]) if w],
    }


_SCREENSHOT_RE = re.compile(r"^data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=\s]+)$")
_MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
_IMAGE_MAGIC = (b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n", b"RIFF")


def extract_final_screenshot(raw: dict[str, Any]) -> bytes | None:
    """Decoded bytes of Lighthouse's `final-screenshot` (viewport) for upload to image
    storage. None unless it is a real JPEG/PNG/WebP within the size cap. The base64 is
    never stored anywhere."""
    import base64
    import binascii

    details = (((raw.get("lighthouseResult") or {}).get("audits") or {}).get("final-screenshot") or {}).get("details") or {}
    m = _SCREENSHOT_RE.match(str(details.get("data") or ""))
    if not m:
        return None
    try:
        data = base64.b64decode(m.group(2), validate=False)
    except (binascii.Error, ValueError):
        return None
    if not data or len(data) > _MAX_SCREENSHOT_BYTES or not data.startswith(_IMAGE_MAGIC):
        return None
    return data


def normalize_pagespeed_result(raw: dict[str, Any]) -> dict[str, Any]:
    """Compact shape the Technical Audit UI reads -- only fields actually present in `raw`."""
    opportunities, diagnostics = _extract_opportunities_and_diagnostics(raw)
    failures = {list_key: _extract_category_failures(raw, cat) for cat, list_key in _FINDING_CATEGORIES}
    _, field_source = _field_metrics(raw)
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
        **failures,
        "accessibility_summary": _extract_category_summary(raw, "accessibility"),
        "best_practices_summary": _extract_category_summary(raw, "best-practices"),
        "seo_summary": _extract_category_summary(raw, "seo"),
        "fix_first": _fix_first({"opportunities": opportunities, "diagnostics": diagnostics, **failures}),
        # "field" = this page's real-user data, "field_origin" = whole-site real-user data,
        # None = lab data only.
        "field_data_source": field_source,
        "fetch_time": (raw.get("lighthouseResult") or {}).get("fetchTime"),
        "final_url": (raw.get("lighthouseResult") or {}).get("finalUrl") or raw.get("id"),
        "field": _extract_field(raw),
        "audits_index": _extract_audits_index(raw),
        **_extract_run_meta(raw),
    }
