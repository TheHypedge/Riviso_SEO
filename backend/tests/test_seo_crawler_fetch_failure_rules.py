"""T1: failed fetches, redirect loops and robots-blocked linked pages become issues.

Network paths use httpx.MockTransport (no real requests); a public IP literal keeps
url_guard's DNS check offline."""

import asyncio

import httpx
import pytest

from app.services.seo_crawler import issues as issues_mod
from app.services.seo_crawler.fetcher import fetch_url
from app.services.seo_crawler.rules import RULE_ENGINE_VERSION, RULES

PUBLIC_URL = "http://93.184.216.34/page"


def _url(**over):
    doc = {
        "id": "u1", "url": PUBLIC_URL, "normalized_url": PUBLIC_URL, "discovered_from": "http://93.184.216.34/",
        "status_code": None, "status_text": None, "indexability": "unknown", "indexability_reason": None,
        "inlink_count": 0, "redirect_hop_count": 0,
    }
    doc.update(over)
    return doc


def _rule_ids(urls):
    return [i["rule_id"] for i in issues_mod.evaluate("a1", urls, [])]


def _fetch(handler, *, max_redirects=8):
    async def run():
        # Same redirect settings as fetcher.build_http_client.
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True, max_redirects=max_redirects) as client:
            return await fetch_url(client, PUBLIC_URL)

    return asyncio.run(run())


# --- classify_fetch_error -------------------------------------------------------------

@pytest.mark.parametrize(
    "text, expected",
    [
        ("timeout", "timeout"),
        ("request_failed: TooManyRedirects", "redirect_loop"),
        ("request_failed: ConnectError", "connection"),
        ("request_failed: RemoteProtocolError", "connection"),
        ("blocked: Refusing to fetch non-public URL (private)", "ssrf_blocked"),
        ("blocked_redirect: Refusing to fetch non-public URL (loopback)", "ssrf_blocked"),
        ("OK", None),
        ("", None),
        (None, None),
    ],
)
def test_classify_fetch_error(text, expected):
    assert issues_mod.classify_fetch_error(text) == expected


# --- the fetcher really produces those strings -----------------------------------------

def test_fetcher_timeout_is_classified():
    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)

    r = _fetch(handler)
    assert r.error == "timeout" and issues_mod.classify_fetch_error(r.error) == "timeout"


def test_fetcher_refused_connection_is_classified():
    def handler(request):
        raise httpx.ConnectError("Connection refused", request=request)

    r = _fetch(handler)
    assert r.error == "request_failed: ConnectError"
    assert issues_mod.classify_fetch_error(r.error) == "connection"


def test_fetcher_redirect_loop_is_classified():
    def handler(request):
        return httpx.Response(301, headers={"location": PUBLIC_URL})

    r = _fetch(handler)
    assert r.error == "request_failed: TooManyRedirects"
    assert issues_mod.classify_fetch_error(r.error) == "redirect_loop"


def test_fetcher_ssrf_block_is_not_a_site_issue():
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200))) as client:
            return await fetch_url(client, "http://127.0.0.1/admin")

    r = asyncio.run(run())
    assert issues_mod.classify_fetch_error(r.error) == "ssrf_blocked"
    assert _rule_ids([_url(status_text=r.error)]) == []


# --- rules fire with evidence ---------------------------------------------------------

@pytest.mark.parametrize(
    "error, rule_id",
    [
        ("timeout", "crawl_timeout"),
        ("request_failed: ConnectError", "crawl_connection_error"),
        ("request_failed: TooManyRedirects", "redirect_loop"),
    ],
)
def test_fetch_failure_rules_fire_with_evidence(error, rule_id):
    found = issues_mod.evaluate("a1", [_url(status_text=error, indexability_reason=error)], [])
    assert [i["rule_id"] for i in found] == [rule_id]
    iss = found[0]
    assert iss["evidence"] == {"error": error, "discovered_from": "http://93.184.216.34/"}
    assert iss["rule_version"] == RULE_ENGINE_VERSION
    meta = RULES[rule_id]
    assert (iss["category"], iss["severity"], iss["priority"], iss["effort"]) == (meta.category, meta.severity, meta.priority, meta.effort)


def test_fetch_failure_rules_do_not_fire_for_fetched_pages():
    ok = _url(status_code=200, status_text="OK", indexability="indexable", title="A title that is long enough",
              meta_description="d", h1="h", canonical=PUBLIC_URL)
    assert not {"crawl_timeout", "crawl_connection_error", "redirect_loop"} & set(_rule_ids([ok]))


def test_blocked_by_robots_linked_fires_only_with_inlinks():
    blocked = dict(indexability="blocked", indexability_reason="Disallowed by robots.txt")
    found = issues_mod.evaluate("a1", [_url(inlink_count=3, **blocked)], [])
    assert [i["rule_id"] for i in found] == ["blocked_by_robots_linked"]
    assert found[0]["evidence"] == {"inlink_count": 3, "reason": "Disallowed by robots.txt"}
    assert found[0]["category"] == "Directives"

    assert _rule_ids([_url(inlink_count=0, **blocked)]) == []


def test_old_shaped_rows_are_skipped_without_error():
    # URL docs stored before these rules: no status_text / inlink_count keys at all.
    old_failed = {"id": "u2", "url": PUBLIC_URL, "normalized_url": PUBLIC_URL, "status_code": None, "indexability": "unknown"}
    old_blocked = {"id": "u3", "url": PUBLIC_URL + "2", "normalized_url": PUBLIC_URL + "2", "status_code": None, "indexability": "blocked"}
    assert _rule_ids([old_failed, old_blocked]) == []


def test_new_rules_registered():
    for rule_id, category in [("crawl_timeout", "Response Codes"), ("crawl_connection_error", "Response Codes"),
                              ("redirect_loop", "Response Codes"), ("blocked_by_robots_linked", "Directives")]:
        assert RULES[rule_id].category == category
    assert RULES["redirect_loop"].severity == "issue"
    assert RULE_ENGINE_VERSION == "2026.10.1"


def test_new_rules_are_unscored():
    # Crawlability already counts failed/blocked fetches from crawl counts; these
    # categories feed no issue-density dimension, so nothing is double-counted.
    from app.services.seo_crawler import scoring

    urls = [_url(status_text="timeout"), _url(id="u2", normalized_url=PUBLIC_URL + "2", indexability="blocked", inlink_count=2)]
    found = issues_mod.evaluate("a1", urls, [])
    assert found
    with_issues = scoring.compute_health_score(urls, found, {"discovered": 2, "fetched": 1, "failed": 1, "blocked": 1})
    without = scoring.compute_health_score(urls, [], {"discovered": 2, "fetched": 1, "failed": 1, "blocked": 1})
    assert with_issues == without


def test_issue_groups_get_rule_name_with_fallback():
    from app.api.routes.site_audit_seo import _with_rule_copy

    g = _with_rule_copy({"rule_id": "crawl_timeout", "category": "Response Codes", "affected_urls": 2})
    assert g["name"] == "Page timed out" and g["explanation"] and g["affected_urls"] == 2
    gone = _with_rule_copy({"rule_id": "retired_rule", "category": "X"})
    assert gone["name"] == "retired_rule" and gone["explanation"] is None
