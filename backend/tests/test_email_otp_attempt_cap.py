"""Regression (QA run 2026-10-27, AUTH-08): the 6-digit email OTP had no per-account attempt
cap -- 12 wrong codes left it valid, so with the (then broken) per-IP limit it could be brute
forced. Now 5 wrong codes void the code until the user requests a new one."""

import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import storage as storage_module  # noqa: E402


def _user_store(monkeypatch, code="482913"):
    user = {"id": "u1", "email": "a@example.com", "email_verification_token": storage_module._token_digest(code), "email_verification_attempts": 0,
            "email_verification_expires": (datetime.utcnow() + timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%SZ")}
    monkeypatch.setattr(storage_module, "get_user_by_email", lambda em: dict(user))
    monkeypatch.setattr(storage_module, "update_user_fields", lambda uid, f: user.update(f) or True)
    return user


def test_correct_code_within_the_cap_verifies(monkeypatch):
    user = _user_store(monkeypatch)
    for _ in range(4):
        assert storage_module.verify_email_with_token(email="a@example.com", token="000000")[0] is False
    ok, _ = storage_module.verify_email_with_token(email="a@example.com", token="482913")
    assert ok and user["account_status"] == "active" and user["email_verification_attempts"] == 0


def test_five_wrong_codes_void_the_code(monkeypatch):
    user = _user_store(monkeypatch)
    for _ in range(5):
        storage_module.verify_email_with_token(email="a@example.com", token="000000")
    assert user["email_verification_token"] == ""
    ok, msg = storage_module.verify_email_with_token(email="a@example.com", token="482913")
    assert not ok and user.get("account_status") != "active"


def test_attempts_field_survives_the_user_storage_shape():
    norm = storage_module._normalize_user_dict({"id": "u1", "email": "a@example.com", "email_verification_attempts": 3})
    assert norm["email_verification_attempts"] == 3
