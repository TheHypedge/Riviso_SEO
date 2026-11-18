"""Research pipeline: grounding, verification, citations, claim checks and every fallback path.

No network: OpenAI and page fetches are faked.
"""
import asyncio

import pytest

from app.services import article_generation as ag
from app.services import research_pipeline as rp
from app.services.article_quality import seo_aeo_geo_score
from app.services.openai_client import _parse_web_search_response

SRC = "https://indiacode.nic.in/handle/123/bnss"
SRC2 = "https://sci.gov.in/judgment/abc"


class FakeClient:
    """Stands in for OpenAIClient: plan + web search + writer + fact-check editor."""

    def __init__(self, *, search_error=None, article=None, revision=None, cited=(SRC, SRC2)):
        self.search_error, self.article, self.revision, self.cited = search_error, article, revision, cited
        self.calls = []

    async def chat_json(self, *, model, system, user):
        self.calls.append(system[:40])
        if system.startswith("You plan research"):
            return {"intent": "deadline", "core_answer": "Default bail arises after 60 or 90 days.",
                    "questions": ["What is default bail?", "When does it arise?"], "angles": ["NDPS"]}
        if system.startswith("You turn cited research notes"):
            # One fact per note; S4 doesn't exist (model inventing a note) and must be dropped.
            return {"facts": [
                {"segment": "S1", "claim": "Default bail arises if no chargesheet is filed within 90 days for offences punishable with 10 years or more.", "value": "90 days", "type": "deadline"},
                {"segment": "S2", "claim": "In Hardeep Singh v. State of Punjab the Constitution Bench set the test.", "value": "Hardeep Singh v. State of Punjab", "type": "case"},
                {"segment": "S3", "claim": "Default bail must be claimed before the chargesheet is filed.", "value": "", "type": "procedure"},
                {"segment": "S9", "claim": "Invented fact", "value": "77%"},
            ]}
        if system.startswith("You are a meticulous fact-checking editor"):
            return {"edits": self.revision} if self.revision is not None else {}
        return {"article_markdown": self.article, "meta_title": "Default bail", "meta_description": "Guide"}

    async def web_search(self, *, model, prompt, allowed_domains=None, country=None):
        if self.search_error:
            raise RuntimeError(self.search_error)
        segs = [
            {"text": "Default bail arises after 90 days for serious offences.", "url": SRC + "?utm_source=openai", "title": "BNSS, 2023"},
            {"text": "Hardeep Singh v. State of Punjab set the test.", "url": SRC2, "title": "SCI"},
            {"text": "It must be claimed before the chargesheet is filed.", "url": SRC, "title": "BNSS, 2023"},
            {"text": "Off-list blog says 5 things.", "url": "https://randomblog.com/x", "title": "blog"},
        ]
        return {"text": "notes", "citations": [], "segments": segs, "sources": [], "queries": ["default bail"],
                "domain_filter_applied": True}


@pytest.fixture
def fake_pages(monkeypatch):
    pages = {
        SRC: ("ok", rp._squash("Section 187 ... within 90 days ... chargesheet")),
        SRC2: ("ok", rp._squash("Hardeep Singh v. State of Punjab (2014) Constitution Bench")),
    }

    async def fetch(client, url):
        return pages.get(url, ("dead", ""))

    monkeypatch.setattr(rp, "_fetch_text", fetch)
    return pages


@pytest.fixture
def fake_client(monkeypatch):
    holder = {}

    def install(**kw):
        c = FakeClient(**kw)
        monkeypatch.setattr("app.services.openai_client.OpenAIClient", lambda: c)
        monkeypatch.setattr(ag, "OpenAIClient", lambda: c)
        holder["c"] = c
        return c

    return install


def _pack(fake_client, **kw):
    fake_client(**kw)
    return asyncio.run(rp.build_research_pack(title="Default bail", focus="default bail", keywords=[], profile="legal"))


def test_pack_keeps_only_grounded_allowlisted_verified_facts(fake_client, fake_pages):
    pack = _pack(fake_client)
    assert pack["status"] == "ok"
    claims = [f["claim"] for f in pack["facts"]]
    assert not any("Invented" in c for c in claims)  # extraction pointed at a note that doesn't exist
    assert all(f["source_url"] in (SRC, SRC2) for f in pack["facts"])  # utm stripped, off-list blog dropped
    assert pack["searches"][0]["off_list_dropped"] == 1
    assert [f["id"] for f in pack["facts"]] == ["F1", "F2", "F3"]
    verif = {f["value"]: f["verification"] for f in pack["facts"]}
    assert verif["90 days"] == "verified" and verif["Hardeep Singh v. State of Punjab"] == "verified"
    assert verif[""] == "cited"  # nothing checkable in it
    assert pack["core_answer"] and pack["questions"]


def test_unconfirmed_and_dead_sources_are_rejected(fake_client, fake_pages):
    fake_pages[SRC] = ("ok", rp._squash("nothing relevant here"))
    fake_pages[SRC2] = ("dead", "")
    pack = _pack(fake_client)
    assert pack["status"] == "thin"  # only the uncheckable procedure fact survives
    assert {r["reason"] for r in pack["rejected"]} == {"unconfirmed", "dead"}


def test_search_failure_returns_failed_pack_not_exception(fake_client, fake_pages):
    pack = _pack(fake_client, search_error="400 model does not support web_search")
    assert pack["status"] == "failed" and "web_search" in pack["error"]
    assert rp.format_research_for_prompt(pack) == ""


def test_no_api_key_is_a_failed_pack(monkeypatch):
    def boom():
        raise RuntimeError("OPENAI_API_KEY is not set")

    monkeypatch.setattr("app.services.openai_client.OpenAIClient", boom)
    pack = asyncio.run(rp.build_research_pack(title="x", focus="x", keywords=[], profile="general"))
    assert pack["status"] == "failed" and "OPENAI_API_KEY" in pack["error"]


def test_citations_number_sources_and_unlink_stray_links():
    pack = {"status": "ok", "facts": [
        {"id": "F1", "claim": "a", "source_url": SRC, "source_title": "BNSS"},
        {"id": "F2", "claim": "b", "source_url": SRC2, "source_title": "SCI"},
        {"id": "F3", "claim": "c", "source_url": SRC, "source_title": "BNSS"},
    ]}
    md = ("Within 90 days.[F1] Test set.[F2, F3] Bogus.[F9]\n\n"
          "See [a blog](https://randomblog.com/x) and [our page](https://site.com/p).")
    out, order = rp.apply_citations(md, pack, trusted_urls={"https://site.com/p"})
    assert order == [SRC, SRC2]
    assert f"Within 90 days.[[1]]({SRC})" in out and f"[[2]]({SRC2})[[1]]({SRC})" in out
    assert "[F9]" not in out and "a blog" in out and "randomblog.com/x)" not in out.split("## Sources")[0]
    assert "[our page](https://site.com/p)" in out
    assert out.rstrip().endswith(f"2. [SCI]({SRC2}) (sci.gov.in)")
    dup, _ = rp.apply_citations("Same source thrice.[F1][F3][F1] Next.", pack)
    assert dup.startswith(f"Same source thrice.[[1]]({SRC}) Next.")


def test_unsupported_claims_flags_unsourced_stats_and_cases():
    pack = {"status": "ok", "facts": [{"claim": "In Hardeep Singh v. State of Punjab 24.8% of matters", "value": "", "source_title": ""}]}
    md = ("Per *Hardeep Singh v. State of Punjab* and 24.8% of cases. "
          "But *Ramesh Kumar v. State of Bihar* (2019 INSC 55) and 63% and Rs 5,00,000 are invented.")
    got = rp.unsupported_claims(md, pack)
    assert "63%" in got and "Rs 5,00,000" in got and "2019 INSC 55" in got
    assert any(g.startswith("Ramesh Kumar") for g in got)
    assert not any("Hardeep" in g or g == "24.8%" for g in got)
    assert rp.unsupported_claims(md, {"status": "thin"}) == []


def test_revision_applies_only_exact_sentence_edits(fake_client):
    md = "## Heading with 63%\n\nA study found 63% of claims fail. Other text stays.\n"
    c = fake_client(revision=[
        {"original": "A study found 63% of claims fail.", "replacement": "Many claims fail."},
        {"original": "## Heading with 63%", "replacement": "## Rewritten"},  # headings are never touched
        {"original": "not in the article at all", "replacement": "x"},
    ])
    out = asyncio.run(rp.revise_unsupported(c, "m", md=md, claims=["63%"], pack={"status": "ok", "facts": []}))
    assert out == "## Heading with 63%\n\nMany claims fail. Other text stays.\n"
    c = fake_client(revision=[])
    assert asyncio.run(rp.revise_unsupported(c, "m", md=md, claims=["63%"], pack={"status": "ok", "facts": []})) is None


def test_parse_responses_api_payload():
    text = "Notes:\n- Section 187 sets a 90-day limit. ([indiacode](https://x))\n- Short."
    i = text.index("([indiacode")
    data = {"output": [
        {"type": "web_search_call", "action": {"type": "search", "query": "q1", "sources": [{"type": "url", "url": SRC}]}},
        {"type": "message", "content": [{"type": "output_text", "text": text,
                                         "annotations": [{"type": "url_citation", "url": SRC2, "title": "SCI", "start_index": i, "end_index": i + 5}]}]},
    ]}
    out = _parse_web_search_response(data)
    assert out["sources"] == [SRC] and out["queries"] == ["q1"] and out["citations"] == [{"url": SRC2, "title": "SCI"}]
    assert out["segments"] == [{"text": "Section 187 sets a 90-day limit.", "url": SRC2, "title": "SCI"}]


ARTICLE = """Default bail is a right that arises when the police miss the deadline.[F1]

# Understanding Default Bail Under the BNSS

> **Key takeaways**
> - The deadline is 90 days for serious offences.[F1]

## What is default bail?

Default bail is release because the chargesheet was late. The right is indefeasible once claimed.[F3] Courts apply it strictly. The accused must apply first.

## When does default bail arise?

It arises on day 91 for serious offences.[F1] The Constitution Bench in *Hardeep Singh v. State of Punjab* set the test.[F2] A study found 63% of claims fail.

| Offence | Period |
|---|---|
| 10 years or more | 90 days |

## Frequently Asked Questions

### Is default bail automatic?
No. The accused must apply for it before the chargesheet is filed, and the court then has no discretion to refuse it if the period has expired, as of 2026.

*This article is general information, not legal advice.*
"""


def _generate(research=True):
    return asyncio.run(ag.generate_article_bundle(
        title="Default Bail Under Section 187 BNSS", keywords=["default bail"], focus_keyphrase="default bail",
        writing_prompt_text="Write a guide.", generate_image=False, editorial_profile="legal", research=research,
    ))


def test_full_generation_with_research_cites_revises_and_scores(fake_client, fake_pages, monkeypatch):
    async def no_dead_links(md, trusted_urls=frozenset()):
        return md, []

    monkeypatch.setattr("app.services.article_quality.verify_external_links", no_dead_links)
    c = fake_client(article=ARTICLE, revision=[{"original": "A study found 63% of claims fail.", "replacement": "Most claims are decided on these facts."}])
    out = _generate()
    md, qr = out["article"], out["quality_report"]
    assert "[F" not in md and "63%" not in md
    assert f"[[1]]({SRC})" in md and "## Sources" in md
    r = qr["research"]
    assert r["status"] == "ok" and r["revised"] and r["unsupported_before"] == ["63%"] and r["unsupported_after"] == []
    assert r["sources_cited"] == [SRC, SRC2]
    score = qr["seo_aeo_geo"]
    assert 0 < score["score"] <= 100 and score["compliance_issues"] == []
    ok = {c["id"]: c["ok"] for c in score["checks"]}
    assert ok["claims"] is True and ok["faq"] is False and ok["table"] is True and ok["compliance"] is True
    assert any(s.startswith("You plan research") for s in c.calls)


def test_generation_falls_back_to_plain_when_research_fails(fake_client, fake_pages, monkeypatch):
    async def no_dead_links(md, trusted_urls=frozenset()):
        return md, []

    monkeypatch.setattr("app.services.article_quality.verify_external_links", no_dead_links)
    fake_client(article=ARTICLE.replace("[F1]", "").replace("[F2]", "").replace("[F3]", ""), search_error="timeout")
    out = _generate()
    assert out["article"] and "## Sources" not in out["article"]
    assert out["quality_report"]["research"]["status"] == "failed"
    assert "seo_aeo_geo" in out["quality_report"]


def test_generation_without_research_is_unchanged_path(fake_client, monkeypatch):
    async def no_dead_links(md, trusted_urls=frozenset()):
        return md, []

    monkeypatch.setattr("app.services.article_quality.verify_external_links", no_dead_links)
    c = fake_client(article=ARTICLE)
    out = _generate(research=False)
    assert "research" not in out["quality_report"]
    assert not any(s.startswith("You plan research") for s in c.calls)


def test_legal_compliance_checks():
    bad = "# H1\n\nThe best lawyers in Delhi guarantee bail under Section 437 CrPC.\n"
    issues = seo_aeo_geo_score(bad, profile="legal")["compliance_issues"]
    assert any("disclaimer" in i for i in issues)
    assert any("best lawyers" in i for i in issues)
    assert any("BNS/BNSS/BSA" in i for i in issues)
    assert any("guarantee" in i for i in issues)
    ok = "# H1\n\nArticle 21 guarantees personal liberty under Section 480 BNSS. This is general information, not legal advice.\n"
    assert seo_aeo_geo_score(ok, profile="legal")["compliance_issues"] == []


def test_research_enabled_flag_and_country(monkeypatch):
    monkeypatch.setattr(rp.settings, "research_pipeline_enabled", False)
    assert rp.research_enabled({}) is False
    assert rp.research_enabled({"research_enabled": True}) is True
    monkeypatch.setattr(rp.settings, "research_pipeline_enabled", True)
    assert rp.research_enabled({"research_enabled": False}) is False
    assert rp.project_country({"target_countries": ["in"]}) == "IN"
    assert rp.project_country({"target_countries": ["IN", "US"]}) is None


def test_single_h1_demotes_extra_h1s():
    md = "Intro\n\n# Main\n\n### Sub\n\n# Second\n\n## Already h2\n"
    assert ag._single_h1(md) == "Intro\n\n# Main\n\n### Sub\n\n## Second\n\n## Already h2"
