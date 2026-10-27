"""Round-2 hardening: https-only CORS, hashed reset/OTP tokens, redirect-safe image fetch,
SSRF guard on site-map sync. All isolated — no database, no network."""

import asyncio
import os
import sys

os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import httpx
import pytest

import storage
from app.services.url_guard import SsrfError


def test_cors_drops_plain_http_and_malformed_origins_in_production(monkeypatch):
    import app.main as main

    monkeypatch.setattr(main.settings, "cors_origins", "http://www.riviso.com,app.riviso.com,https://ok.example")
    monkeypatch.setattr(type(main.settings), "is_production", property(lambda self: True))
    origins = main._effective_cors_origins()
    assert "https://ok.example" in origins
    assert all(o.startswith("https://") for o in origins)


class _Users:
    """In-memory stand-in for the user store used by the token helpers."""

    def __init__(self, monkeypatch, user):
        self.user = user
        monkeypatch.setattr(storage, "get_user_by_email", lambda em: self.user)
        monkeypatch.setattr(storage, "update_user_fields", self.update)

    def update(self, _uid, fields):
        self.user.update(fields)
        return True


def test_email_otp_is_stored_as_keyed_digest_and_still_verifies(monkeypatch):
    from datetime import datetime, timedelta

    u = _Users(monkeypatch, {"id": "u1", "email": "a@b.co"})
    storage.set_email_verification(user_id="u1", token="482913", expires_at=datetime.utcnow() + timedelta(minutes=5))
    stored = u.user["email_verification_token"]
    assert stored.startswith(storage._TOKEN_DIGEST_PREFIX) and "482913" not in stored
    assert storage.verify_email_with_token(email="a@b.co", token="000000")[0] is False
    assert storage.verify_email_with_token(email="a@b.co", token="482913")[0] is True


def test_reset_token_is_stored_as_keyed_digest(monkeypatch):
    from datetime import datetime, timedelta

    u = _Users(monkeypatch, {"id": "u1", "email": "a@b.co"})
    ok, _ = storage.set_password_reset_token(email="a@b.co", token="raw-reset-token", expires_at=datetime.utcnow() + timedelta(hours=1))
    assert ok
    assert u.user["password_reset_token"] == storage._token_digest("raw-reset-token")
    assert "raw-reset-token" not in u.user["password_reset_token"]


def test_insert_user_hashes_a_plain_otp_once():
    digest = storage._token_digest("123456")
    assert digest != "123456" and storage._token_digest("123456") == digest  # deterministic for lookups


def _mock_client(monkeypatch, handler):
    real = httpx.Client

    def fake(*a, **k):
        k["transport"] = httpx.MockTransport(handler)
        return real(*a, **k)

    monkeypatch.setattr(httpx, "Client", fake)


def test_image_fetch_rechecks_redirect_target(monkeypatch):
    # Literal public IP -> no DNS needed; it redirects to cloud metadata.
    _mock_client(monkeypatch, lambda req: httpx.Response(302, headers={"location": "http://169.254.169.254/latest/"}))
    with pytest.raises(SsrfError):
        storage._fetch_public_image("http://93.184.216.34/img.png")


def test_image_fetch_caps_size(monkeypatch):
    monkeypatch.setattr(storage, "_MAX_REMOTE_IMAGE_BYTES", 10)
    _mock_client(monkeypatch, lambda req: httpx.Response(200, content=b"x" * 50, headers={"content-type": "image/png"}))
    with pytest.raises(ValueError, match="too large"):
        storage._fetch_public_image("http://93.184.216.34/img.png")


def test_site_map_sync_refuses_private_wordpress_host():
    from app.services.internal_link_service import InternalLinkService

    svc = InternalLinkService(project={"id": "p", "wp_site_url": "http://127.0.0.1", "wp_username": "u", "wp_app_password": "x"})
    with pytest.raises(RuntimeError, match="not allowed"):
        asyncio.run(svc.sync_site_map_from_wp())
