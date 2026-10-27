"""After "Post Now" the article row remembers its LinkedIn post, and the editor payload
exposes it (with a social_posts fallback for shares made before that was recorded)."""

import asyncio
import os
import sys

os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import app.api.routes.articles as arts
import app.api.routes.project_linkedin as pl

POST_URL = "https://www.linkedin.com/feed/update/urn:li:share:123/"


class _St:
    def __init__(self):
        self.patches: list[tuple[str, dict]] = []
        self.social: list[dict] = []

    def get_article(self, *, project_id, article_id):
        return {"id": article_id, "title": "T", "wp_link": "https://x.com/a"}

    def create_social_post(self, doc):
        self.social.append(doc)

    def patch_article_fields(self, aid, fields):
        self.patches.append((aid, dict(fields)))
        return True


def test_post_now_records_the_post_on_the_article(monkeypatch):
    st = _St()

    async def share(**_k):
        return {"post_urn": "urn:li:share:123", "post_url": POST_URL, "image_attached": True}

    monkeypatch.setattr(pl, "get_legacy_storage_module", lambda: st)
    monkeypatch.setattr(pl, "_require_project", lambda **_k: {"id": "p1"})
    monkeypatch.setattr(pl, "_require_linkedin_connected", lambda proj: ("tok", "urn:li:person:x"))
    monkeypatch.setattr(pl.linkedin_client, "share_article", share)
    out = asyncio.run(pl.linkedin_post("p1", "a1", pl.LinkedInPostRequest(commentary="Hello"), user={"id": "u"}))
    assert out["post_url"] == POST_URL
    assert st.patches == [("a1", {"linkedin_post_urn": "urn:li:share:123", "linkedin_post_url": POST_URL})]


class _LookupSt:
    def __init__(self, url):
        self.url = url
        self.calls = 0

    def get_latest_social_post_url(self, aid):
        self.calls += 1
        return self.url


def test_editor_payload_prefers_article_field_then_falls_back_to_social_posts():
    st = _LookupSt("https://www.linkedin.com/feed/update/old/")
    assert arts._linkedin_post_url(st, {"id": "a1", "linkedin_post_url": POST_URL}) == POST_URL
    assert st.calls == 0
    assert arts._linkedin_post_url(st, {"id": "a1"}) == "https://www.linkedin.com/feed/update/old/"
    assert arts._linkedin_post_url(_LookupSt(""), {"id": "a1"}) is None
