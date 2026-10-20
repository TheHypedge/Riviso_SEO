"""Technical Audit v2: normalizer against REAL PageSpeed v5 responses (Lighthouse 13.5,
captured 2026-10-20, trimmed; see backend/tests/fixtures/psi/)."""

import base64
import collections
import json
from pathlib import Path

import pytest

from app.services import pagespeed_client as psi

FIX = Path(__file__).parent / "fixtures" / "psi"


def _load(name):
    return json.loads((FIX / f"{name}.json").read_text())


@pytest.fixture(params=["mobile", "desktop", "error_page_502_mobile"])
def raw(request):
    return _load(request.param)


def _strings(o):
    if isinstance(o, dict):
        for v in o.values():
            yield from _strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from _strings(v)
    elif isinstance(o, str):
        yield o


def test_no_base64_or_data_uris_in_output(raw):
    out = psi.normalize_pagespeed_result(raw)
    assert not [s for s in _strings(out) if s.startswith("data:") and "base64" in s]
    assert len(json.dumps(out)) < 150_000  # summary budget per strategy


def test_audits_index_counts_match_lighthouse(raw):
    """Every non-metric audit appears exactly once, and its kind matches Lighthouse's own
    scoreDisplayMode + score, per category."""
    lh = raw["lighthouseResult"]
    out = psi.normalize_pagespeed_result(raw)
    index = out["audits_index"]
    ids = [a["id"] for a in index]
    assert len(ids) == len(set(ids))
    expected = set()
    for cat in lh["categories"].values():
        expected |= {r["id"] for r in cat["auditRefs"] if r.get("group") not in ("metrics", "hidden")}
    assert set(ids) == expected
    for a in index:
        assert a["kind"] == psi.classify_audit(lh["audits"][a["id"]])
    # document-title / image-alt are in Accessibility and SEO; Accessibility owns them.
    owners = {a["id"]: a["category"] for a in index}
    assert owners.get("image-alt") == "accessibility" and owners.get("document-title") == "accessibility"


def test_summary_counts_agree_with_index():
    raw = _load("mobile")
    out = psi.normalize_pagespeed_result(raw)
    c = collections.Counter((a["category"], a["kind"]) for a in out["audits_index"])
    assert out["accessibility_summary"]["failed"] == c[("accessibility", "failed")] == 3
    assert out["seo_summary"]["failed"] == c[("seo", "failed")] == 2


def test_lab_values_and_status_share_one_source():
    out = psi.normalize_pagespeed_result(_load("mobile"))
    lcp = out["core_web_vitals"]["lcp"]
    assert lcp["source"] == "lab" and lcp["status"] == "poor"  # 17 s lab LCP is never "Good"
    assert out["field"]["metrics"]["lcp"]["status"] == "good"  # real users: separately labelled
    assert "inp" not in out["core_web_vitals"]  # INP is never measured in a lab run
    assert out["field"]["metrics"]["inp"]["percentile"] is not None


def test_ttfb_is_a_value_not_a_sentence():
    ttfb = psi.normalize_pagespeed_result(_load("mobile"))["core_web_vitals"]["ttfb"]
    assert ttfb["display_value"] == f"{round(ttfb['numeric_value'])} ms"


def test_field_cls_is_unscaled_from_crux():
    field = psi.normalize_pagespeed_result(_load("mobile"))["field"]
    cls = field["metrics"]["cls"]
    assert cls["percentile"] == 0.01  # CrUX reports 1 (= 0.01 x 100)
    assert [d["max"] for d in cls["distributions"]] == [0.1, 0.25, None]
    assert abs(sum(d["proportion"] for d in cls["distributions"]) - 1) < 0.01
    assert field["metrics"]["ttfb"]["percentile"] is not None  # EXPERIMENTAL_TIME_TO_FIRST_BYTE


def test_run_warnings_are_kept_for_an_error_page():
    out = psi.normalize_pagespeed_result(_load("error_page_502_mobile"))
    assert out["scores"]["performance"] == 100
    assert any("502" in w for w in out["run_warnings"])
    assert out["lighthouse_version"] == "13.5.0" and out["form_factor"] == "mobile"
    assert out["field"] is None


def test_screenshot_guard_accepts_only_real_images():
    jpeg = b"\xff\xd8\xff\xe0" + b"0" * 100
    ok = {"lighthouseResult": {"audits": {"final-screenshot": {"details": {"data": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()}}}}}
    assert psi.extract_final_screenshot(ok) == jpeg
    fake = {"lighthouseResult": {"audits": {"final-screenshot": {"details": {"data": "data:image/jpeg;base64," + base64.b64encode(b"<svg/>").decode()}}}}}
    assert psi.extract_final_screenshot(fake) is None
    html = {"lighthouseResult": {"audits": {"final-screenshot": {"details": {"data": "data:text/html;base64,PGgxPg=="}}}}}
    assert psi.extract_final_screenshot(html) is None
    big = {"lighthouseResult": {"audits": {"final-screenshot": {"details": {"data": "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * (3 * 1024 * 1024)).decode()}}}}}
    assert psi.extract_final_screenshot(big) is None
    assert psi.extract_final_screenshot({}) is None
    assert psi.extract_final_screenshot(_load("mobile")) is None  # fixture image was removed


def test_old_shape_input_still_normalizes():
    out = psi.normalize_pagespeed_result({})
    assert out["audits_index"] == [] and out["field"] is None and out["run_warnings"] == []
