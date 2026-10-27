"""Forgot-password: reset emails go only to registered, active accounts — but the HTTP
response is identical either way (no account enumeration)."""

import asyncio
import os

os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")

import app.api.routes.auth as auth
from app.schemas.auth import ForgotPasswordRequest


class FakeSt:
    def __init__(self, users):
        self.users = users
        self.tokens: list[str] = []

    def get_user_by_email(self, email):
        return self.users.get(email)

    def set_password_reset_token(self, *, email, token, expires_at):
        self.tokens.append(email)
        return True, 0


def _run(monkeypatch, users, email):
    st = FakeSt(users)
    sent: list[str] = []
    monkeypatch.setattr(auth, "get_legacy_storage_module", lambda: st)
    monkeypatch.setattr(auth, "dispatch_password_reset_email", lambda *, to, token: sent.append(to))
    # Call the undecorated handler (skip the rate limiter, which needs a real request).
    handler = getattr(auth.forgot_password, "__wrapped__", auth.forgot_password)
    res = asyncio.run(handler(ForgotPasswordRequest(email=email), request=None))
    return res, sent, st


ACTIVE = {"id": "u1", "email": "real@example.com", "password_hash": "x", "account_status": "active"}


def test_unregistered_email_gets_no_mail_and_no_token(monkeypatch):
    res, sent, st = _run(monkeypatch, {}, "ghost@example.com")
    assert sent == [] and st.tokens == []
    assert res.ok


def test_registered_active_email_gets_mail(monkeypatch):
    res, sent, st = _run(monkeypatch, {"real@example.com": ACTIVE}, "real@example.com")
    assert sent == ["real@example.com"] and st.tokens == ["real@example.com"]


def test_deactivated_account_gets_no_mail(monkeypatch):
    users = {"real@example.com": {**ACTIVE, "is_deactivated": True, "account_status": "deactivated"}}
    _, sent, _ = _run(monkeypatch, users, "real@example.com")
    assert sent == []


def test_response_is_identical_for_registered_and_unregistered(monkeypatch):
    a, _, _ = _run(monkeypatch, {}, "ghost@example.com")
    b, _, _ = _run(monkeypatch, {"real@example.com": ACTIVE}, "real@example.com")
    assert a.model_dump() == b.model_dump()
