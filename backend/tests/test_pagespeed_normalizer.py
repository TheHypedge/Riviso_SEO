"""Technical Audit, Phase 1: PSI normalizer (SEO findings, dedupe, samples, field fallback,
Fix first). Uses a fixture shaped like a real PSI v5 response -- no network."""

import asyncio
import copy
import json
from pathlib import Path

import pytest

from app.services import pagespeed_client as psi
from app.services.url_guard import SsrfError

_FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "psi_mobile_sample.json").read_text())


def _raw():
    return copy.deepcopy(_FIXTURE)


def _ids(rows):
    return [r["id"] for r in rows]


def test_seo_failures_and_summary_extracted():
    out = psi.normalize_pagespeed_result(_raw())
    assert _ids(out["seo_failures"]) == ["meta-description", "link-text"]
    assert out["seo_summary"] == {"passed": 1, "warnings": 0, "failed": 2}


def test_each_audit_listed_in_exactly_one_section():
    out = psi.normalize_pagespeed_result(_raw())
    sections = ["opportunities", "diagnostics", "accessibility_failures", "best_practices_failures", "seo_failures"]
    seen = [i for s in sections for i in _ids(out[s])]
    assert len(seen) == len(set(seen))
    # SEO / best-practice audits no longer leak into diagnostics unlabeled.
    assert set(_ids(out["diagnostics"])) == {"bootup-time", "dom-size"}
    # Metric audits (incl. Lighthouse-hidden ones like "interactive") are not findings.
    assert "interactive" not in seen and "largest-contentful-paint" not in seen
    # image-alt is referenced by accessibility AND best-practices: first category wins.
    assert "image-alt" in _ids(out["accessibility_failures"])
    assert _ids(out["best_practices_failures"]) == ["errors-in-console"]
    assert out["best_practices_summary"] == {"passed": 0, "warnings": 0, "failed": 1}


def test_samples_capped_and_truncated():
    raw = _raw()
    raw["lighthouseResult"]["audits"]["image-alt"]["details"]["items"][0]["node"]["nodeLabel"] = "x" * 500
    out = psi.normalize_pagespeed_result(raw)

    unused = next(o for o in out["opportunities"] if o["id"] == "unused-javascript")
    assert unused["item_count"] == 7 and unused["affected_resources"] == 7
    assert len(unused["samples"]) == psi._MAX_SAMPLES
    assert unused["samples"][0] == {"url": "https://cdn.example.com/a.js", "wasted_bytes": 61440.0}

    alt = out["accessibility_failures"][0]["samples"][0]
    assert len(alt["label"]) == psi._MAX_SAMPLE_STR
    assert "base64" not in alt["snippet"] and "data:…" in alt["snippet"]
    assert alt["selector"] == "body > img"

    # `source.url` and Lighthouse's nested `list` details both yield samples.
    assert out["best_practices_failures"][0]["samples"] == [{"url": "https://example.com/app.js"}]
    dom = next(d for d in out["diagnostics"] if d["id"] == "dom-size")
    assert dom["item_count"] == 1 and dom["samples"][0]["selector"] == "div.wrap"

    # The stored document stays small: no raw Lighthouse `details` anywhere.
    assert "details" not in json.dumps(out)


def test_field_data_falls_back_to_origin_and_never_mixes_with_lab():
    out = psi.normalize_pagespeed_result(_raw())
    assert out["field_data_source"] == "field_origin"
    assert out["field"]["scope"] == "origin"
    assert out["field"]["metrics"]["lcp"]["status"] == "needs_improvement"
    assert out["field"]["metrics"]["lcp"]["percentile"] == 3100.0
    # Lab entry keeps the lab value AND the lab status (score 0.3 -> poor): one source per value.
    assert out["core_web_vitals"]["lcp"] == {
        "display_value": "4.1 s", "numeric_value": 4100, "score": 0.3, "status": "poor", "source": "lab",
    }

    raw = _raw()
    raw["loadingExperience"]["metrics"] = {"LARGEST_CONTENTFUL_PAINT_MS": {"category": "FAST"}}
    out = psi.normalize_pagespeed_result(raw)
    assert out["field_data_source"] == "field" and out["field"]["scope"] == "url"
    assert set(out["field"]["metrics"]) == {"lcp"}  # URL scope only, origin never merged in

    raw = _raw()
    raw["originLoadingExperience"] = {}
    out = psi.normalize_pagespeed_result(raw)
    assert out["field_data_source"] is None and out["field"] is None


def test_lighthouse13_insights_are_opportunities_with_metric_savings():
    out = psi.normalize_pagespeed_result(_raw())
    cache = next(o for o in out["opportunities"] if o["id"] == "cache-insight")
    assert cache["metric_savings"] == {"LCP": 2500.0}  # zero-valued metrics dropped
    assert cache["overall_savings_ms"] is None  # never invented from metricSavings
    bootup = next(d for d in out["diagnostics"] if d["id"] == "bootup-time")
    assert bootup["metric_savings"] == {"TBT": 350.0}


def test_fix_first_ranked_by_google_savings_then_score():
    out = psi.normalize_pagespeed_result(_raw())
    top = out["fix_first"]
    assert len(top) == 5
    # LCP 2500 ms (metricSavings) > 900 ms > 450 ms > TBT 350 ms; then lowest score.
    assert [t["id"] for t in top[:4]] == ["cache-insight", "render-blocking-resources", "unused-javascript", "bootup-time"]
    assert top[4]["score"] == 0
    assert top[0]["metric_savings"] == {"LCP": 2500.0}
    rb = top[1]
    assert rb["section"] == "opportunities"
    assert rb["sample"] == {"url": "https://example.com/style.css", "wasted_ms": 600.0}
    assert rb["item_count"] == 2


def test_empty_response_normalizes_without_crashing():
    out = psi.normalize_pagespeed_result({})
    assert out["seo_failures"] == [] and out["fix_first"] == [] and out["field_data_source"] is None


def test_fetch_rejects_non_public_url(monkeypatch):
    monkeypatch.setattr(psi.settings, "google_pagespeed_api_key", "test-key", raising=False)
    with pytest.raises(SsrfError):
        asyncio.run(psi.fetch_pagespeed_result(url="http://127.0.0.1/", strategy="mobile"))
