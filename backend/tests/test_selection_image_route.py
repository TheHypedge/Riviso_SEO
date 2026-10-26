"""Editor selection tool -> "Generate image": POST .../media/generate-from-selection.

The image is built from the SELECTED passage (not the article title), in the project's
image style, and the route returns {id, url, alt} for the editor to insert below the
selection. Project access, article load and image generation are all faked.
"""

from __future__ import annotations

import os

os.environ.setdefault("FORCE_JSON_STORAGE", "1")
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")
os.environ.setdefault("ENVIRONMENT", "test")

import pytest
from fastapi.testclient import TestClient

import app.api.routes.articles as articles_routes
import app.main as main_mod
import app.services.inner_images as inner_images
from app.core.deps import get_current_user

URL = "/api/projects/p1/articles/a1/media/generate-from-selection"
HDR = {"X-Requested-With": "XMLHttpRequest"}
PASSAGE = "Both spouses must sign the settlement deed in front of the family court judge."


@pytest.fixture()
def client(monkeypatch):
    calls: dict = {}

    async def fake_access(**kw):
        return {"id": "p1", "image_prompts": [], "brand_identity": "Sheokand Legal"}

    def fake_article(**kw):
        return {"id": "a1", "title": "Mutual Divorce Guide", "keywords": ["mutual divorce"]}

    async def fake_illustrate(**kw):
        calls.update(kw)
        return "m1", "https://res.cloudinary.com/x/m1.png", "Couple signing a settlement deed"

    monkeypatch.setattr(articles_routes, "_require_project_access", fake_access)
    monkeypatch.setattr(articles_routes, "_get_article_or_404", fake_article)
    monkeypatch.setattr(inner_images, "illustrate_passage", fake_illustrate)
    monkeypatch.setattr(articles_routes.settings, "openai_api_key", "sk-test")
    main_mod.app.dependency_overrides[get_current_user] = lambda: {"id": "u1", "role": "admin"}
    c = TestClient(main_mod.app)
    c.calls = calls
    yield c
    main_mod.app.dependency_overrides.clear()


def test_image_is_made_from_the_selected_passage(client):
    r = client.post(URL, json={"selected_text": PASSAGE, "heading": "Final Hearing"}, headers=HDR)
    assert r.status_code == 200, r.text
    assert r.json() == {"id": "m1", "url": "https://res.cloudinary.com/x/m1.png", "alt": "Couple signing a settlement deed"}
    assert client.calls["passage"] == PASSAGE
    assert client.calls["heading"] == "Final Hearing"
    assert client.calls["title"] == "Mutual Divorce Guide"
    assert client.calls["proj"]["brand_identity"] == "Sheokand Legal"


def test_too_short_selection_is_rejected(client):
    assert client.post(URL, json={"selected_text": "too short"}, headers=HDR).status_code == 422


def test_generation_failure_returns_502_not_a_broken_image(client, monkeypatch):
    async def failing(**kw):
        return None, None, ""

    monkeypatch.setattr(inner_images, "illustrate_passage", failing)
    r = client.post(URL, json={"selected_text": PASSAGE}, headers=HDR)
    assert r.status_code == 502
