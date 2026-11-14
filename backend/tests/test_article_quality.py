"""Article quality pass: bullet-first sections are flagged, dead outbound links are unlinked,
and the Claude provider returns the same three-key JSON the OpenAI path does."""

import asyncio
import os
from types import SimpleNamespace

os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")

import httpx

import app.services.article_quality as aq

BULLET_FIRST = """Intro line here. It sets the scene.

## Why Credit Scores Matter
Short line.
- Loans
- Cards
- Rent
- Jobs

## How To Improve It
- Pay on time
- Lower usage
"""

GOOD = """Most people check their credit score only when a loan gets rejected. That is late.

## Why Credit Scores Matter
Lenders use your score to price risk. A higher score means a lower interest rate on almost every loan you take. Over a 20-year home loan, a few points can change what you pay by lakhs. Check early.

- Banks read it before approving a home or car loan, and it sets your rate.
- Card issuers use it to decide your limit and whether you get a premium card.
- Some landlords check it before renting out a flat in big cities.

Of these, the loan rate matters most, so start there.

## How To Improve It
Pay on time. Paying every single bill by its due date, including small ones like a phone bill linked to a card, is the biggest factor in the score by a wide margin. Keeping card usage under 30% of your limit is next. Both take months to show up, so patience matters more than tricks. Avoid opening many new accounts at once.
"""


def test_bullet_first_sections_are_flagged():
    rep = aq.structure_report(BULLET_FIRST)
    assert rep["thin_lead_sections"] == ["Why Credit Scores Matter", "How To Improve It"]
    assert rep["sections_opening_with_list"] == ["How To Improve It"]
    assert rep["list_word_ratio"] > 0.3 and rep["passed"] is False


def test_prose_led_sections_pass_the_anatomy_check():
    rep = aq.structure_report(GOOD)
    assert rep["thin_lead_sections"] == [] and rep["sections_opening_with_list"] == []
    assert rep["list_word_ratio"] <= 0.30
    assert rep["sentence_length_stdev"] >= 5 and rep["passed"] is True


def test_banned_phrases_fail_the_report():
    rep = aq.structure_report(GOOD + "\nLet's delve into it.")
    assert rep["banned_phrases_found"] == ["delve"] and rep["passed"] is False


def test_dead_links_are_unlinked_and_anchor_text_kept(monkeypatch):
    async def fake_dead(_client, url):
        return "made-up" in url

    monkeypatch.setattr(aq, "_link_is_dead", fake_dead)
    md = (
        "See [RBI guidelines](https://www.rbi.org.in/) and [a fake report](https://made-up.example/x). "
        "Also [our guide](https://site.com/guide/)."
    )
    out, removed = asyncio.run(aq.verify_external_links(md, trusted_urls={"https://site.com/guide/"}))
    assert removed == ["https://made-up.example/x"]
    assert "[RBI guidelines](https://www.rbi.org.in/)" in out and "a fake report" in out
    assert "made-up.example" not in out and "[our guide](https://site.com/guide/)" in out


def test_only_not_found_or_missing_host_counts_as_dead(monkeypatch):
    monkeypatch.setattr(aq, "assert_public_http_url", lambda _u: None)
    codes = {"/gone": 404, "/blocked": 403, "/ok": 200, "/nohead": 405}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "nohost.example":
            raise httpx.ConnectError("dns")
        code = codes[req.url.path]
        if req.url.path == "/nohead" and req.method == "GET":
            code = 200
        return httpx.Response(code)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return [await aq._link_is_dead(c, f"https://a.example{p}") for p in ("/gone", "/blocked", "/ok", "/nohead")] + [
                await aq._link_is_dead(c, "https://nohost.example/")
            ]

    assert asyncio.run(run()) == [True, False, False, False, True]


class _Stream:
    def __init__(self, msg):
        self.msg = msg

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get_final_message(self):
        return self.msg


def _claude(monkeypatch, msg):
    from app.services import anthropic_client as ac

    monkeypatch.setattr(ac.settings, "anthropic_api_key", "test-key")
    client = ac.AnthropicClient()
    calls = []

    def stream(**kw):
        calls.append(kw)
        return _Stream(msg)

    client._client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=stream)))
    return client, calls


def test_claude_client_returns_article_json(monkeypatch):
    import pytest

    text = '{"article_markdown": "Body", "meta_title": "T", "meta_description": "D"}'
    msg = SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=text)])
    client, calls = _claude(monkeypatch, msg)
    out = asyncio.run(client.chat_json(model="claude-opus-5-5", system="s", user="u"))
    assert out["article_markdown"] == "Body"
    assert calls[0]["output_config"]["format"]["type"] == "json_schema" and calls[0]["fallbacks"] == "default"

    refused, _ = _claude(monkeypatch, SimpleNamespace(stop_reason="refusal", content=[]))
    with pytest.raises(RuntimeError):
        asyncio.run(refused.chat_json(model="claude-opus-5-5", system="s", user="u"))


def test_prompt_no_longer_tells_the_model_to_break_text_into_bullets():
    from app.services.article_generation import build_generation_messages

    sys, _ = build_generation_messages(title="T", keywords=["k"], focus_keyphrase="k", writing_prompt_text="Write.")
    assert "broken into bullets" not in sys and "Break longer content into bullets" not in sys
    assert "explanatory lead paragraph of 3-5 sentences" in sys
    assert "authoritative external sources" in sys


def test_same_source_linked_twice_keeps_only_the_first(monkeypatch):
    async def never_dead(_c, _u):
        return False

    monkeypatch.setattr(aq, "_link_is_dead", never_dead)
    md = "[CIBIL](https://www.cibil.com/) then again [the bureau](https://www.cibil.com/)."
    out, _ = asyncio.run(aq.verify_external_links(md))
    assert out == "[CIBIL](https://www.cibil.com/) then again the bureau."
