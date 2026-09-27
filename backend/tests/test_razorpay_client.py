"""Self-check for the Razorpay client wrapper's pure/cryptographic logic -- the pieces
that are fully testable without a real Razorpay account: paise conversion and both
HMAC signature verifications (payment + webhook)."""

import hashlib
import hmac

import pytest

from app.services import razorpay_client as rc


def test_rupees_to_paise_uses_decimal_not_float():
    # 999.99 * 100 in raw binary floats is 99998.99999999999, not 99999 -- Decimal avoids that.
    assert rc.rupees_to_paise(999.99) == 99999
    assert rc.rupees_to_paise(1499) == 149900
    assert rc.rupees_to_paise(0) == 0
    assert rc.rupees_to_paise(49.5) == 4950


def test_verify_payment_signature_accepts_genuine_and_rejects_tampered(monkeypatch):
    monkeypatch.setattr(rc.settings, "razorpay_key_id", "rzp_test_dummy")
    monkeypatch.setattr(rc.settings, "razorpay_key_secret", "testsecret123")
    rc._client = None  # force a fresh client picking up the monkeypatched settings

    order_id, payment_id, secret = "order_ABC123", "pay_XYZ789", "testsecret123"
    genuine = hmac.new(secret.encode(), f"{order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()

    assert rc.verify_payment_signature(order_id=order_id, payment_id=payment_id, signature=genuine) is True
    assert rc.verify_payment_signature(order_id=order_id, payment_id=payment_id, signature=genuine[:-1] + ("0" if genuine[-1] != "0" else "1")) is False
    # A signature computed against a different payment_id must not verify against this one.
    assert rc.verify_payment_signature(order_id=order_id, payment_id="pay_OTHER", signature=genuine) is False

    rc._client = None  # don't leak the dummy client into other tests


def test_verify_webhook_signature_requires_raw_body_match(monkeypatch):
    monkeypatch.setattr(rc.settings, "razorpay_key_id", "rzp_test_dummy")
    monkeypatch.setattr(rc.settings, "razorpay_key_secret", "testsecret123")
    monkeypatch.setattr(rc.settings, "razorpay_webhook_secret", "webhooksecret456")
    rc._client = None

    body = b'{"event":"payment.captured","payload":{}}'
    secret = "webhooksecret456"
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

    assert rc.verify_webhook_signature(raw_body=body, signature=sig) is True
    assert rc.verify_webhook_signature(raw_body=body, signature="deadbeef") is False
    assert rc.verify_webhook_signature(raw_body=body, signature="") is False
    # Re-serializing the body (even with identical content but different byte layout)
    # must not be treated as equivalent -- the raw bytes are what's signed.
    assert rc.verify_webhook_signature(raw_body=b'{"event": "payment.captured", "payload": {}}', signature=sig) is False

    rc._client = None


def test_verify_webhook_signature_without_configured_secret_fails_closed(monkeypatch):
    monkeypatch.setattr(rc.settings, "razorpay_webhook_secret", "")
    assert rc.verify_webhook_signature(raw_body=b"{}", signature="anything") is False


if __name__ == "__main__":
    test_rupees_to_paise_uses_decimal_not_float()
    print("ok")
