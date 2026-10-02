"""Route-level tests for the new featured-image Upload/Remove actions (article editor
sidebar redesign) and a unit test for the WP tags precedence helper.

Uses the same TestClient + FakeStorage + dependency-override pattern already
established in test_payments_routes.py.
"""

from __future__ import annotations

import os

os.environ.setdefault("FORCE_JSON_STORAGE", "1")
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")
os.environ.setdefault("ENVIRONMENT", "test")

import pytest
from fastapi.testclient import TestClient

import app.main as main_mod
from app.api.routes import articles as articles_mod
from app.core.deps import get_current_user


class _FakeStorage:
    def __init__(self, article: dict):
        self._article = dict(article)
        self.patched: list[dict] = []

    def get_article(self, *, project_id: str, article_id: str):
        if article_id != self._article.get("id"):
            return None
        return dict(self._article)

    def patch_article_fields(self, article_id: str, updates: dict) -> bool:
        self.patched.append(dict(updates))
        self._article.update(updates)
        return True

    def _delete_featured_image_file(self, article_id: str) -> None:
        pass

    def load_plans(self) -> dict:
        return {}


async def _fake_project_access(*, st, user, project_id, full=False):
    return {"id": project_id, "platform": "wordpress"}


@pytest.fixture
def client(monkeypatch):
    article = {
        "id": "art1",
        "project_id": "proj1",
        "image_url": "https://res.cloudinary.com/demo/old.png",
        "featured_image_storage": "cloudinary",
        "featured_image_cloudinary_public_id": "riviso/articles/art1/featured",
    }
    fake_storage = _FakeStorage(article)
    monkeypatch.setattr(articles_mod, "get_legacy_storage_module", lambda: fake_storage)
    monkeypatch.setattr(articles_mod, "_require_project_access", _fake_project_access)
    main_mod.app.dependency_overrides[get_current_user] = lambda: {"id": "u1", "role": "user"}
    try:
        with TestClient(main_mod.app) as c:
            yield c, fake_storage
    finally:
        main_mod.app.dependency_overrides.pop(get_current_user, None)


def test_upload_featured_image_rejects_non_image_content_type(client):
    c, fake_storage = client
    resp = c.post(
        "/api/projects/proj1/articles/art1/featured-image/upload",
        files={"file": ("doc.txt", b"not an image", "text/plain")},
    )
    assert resp.status_code == 400
    assert not fake_storage.patched


def test_upload_featured_image_persists_data_url_via_patch(client):
    c, fake_storage = client
    resp = c.post(
        "/api/projects/proj1/articles/art1/featured-image/upload",
        files={"file": ("pic.png", b"fake-png-bytes", "image/png")},
    )
    assert resp.status_code == 200, resp.text
    assert len(fake_storage.patched) == 1
    updates = fake_storage.patched[0]
    assert updates["image_url"].startswith("data:image/png;base64,")
    assert updates["featured_image_source"] == "uploaded"


def test_remove_featured_image_clears_fields_and_deletes_cloudinary_asset(client, monkeypatch):
    c, fake_storage = client
    deleted_ids = []
    monkeypatch.setattr(
        "app.services.cloudinary_storage.delete_by_public_id",
        lambda public_id: deleted_ids.append(public_id),
    )
    resp = c.post("/api/projects/proj1/articles/art1/remove-featured-image")
    assert resp.status_code == 200, resp.text
    assert deleted_ids == ["riviso/articles/art1/featured"]
    assert len(fake_storage.patched) == 1
    updates = fake_storage.patched[0]
    assert updates["image_url"] == ""
    assert updates["featured_image_storage"] == ""
    assert updates["featured_image_cloudinary_public_id"] == ""


def test_remove_featured_image_noop_when_no_cloudinary_asset(client, monkeypatch):
    c, fake_storage = client
    fake_storage._article["featured_image_cloudinary_public_id"] = ""
    deleted_ids = []
    monkeypatch.setattr(
        "app.services.cloudinary_storage.delete_by_public_id",
        lambda public_id: deleted_ids.append(public_id),
    )
    resp = c.post("/api/projects/proj1/articles/art1/remove-featured-image")
    assert resp.status_code == 200, resp.text
    assert deleted_ids == []


def test_apply_wp_tags_prefers_explicit_tag_ids_over_keyword_names():
    payload: dict = {}
    articles_mod._apply_wp_tags_to_payload(payload, tag_ids=[5, 9], keywords=["seo", "marketing"])
    assert payload == {"tags": [5, 9]}


def test_apply_wp_tags_falls_back_to_keyword_tag_names_when_no_tag_ids():
    payload: dict = {}
    articles_mod._apply_wp_tags_to_payload(payload, tag_ids=[], keywords=["seo", "marketing"])
    assert payload == {"tag_names": ["seo", "marketing"]}


def test_apply_wp_tags_sets_neither_when_both_empty():
    payload: dict = {}
    articles_mod._apply_wp_tags_to_payload(payload, tag_ids=[], keywords=[])
    assert payload == {}


def test_parse_wp_tag_ids_dedupes_and_drops_invalid():
    assert articles_mod._parse_wp_tag_ids("5, 9, 5, abc, 0, -1") == [5, 9]


def test_update_article_maps_new_wp_default_fields_onto_article_row(client):
    """ArticleUpdateRequest's new post_type/wp_status/category_ids/tag_ids fields --
    the "Save changes" path for an article not yet live on WordPress (plan §5)."""
    c, fake_storage = client
    resp = c.patch(
        "/api/projects/proj1/articles/art1",
        json={"post_type": "pages", "wp_status": "publish", "category_ids": [3, 7], "tag_ids": [11, 12]},
    )
    assert resp.status_code == 200, resp.text
    assert len(fake_storage.patched) == 1
    updates = fake_storage.patched[0]
    assert updates["wp_rest_base"] == "pages"
    assert updates["wp_schedule_wp_status"] == "publish"
    assert updates["wp_category_ids"] == "3,7"
    assert updates["wp_tag_ids"] == "11,12"


def test_update_article_rejects_invalid_wp_status(client):
    c, fake_storage = client
    resp = c.patch("/api/projects/proj1/articles/art1", json={"wp_status": "trash"})
    assert resp.status_code == 400
    assert not fake_storage.patched


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
