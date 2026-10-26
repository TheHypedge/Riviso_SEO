import asyncio
import xml.dom.minidom

import app.services.inner_images as ii
from app.services.inner_images import (
    _scale_only_numbers,
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


def test_validate_rejects_figure_that_drops_its_magnitude():
    # Seen live: "fines up to $2.5 million" was charted as "$2.50".
    text = "Breaches carry fines up to $2.5 million for companies."
    stat = {"type": "stat", "title": "Maximum fine", "unit": "$", "points": [{"label": "Fine", "value": 2.5, "unit": "$"}]}
    assert validate_chart(stat, text) is None
    assert validate_chart({**stat, "unit": "$ million"}, text)["points"][0]["value"] == 2.5
    # A figure that also appears without a magnitude stays chartable.
    assert validate_chart(stat, text + " Rates rose 2.5 points.") is not None
    # Indian magnitudes count too; units like "minutes" are not mistaken for "m".
    rupees = {**stat, "unit": "₹", "points": [{"label": "Cost", "value": 4, "unit": "₹"}]}
    assert validate_chart(rupees, "Costs reached ₹4 crore.") is None
    assert _scale_only_numbers("Costs reached ₹4 crore and 60 minutes.") == {4.0: "crore"}


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


def _run(mp, st, *, charts, upload=True, count=2, illus=None):
    it = iter(charts)
    illus_calls = []

    async def fake_illustrate(**kw):
        illus_calls.append(kw["heading"])
        return ("id", illus, f"alt for {kw['heading']}") if illus else (None, None, "")

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
    mp.setattr(ii, "illustrate_passage", fake_illustrate)
    proj = {"id": "p"} if illus else None
    n = asyncio.run(
        add_inner_images(st=st, user={"id": "u1"}, project_id="p", article_id="a", title="T", markdown=MD, count=count, proj=proj)
    )
    st.illus_calls = illus_calls
    return n, uploads


CHART = {"type": "stat", "title": "Adoption", "unit": "%", "points": [{"label": "Teams", "value": 41.0}]}
CHART_B = {"type": "bar", "title": "Market size", "unit": "", "points": [{"label": "2022", "value": 62.0}, {"label": "2023", "value": 74.0}]}


def test_happy_path_uploads_svg_and_links_png(monkeypatch):
    st = _St()
    assert _run(monkeypatch, st, charts=[CHART, CHART_B]) == (2, ["image/svg+xml", "image/svg+xml"])
    assert st.saved["article"].count('src="https://res.cloudinary.com/a/b.png"') == 2

    assert 'alt="Key figures: Adoption. Teams: 41%"' in st.saved["article"]


def test_no_chartable_data_skips_without_quota_or_write(monkeypatch):
    st = _St()
    assert _run(monkeypatch, st, charts=[None, None]) == (0, [])
    assert st.quota == 99 and st.saved is None


def test_quota_errors_and_upload_failures_are_non_fatal(monkeypatch):
    st = _St(quota=1)
    assert _run(monkeypatch, st, charts=[CHART, CHART_B])[0] == 1
    st = _St()
    assert _run(monkeypatch, st, charts=[RuntimeError("openai down"), CHART])[0] == 1
    st = _St()
    assert _run(monkeypatch, st, charts=[CHART, CHART], upload=False)[0] == 0 and st.saved is None


# Real bad output from the 2026-10-21 local end-to-end run (KCS mortgage article).
COMPLIANCE_TEXT = (
    "Brokers must complete a 100-point ID check, keep records for 7 years, and follow the "
    "Privacy Act 1988. Settlement takes 14 days on average versus 21 days for others."
)


def test_number_that_is_part_of_a_name_is_not_data():
    stat = {"type": "stat", "title": "Key compliance check", "unit": "", "points": [{"label": "100-point ID check", "value": 100}]}
    assert validate_chart(stat, COMPLIANCE_TEXT) is None
    top = {"type": "stat", "title": "Lenders", "unit": "", "points": [{"label": "Top 7 lenders", "value": 7}]}
    assert validate_chart(top, COMPLIANCE_TEXT) is None


def test_years_are_never_charted_and_mixed_chart_collapses():
    mixed = {
        "type": "bar",
        "title": "Key compliance requirements",
        "unit": "",
        "points": [
            {"label": "100-point ID check", "value": 100},
            {"label": "Record-keeping (years)", "value": 7},
            {"label": "Privacy Act year", "value": 1988},
        ],
    }
    # Two of three points are not data -> one point left, below the bar minimum of 2.
    assert validate_chart(mixed, COMPLIANCE_TEXT) is None


def test_real_comparable_figures_still_pass():
    bar = {"type": "bar", "title": "Average settlement time", "unit": "days", "points": [{"label": "Top brokers", "value": 14}, {"label": "Others", "value": 21}]}
    out = validate_chart(bar, COMPLIANCE_TEXT)
    assert out and [p["value"] for p in out["points"]] == [14.0, 21.0]
    pct = {"type": "stat", "title": "Approval", "unit": "%", "points": [{"label": "Approval rate", "value": 100}]}
    assert validate_chart(pct, "Approval rate hit 100% this year.") is not None


def test_same_figure_is_not_charted_twice(monkeypatch):
    st = _St()
    n, _ = _run(monkeypatch, st, charts=[CHART, CHART], count=2)
    assert n == 1 and st.quota == 98  # duplicate skipped without spending quota


def test_mixed_units_on_one_scale_are_rejected():
    # Real output: interest rates (%) and upfront fees ($) drawn as one bar chart.
    text = "Bank A 6.25% with $600 fees, Bank B 6.15% with $900 fees, Non-Bank C 6.45% with 0 fees."
    mixed = {
        "type": "bar", "title": "Mortgage product features", "unit": "",
        "points": [
            {"label": "Bank A Rate", "value": 6.25, "unit": "%"},
            {"label": "Bank B Rate", "value": 6.15, "unit": "%"},
            {"label": "Bank A Upfront Fees", "value": 600, "unit": "$"},
            {"label": "Bank B Upfront Fees", "value": 900, "unit": "$"},
        ],
    }
    assert validate_chart(mixed, text) is None
    rates = {"type": "bar", "title": "Rates", "unit": "%", "points": [
        {"label": "Bank A", "value": 6.25, "unit": "%"}, {"label": "Bank B", "value": 6.15, "unit": "percent"}]}
    assert validate_chart(rates, text) is not None  # same unit, spelled differently
    no_units = {"type": "bar", "title": "Rates", "unit": "%", "points": [{"label": "Bank A", "value": 6.25}, {"label": "Bank B", "value": 6.15}]}
    assert validate_chart(no_units, text) is not None


def test_slots_without_chartable_data_get_ai_illustrations(monkeypatch):
    # Article with no usable figures: the requested count still arrives, as illustrations.
    st = _St()
    n, uploads = _run(monkeypatch, st, charts=[None, None, None], illus="https://res.cloudinary.com/a/ill.png", count=2)
    assert n == 2 and uploads == [] and st.quota == 97
    assert st.saved["article"].count('src="https://res.cloudinary.com/a/ill.png"') == 2
    assert all("Question" not in h and "Conclusion" not in h for h in st.illus_calls)


def test_illustrations_top_up_charts_in_other_sections(monkeypatch):
    st = _St()
    n, uploads = _run(monkeypatch, st, charts=[CHART, None, None], illus="https://res.cloudinary.com/a/ill.png", count=2)
    assert n == 2 and len(uploads) == 1 and len(st.illus_calls) == 1
    assert st.saved["article"].count("<img") == 2


def test_illustration_failure_and_quota_are_non_fatal(monkeypatch):
    st = _St(quota=1)
    n, _ = _run(monkeypatch, st, charts=[None, None, None], illus="https://res.cloudinary.com/a/ill.png", count=2)
    assert n == 1  # quota allowed one


def test_illustrate_keeps_only_hosted_urls(monkeypatch):
    async def fake_gen(**kw):
        return {"image_url": "data:image/png;base64,iVBORw0KGgo="}

    async def fake_describe(**kw):
        return {"scene": "A lawyer reviewing papers", "alt": "Lawyer reviewing papers"}

    saved = []
    monkeypatch.setattr(ii, "generate_featured_image_only", fake_gen)
    monkeypatch.setattr(ii, "describe_passage", fake_describe)
    monkeypatch.setattr(ii, "save_article_media", lambda **kw: saved.append(kw["content_type"]) or ("id", None))
    _id, url, alt = asyncio.run(ii.illustrate_passage(
        proj={}, image_prompt_id=None, title="T", heading="H", passage="P", keywords=[], project_id="p", article_id="a"))
    assert url is None and saved == ["image/png"]  # Cloudinary down -> nothing inserted
    assert alt == "Lawyer reviewing papers"


def test_illustration_prompt_is_built_from_the_passage(monkeypatch):
    seen = {}

    async def fake_gen(**kw):
        seen.update(kw)
        return {"image_url": "data:image/png;base64,iVBORw0KGgo="}

    async def fake_chat(self, *, model, system, user):
        seen["chat_user"] = user
        return {"scene": "Two spouses signing a settlement at a court desk", "alt": "Couple signing settlement"}

    monkeypatch.setattr(ii, "generate_featured_image_only", fake_gen)
    monkeypatch.setattr(ii.OpenAIClient, "chat_json", fake_chat)
    monkeypatch.setattr(ii, "save_article_media", lambda **kw: ("m1", "https://res.cloudinary.com/x/m1.png"))
    res = asyncio.run(ii.illustrate_passage(
        proj={}, image_prompt_id=None, title="Mutual Divorce", heading="Settlement",
        passage="Both spouses sign the settlement deed before the family court.", keywords=["divorce"],
        project_id="p", article_id="a"))
    assert res == ("m1", "https://res.cloudinary.com/x/m1.png", "Couple signing settlement")
    assert "sign the settlement deed" in seen["chat_user"]
    assert seen["focus_keyphrase"] == "Two spouses signing a settlement at a court desk"


def test_scene_falls_back_to_heading_when_text_model_fails(monkeypatch):
    async def broken_chat(self, **kw):
        raise RuntimeError("down")

    monkeypatch.setattr(ii.OpenAIClient, "chat_json", broken_chat)
    assert asyncio.run(ii.describe_passage(title="T", heading="Fees", passage="x")) == {"scene": "Fees", "alt": "Fees"}
