from __future__ import annotations

from datetime import datetime, timedelta

from app.core.deps import account_requires_email_verification


def test_account_requires_email_verification_pending():
    assert account_requires_email_verification({"account_status": "pending"}) is True
    assert account_requires_email_verification({"account_status": "active"}) is False


def test_generate_email_verification_otp_is_six_digits_and_not_weak():
    from app.legacy.storage import get_legacy_storage_module

    st = get_legacy_storage_module()
    codes = {st.generate_email_verification_otp() for _ in range(50)}
    assert len(codes) > 1
    for code in codes:
        assert len(code) == 6
        assert code.isdigit()
        assert code != "123456"


def test_verify_email_with_token_activates_user(monkeypatch):
    from app.legacy.storage import get_legacy_storage_module

    st = get_legacy_storage_module()

    monkeypatch.setattr(st, "_storage_mode", "json", raising=False)
    uid = "user-verify-test"
    email = "verify@example.com"
    code = "123456"
    exp = datetime.utcnow() + timedelta(minutes=10)
    user = {
        "id": uid,
        "email": email,
        "password_hash": "x",
        "role": "user",
        "subscription_type": "beta",
        "account_status": "pending",
        "email_verification_token": code,
        "email_verification_expires": exp.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "created_at": "2026-01-01 00:00:00",
    }

    def fake_get_user_by_email(em: str):
        return user if em == email else None

    updates: list[dict] = []

    def fake_update_user_fields(user_id: str, patch: dict) -> bool:
        updates.append(patch)
        user.update(patch)
        return True

    monkeypatch.setattr(st, "get_user_by_email", fake_get_user_by_email)
    monkeypatch.setattr(st, "update_user_fields", fake_update_user_fields)

    ok, msg = st.verify_email_with_token(email=email, token=code)
    assert ok is True
    assert "verified" in msg.lower()
    assert updates[-1]["account_status"] == "active"
    assert updates[-1]["email_verification_token"] == ""
