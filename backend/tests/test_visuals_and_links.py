"""In-article visual mix + crop height, and outbound-link authority / internal-link selection."""
import asyncio

from app.services import inner_images as ii
from app.services import inner_visuals as iv
from app.services import wordpress_content_pipeline as wcp
from app.services.article_quality import seo_aeo_geo_score, verify_external_links
from app.services.source_authority import LOW, OFFICIAL, REPUTABLE, UNKNOWN, authority_tier

STEPS = "Intro line.\n\n1. **Count the days:** From the first remand.\n2. **Check the chargesheet:** Ask the court.\n3. **Apply:** On day 61.\n"
TABLE = "| Point | A | B |\n| --- | --- | --- |\n| Basis | Merits | Deadline |\n| Discretion | Wide | None |\n"
TIMELINE = "- In 1973 the CrPC set the limit.\n- On 1 July 2024 the BNSS replaced the CrPC.\n- In March 2021 the court ruled on it.\n"


# ---------------------------------------------------------------- diagram extraction

def test_extractors_find_real_structure_only():
    steps = iv.steps_in(STEPS)
    assert [s["title"] for s in steps] == ["Count the days", "Check the chargesheet", "Apply"]
    assert iv.steps_in("1. one\n2. two\n") is None  # needs 3+ steps
    t = iv.table_in(TABLE)
    assert t["header"] == ["Point", "A", "B"] and t["rows"][1] == ["Discretion", "Wide", "None"]
    assert iv.table_in("| a | b |\n| c | d |") is None  # no separator row = not a table
    tl = iv.timeline_in(TIMELINE)
    assert [e["label"] for e in tl] == ["1973", "March 2021", "1 July 2024"]  # chronological
    assert iv.timeline_in("In 2024 a thing. In 2024 again.") is None


def test_options_and_variety_order():
    opts = iv.section_options(STEPS + TABLE, has_numbers=True, allow_illustration=True)
    assert opts == ["comparison", "process", "chart", "illustration"]
    assert iv.section_options("Plain prose.", has_numbers=False, allow_illustration=False) == []
    # least-used kind first, ties by preference
    assert iv.order_for_variety(["chart", "illustration"], {"chart": 1}) == ["illustration", "chart"]
    assert iv.order_for_variety(["process", "chart"], {}) == ["process", "chart"]


def test_diagrams_render_valid_svg_with_escaped_text():
    svg, alt = iv.render_visual("comparison", iv.table_in(TABLE.replace("Merits", 'Merits & "risk" <b>x</b>')), "A vs B", "A vs B")
    body = svg.decode()
    assert body.startswith("<svg") and body.endswith("</svg>") and 'Merits &amp; &quot;risk&quot; x' in body and "<b>" not in body
    assert alt.startswith("Comparison table: A vs B")
    for kind, text in (("process", STEPS), ("timeline", TIMELINE)):
        svg, alt = iv.render_visual(kind, iv.extract(kind, text), "Title", "Title")
        assert svg.startswith(b"<svg") and alt


# ---------------------------------------------------------------- planner + crop

MD = (
    "Intro.\n\n# Title\n\n"
    "## How to apply\n\nSteps follow.\n\n" + STEPS + "\n"
    "## Regular vs default\n\nCompare them.\n\n" + TABLE + "\n"
    "## Market size\n\nThe market grew from 62 to 74 percent.\n\n"
    "## Why it matters\n\nA story about people and courts.\n"
)


class _St:
    def load_plans(self):
        return {}

    def consume_inner_image_usage(self, uid, *, month_limit):
        return True, ""


def _build(monkeypatch, count, proj):
    async def chart(title, heading, text):
        return {"type": "bar", "title": "Size", "unit": "%", "points": [{"label": "A", "value": 62.0}, {"label": "B", "value": 74.0}]}

    async def illus(**kw):
        return ("id", "https://res.cloudinary.com/x/art.png", "alt art")

    monkeypatch.setattr(ii, "_extract_chart", chart)
    monkeypatch.setattr(ii, "illustrate_passage", illus)
    monkeypatch.setattr(ii, "save_article_media", lambda **kw: ("id", f"https://res.cloudinary.com/x/{len(kw['data'])}.svg"))
    return asyncio.run(ii.build_inner_images(st=_St(), user={"id": "u", "role": "admin"}, project_id="p", article_id="a",
                                             title="T", markdown=MD, count=count, proj=proj))


def test_four_images_mix_diagrams_chart_and_art_with_crop(monkeypatch):
    out, n = _build(monkeypatch, 4, {"id": "p"})
    assert n == 4
    assert "Process: How to apply" in out and "Comparison table: Regular vs default" in out
    assert "Bar chart: Size" in out and "alt art" in out  # one of each, not four of a kind
    art = next(ln for ln in out.splitlines() if "art.png" in ln)
    assert 'style="width:100%;height:420px;object-fit:cover;object-position:50% 50%;"' in art  # app default
    assert all("style=" not in ln for ln in out.splitlines() if ln.startswith("<img") and "art.png" not in ln)  # diagrams never cropped


def test_project_height_setting_and_original_size(monkeypatch):
    out, _ = _build(monkeypatch, 4, {"id": "p", "inner_image_max_height": 360})
    assert "height:360px" in out
    out, _ = _build(monkeypatch, 4, {"id": "p", "inner_image_max_height": 0})
    assert "object-fit" not in out
    assert ii.illustration_style(0) == "" and ii.illustration_style(None) == ""


# ---------------------------------------------------------------- outbound authority

def test_authority_tiers():
    assert authority_tier("https://www.indiacode.nic.in/handle/1") == OFFICIAL
    assert authority_tier("https://www.gov.uk/x") == OFFICIAL  # bare government apex domain
    assert authority_tier("https://www.mit.edu/x") == OFFICIAL and authority_tier("https://ox.ac.uk/x") == OFFICIAL
    assert authority_tier("https://notgov.com") == UNKNOWN
    assert authority_tier("https://data.gov.in/x") == OFFICIAL
    assert authority_tier("https://pubmed.ncbi.nlm.nih.gov/123") == OFFICIAL  # .gov wins
    assert authority_tier("https://www.reuters.com/a") == REPUTABLE
    assert authority_tier("https://some-site.example/x", trusted=["some-site.example"]) == REPUTABLE
    assert authority_tier("https://myshop.com/blog") == UNKNOWN
    for low in ("https://foo.blogspot.com/p", "https://medium.com/@a/b", "https://www.quora.com/q", "https://bit.ly/x", "https://x.wordpress.com/y"):
        assert authority_tier(low) == LOW, low
    assert authority_tier("https://survey.com") == UNKNOWN  # "ey.com" must not match by suffix


def test_low_authority_links_are_unlinked(monkeypatch):
    async def never_dead(client, url):
        return False

    monkeypatch.setattr("app.services.article_quality._link_is_dead", never_dead)
    md = "See [the RBI rule](https://rbi.org.in/x) and [a blog](https://tips.blogspot.com/p)."
    out, removed = asyncio.run(verify_external_links(md))
    assert "[the RBI rule](https://rbi.org.in/x)" in out and "a blog" in out and "blogspot" not in out
    assert removed == ["https://tips.blogspot.com/p"]


def test_score_rewards_authoritative_outbound_links():
    good = "# T\n\n[a](https://rbi.org.in/a) [b](https://www.reuters.com/b) [c](https://indiacode.nic.in/c)\n"
    bad = good + "[d](https://medium.com/d)\n"
    ok = lambda md: {c["id"]: c["ok"] for c in seo_aeo_geo_score(md)["checks"]}["authority"]
    assert ok(good) is True and ok(bad) is False and ok("# T\n\nno links") is False


# ---------------------------------------------------------------- internal links

def test_internal_link_selection(monkeypatch):
    rows = [{"post_title": t, "post_url": f"https://site.com/{i}/"} for i, t in enumerate([
        "Default bail under BNSS",  # the article itself (same title) -> excluded
        "Regular bail explained", "Anticipatory bail guide", "Bail bond forms", "Bail in NDPS cases",
        "Cheque bounce law", "Bail and default bail FAQs", "Divorce process",
    ])]

    class St:
        def load_site_map_for_project(self, pid, limit=5000):
            return rows

    monkeypatch.setattr("app.legacy.storage.get_legacy_storage_module", lambda: St())
    pages = wcp._catalog_fallback_pages(proj={"id": "p"}, title="Default bail under BNSS", keywords=["bail"],
                                        focus_keyphrase="default bail", max_pages=wcp.AUTO_INTERNAL_LINKS)
    titles = [p.title for p in pages]
    assert "Default bail under BNSS" not in titles and len(titles) == 5
    assert titles[0] == "Bail and default bail FAQs"  # exact focus phrase ranks first
    assert "Divorce process" not in titles
