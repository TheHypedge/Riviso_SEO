"""Regression (QA run 2026-10-27, MED-06): an SVG with <script> uploaded as article media was
stored and served from the API origin as image/svg+xml -> stored XSS on api.riviso.cloud.
User media must be a real raster image (magic bytes), and the public media route must never
let stored content execute."""

from __future__ import annotations

import os

os.environ.setdefault("FORCE_JSON_STORAGE", "1")
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")
os.environ.setdefault("ENVIRONMENT", "test")

import pytest
from fastapi.testclient import TestClient

import app.api.routes.article_media_public as media_public
import app.api.routes.articles as articles_routes
import app.main as main_mod
from app.core.deps import get_current_user
from app.services.article_media_storage import sniff_raster_image

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>'


def test_sniff_accepts_only_raster_images():
    assert sniff_raster_image(PNG) == "image/png"
    assert sniff_raster_image(b"\xff\xd8\xff\xe0" + b"0" * 8) == "image/jpeg"
    assert sniff_raster_image(b"GIF89a" + b"0" * 8) == "image/gif"
    assert sniff_raster_image(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp"
    for bad in (SVG, b"<html><script>x</script></html>", b"", b"%PDF-1.7"):
        assert sniff_raster_image(bad) is None


@pytest.fixture()
def client(monkeypatch):
    saved = []

    async def fake_access(**kw):
        return {"id": "p1"}

    monkeypatch.setattr(articles_routes, "_require_project_access", fake_access)
    monkeypatch.setattr(articles_routes, "_get_article_or_404", lambda **kw: {"id": "a1"})
    monkeypatch.setattr(articles_routes, "save_article_media",
                        lambda **kw: saved.append(kw["content_type"]) or ("m1", "https://res.cloudinary.com/x/m1.png"))
    main_mod.app.dependency_overrides[get_current_user] = lambda: {"id": "u1", "role": "admin"}
    c = TestClient(main_mod.app)
    c.saved = saved
    yield c
    main_mod.app.dependency_overrides.clear()


def _upload(c, name, data, ctype):
    return c.post("/api/projects/p1/articles/a1/media/upload", headers={"X-Requested-With": "x"}, files={"file": (name, data, ctype)})


def test_svg_with_script_is_rejected(client):
    assert _upload(client, "x.svg", SVG, "image/svg+xml").status_code == 400
    assert client.saved == []


def test_script_disguised_as_png_is_rejected(client):
    assert _upload(client, "x.png", b"<script>alert(1)</script>", "image/png").status_code == 400
    assert client.saved == []


def test_real_png_is_stored_with_its_true_type(client):
    r = _upload(client, "photo.jpg", PNG, "image/jpeg")  # lying Content-Type: stored as what it really is
    assert r.status_code == 200 and client.saved == ["image/png"]


def test_public_media_cannot_execute(monkeypatch):
    monkeypatch.setattr(media_public, "load_article_media", lambda image_id: (SVG, "image/svg+xml"))
    r = TestClient(main_mod.app).get("/api/public/article-media/0123456789abcdef")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in r.headers["content-security-policy"] and "default-src 'none'" in r.headers["content-security-policy"]
