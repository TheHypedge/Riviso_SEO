"""Generate modal "WordPress status = Publish" must post the article live after generation
(it used to only store the choice, so research/cluster articles always stayed draft)."""

import asyncio
import os

os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")

import app.api.routes.articles as arts


class FakeStorage:
    def __init__(self, article: dict):
        self.article = article
        self.patches: list[dict] = []

    def patch_article_fields(self, _aid, updates):
        self.patches.append(dict(updates))
        self.article.update(updates)
        return True


WP_PROJ = {"id": "p1", "wp_verified_status": "connected"}


def _run(monkeypatch, *, proj, article, wp_status, publish_exc=None):
    st = FakeStorage(article)
    calls: list[dict] = []

    async def fake_core(**kw):
        calls.append(kw)
        if publish_exc:
            raise publish_exc
        return {"ok": True}

    async def fake_err(*_a, **_k):
        return None

    monkeypatch.setattr(arts, "_publish_article_core", fake_core)
    monkeypatch.setattr(arts, "publish_pipeline_error", fake_err)
    monkeypatch.setattr(arts, "_get_article_or_404", lambda **_k: st.article)
    asyncio.run(
        arts.apply_generate_wp_choice(
            st=st, proj=proj, project_id="p1", article_id="a1", post_type="pages", wp_status=wp_status,
        )
    )
    return st, calls


def test_draft_only_stores_choice(monkeypatch):
    st, calls = _run(monkeypatch, proj=WP_PROJ, article={}, wp_status="draft")
    assert calls == []
    assert st.patches[0] == {"wp_rest_base": "pages", "wp_schedule_wp_status": "draft"}


def test_publish_posts_live_with_chosen_post_type(monkeypatch):
    st, calls = _run(monkeypatch, proj=WP_PROJ, article={}, wp_status="publish")
    assert len(calls) == 1
    assert calls[0]["wp_status"] == "publish" and calls[0]["post_type"] == "pages"


def test_publish_skipped_when_already_on_wordpress(monkeypatch):
    _, calls = _run(monkeypatch, proj=WP_PROJ, article={"wp_post_id": 42}, wp_status="publish")
    assert calls == []


def test_publish_skipped_for_shopify(monkeypatch):
    _, calls = _run(monkeypatch, proj={"platform": "shopify"}, article={}, wp_status="publish")
    assert calls == []


def test_publish_failure_does_not_raise_and_records_error(monkeypatch):
    st, _ = _run(monkeypatch, proj=WP_PROJ, article={}, wp_status="publish", publish_exc=RuntimeError("WP 403"))
    assert "auto-publish to WordPress failed" in st.article["wp_schedule_error"]
    assert "WP 403" in st.article["wp_schedule_error"]


def test_unverified_wordpress_records_error(monkeypatch):
    st, calls = _run(monkeypatch, proj={"id": "p1"}, article={}, wp_status="publish")
    assert calls == []
    assert "auto-publish to WordPress failed" in st.article["wp_schedule_error"]
