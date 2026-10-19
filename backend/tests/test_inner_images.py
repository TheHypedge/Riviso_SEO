import asyncio
import xml.dom.minidom

import app.services.inner_images as ii
from app.services.inner_images import (
    add_inner_images,
    candidate_sections,
    chart_alt,
    fmt_value,
    insert_images,
    render_chart_svg,
    validate_chart,
)

MD = """Intro with 2024 figures that must never get a chart.

## Market Size
The market grew from 62 in 2022 to 74 in 2023 and 89 in 2024.

More detail.

## Why It Matters
### A sub heading
No figures here at all.

## Adoption
About 41% of teams use it, up from 28%.

## Frequently Asked Questions
### How big is it?
It is 89 billion.

## Conclusion
Grew 89 percent."""


def test_only_data_sections_outside_faq_and_conclusion():
    assert [h for _, h, _ in candidate_sections(MD, 5)] == ["Market Size", "Adoption"]
    assert candidate_sections(MD, 0) == []
    assert candidate_sections("Intro 42.\n\n## A\nNo numbers.", 3) == []


def test_slot_lands_after_first_paragraph():
    lines = MD.split("\n")
    idx = {h: i for i, h, _ in candidate_sections(MD, 2)}
    assert lines[idx["Market Size"] - 1].startswith("The market grew")


def test_validate_rejects_any_number_not_in_text():
    text = "The market grew from 62 in 2022 to 74 in 2023 and 1,200 in 2024."
    ok = {"type": "line", "title": "Market size", "unit": "USD bn",
          "points": [{"label": "2022", "value": 62}, {"label": "2023", "value": 74}, {"label": "2024", "value": 1200}]}
    assert validate_chart(ok, text)["points"][2]["value"] == 1200.0
    bad = {**ok, "points": ok["points"][:2] + [{"label": "2025", "value": 95}]}
    assert validate_chart(bad, text) is None


def test_validate_rejects_bad_shapes():
    text = "Values 1 2 3"
    assert validate_chart(None, text) is None
    assert validate_chart({"type": "pie", "title": "x", "points": []}, text) is None
    assert validate_chart({"type": "line", "title": "x", "points": [{"label": "a", "value": 1}, {"label": "b", "value": 2}]}, text) is None
    assert validate_chart({"type": "bar", "title": "", "points": [{"label": "a", "value": 1}, {"label": "b", "value": 2}]}, text) is None


def test_render_is_valid_svg_for_every_type_and_escapes():
    pts = [{"label": "A & <B>", "value": 41.0}, {"label": "C", "value": 28.0}, {"label": "D", "value": 3.0}]
    for kind, p in (("bar", pts), ("line", pts), ("stat", pts[:2])):
        svg = render_chart_svg({"type": kind, "title": 'Share "of" teams', "unit": "%", "points": p}, "Adoption")
        xml.dom.minidom.parseString(svg)  # raises on malformed SVG
        assert b"41%" in svg and "From this article: \u201cAdoption\u201d".encode() in svg


def test_fmt_and_alt():
    assert fmt_value(1200.0, "$") == "$1,200"
    assert fmt_value(0.1, "$") == "$0.10"
    assert fmt_value(41.5, "%") == "41.5%"
    assert fmt_value(62.0, "USD bn") == "62 USD bn"
    alt = chart_alt({"type": "bar", "title": "Spend", "unit": "%", "points": [{"label": "A", "value": 41.0}]})
    assert alt == "Bar chart: Spend. A: 41%"


def test_insert_keeps_original_text():
    out = insert_images(MD, [(i, "https://res.cloudinary.com/x.png", h) for i, h, _ in candidate_sections(MD, 2)])
    assert out.count("<img ") == 2
    assert [ln for ln in out.split("\n") if ln.strip() and not ln.startswith("<img ")] == [ln for ln in MD.split("\n") if ln.strip()]


class _St:
    def __init__(self, quota=99):
        self.quota, self.saved = quota, None

    def load_plans(self):
        return {}

    def consume_inner_image_usage(self, uid, *, month_limit):
        self.quota -= 1
        return (self.quota >= 0, "limit")

    def patch_article_fields(self, aid, updates):
        self.saved = updates


def _run(mp, st, *, charts, upload=True, count=2):
    it = iter(charts)

    async def fake_extract(title, heading, text):
        c = next(it)
        if isinstance(c, Exception):
            raise c
        return c

    uploads = []

    def fake_save(**kw):
        uploads.append(kw["content_type"])
        return ("id", "https://res.cloudinary.com/a/b.svg" if upload else None)

    mp.setattr(ii, "_extract_chart", fake_extract)
    mp.setattr(ii, "save_article_media", fake_save)
    n = asyncio.run(add_inner_images(st=st, user={"id": "u1"}, project_id="p", article_id="a", title="T", markdown=MD, count=count))
    return n, uploads


CHART = {"type": "stat", "title": "Adoption", "unit": "%", "points": [{"label": "Teams", "value": 41.0}]}


def test_happy_path_uploads_svg_and_links_png(monkeypatch):
    st = _St()
    assert _run(monkeypatch, st, charts=[CHART, CHART]) == (2, ["image/svg+xml", "image/svg+xml"])
    assert st.saved["article"].count('src="https://res.cloudinary.com/a/b.png"') == 2
    assert 'alt="Key figures: Adoption. Teams: 41%"' in st.saved["article"]


def test_no_chartable_data_skips_without_quota_or_write(monkeypatch):
    st = _St()
    assert _run(monkeypatch, st, charts=[None, None]) == (0, [])
    assert st.quota == 99 and st.saved is None


def test_quota_errors_and_upload_failures_are_non_fatal(monkeypatch):
    st = _St(quota=1)
    assert _run(monkeypatch, st, charts=[CHART, CHART])[0] == 1
    st = _St()
    assert _run(monkeypatch, st, charts=[RuntimeError("openai down"), CHART])[0] == 1
    st = _St()
    assert _run(monkeypatch, st, charts=[CHART, CHART], upload=False)[0] == 0 and st.saved is None
