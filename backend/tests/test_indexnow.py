"""IndexNow (Bing & co.): host filtering, rejection mapping, setup/verify flow — no network."""

import asyncio
import os

os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")

import httpx
import pytest

from app.services import indexnow

LOC = "https://example.com/abc123abc123.txt"


def test_same_host_urls_drops_foreign_and_duplicate_urls():
    urls = [
        "https://example.com/a/",
        "https://example.com/a/",
        "https://www.example.com/b/",
        "https://other.com/c/",
        "ftp://example.com/d",
        "",
    ]
    assert indexnow.same_host_urls(urls, LOC) == ["https://example.com/a/"]


def _patch_endpoint(monkeypatch, status: int, seen: list):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status)

    real = httpx.AsyncClient

    def fake_client(*a, **k):
        k["transport"] = httpx.MockTransport(handler)
        return real(*a, **k)

    monkeypatch.setattr(indexnow.httpx, "AsyncClient", fake_client)


def test_submit_sends_protocol_body(monkeypatch):
    seen: list = []
    _patch_endpoint(monkeypatch, 202, seen)
    r = asyncio.run(indexnow.submit_urls(key="abc123abc123", key_location=LOC, urls=["https://example.com/x"]))
    assert r == {"http_status": 202, "submitted": 1}
    import json

    body = json.loads(seen[0].content)
    assert body == {
        "host": "example.com",
        "key": "abc123abc123",
        "keyLocation": LOC,
        "urlList": ["https://example.com/x"],
    }


def test_submit_rejection_is_readable(monkeypatch):
    _patch_endpoint(monkeypatch, 403, [])
    with pytest.raises(RuntimeError, match="key not valid"):
        asyncio.run(indexnow.submit_urls(key="abc123abc123", key_location=LOC, urls=["https://example.com/x"]))


def test_maybe_submit_skips_when_not_verified_or_disabled(monkeypatch):
    seen: list = []
    _patch_endpoint(monkeypatch, 200, seen)
    ready = {"id": "p", "indexnow_key": "abc123abc123", "indexnow_key_location": LOC}
    assert asyncio.run(indexnow.maybe_submit(proj={**ready, "indexnow_key_location": ""}, urls=["https://example.com/x"])) is False
    assert asyncio.run(indexnow.maybe_submit(proj={**ready, "indexnow_enabled": False}, urls=["https://example.com/x"])) is False
    assert seen == []
    assert asyncio.run(indexnow.maybe_submit(proj=ready, urls=["https://example.com/x"])) is True


class FakeStorage:
    def __init__(self):
        self.updates: list[dict] = []

    def update_project_fields(self, _pid, updates):
        self.updates.append(dict(updates))
        return True


def _setup(monkeypatch, *, plugin_ok: bool, file_ok: bool, proj_extra=None):
    class FakeWp:
        def __init__(self, **_k):
            pass

        async def ensure_resolved_site_url(self):
            return "https://example.com"

        async def post_json(self, path, payload, timeout=0):
            if not plugin_ok:
                raise RuntimeError("404")
            assert path.endswith("/indexnow-key")
            return {"ok": True, "key_location": f"https://example.com/home/{payload['key']}.txt"}

    async def fake_match(_loc, _key):
        return file_ok

    monkeypatch.setattr(indexnow, "WordpressClient", FakeWp)
    monkeypatch.setattr(indexnow, "key_file_matches", fake_match)
    st = FakeStorage()
    proj = {"id": "p", "wp_site_url": "https://example.com", "wp_username": "u", "wp_app_password": "x", **(proj_extra or {})}
    out = asyncio.run(indexnow.setup_for_project(st=st, proj=proj))
    return st, out


def test_setup_verified_stores_key_location(monkeypatch):
    st, out = _setup(monkeypatch, plugin_ok=True, file_ok=True)
    key = st.updates[0]["indexnow_key"]
    assert len(key) == 32
    # Plugin's home_url-based location wins over the ping's site_url.
    assert st.updates[0]["indexnow_key_location"] == f"https://example.com/home/{key}.txt"
    assert out["verified"] and not out["indexnow_error"]


def test_setup_without_plugin_keeps_key_and_explains_manual_upload(monkeypatch):
    st, out = _setup(monkeypatch, plugin_ok=False, file_ok=False, proj_extra={"indexnow_key": "keepme12345"})
    assert st.updates[0]["indexnow_key"] == "keepme12345"
    assert st.updates[0]["indexnow_key_location"] == ""
    assert "keepme12345.txt" in out["indexnow_error"] and "0.7.0" in out["indexnow_error"]


def test_setup_requires_wordpress(monkeypatch):
    with pytest.raises(RuntimeError, match="Connect WordPress"):
        asyncio.run(indexnow.setup_for_project(st=FakeStorage(), proj={"id": "p"}))
