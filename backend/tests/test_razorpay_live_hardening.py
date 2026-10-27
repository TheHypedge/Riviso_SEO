"""Go-live hardening for Razorpay: no test keys in production, webhook grants a plan only for
the exact captured amount, and orders that don't exist for the current keys get closed."""

import asyncio
import json
import os

os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")

import pytest
from razorpay.errors import BadRequestError

import app.api.routes.payments as payments_mod
from tests.test_subscription_reconcile_service import _FakeStorage


# -- production boot check ---------------------------------------------------------


def _prod_settings(key_id):
    from app.core.config import Settings

    return Settings(
        ENVIRONMENT="production",
        SECRET_KEY="x" * 64,
        FIELD_ENCRYPTION_KEY="0" * 43 + "=",
        RAZORPAY_KEY_ID=key_id,
        RAZORPAY_KEY_SECRET="s",
        RAZORPAY_WEBHOOK_SECRET="w",
    )


def _boot_error(monkeypatch, key_id, allow=None):
    from app.core import production

    if allow is None:
        monkeypatch.delenv("RAZORPAY_ALLOW_TEST_KEYS", raising=False)
    else:
        monkeypatch.setenv("RAZORPAY_ALLOW_TEST_KEYS", allow)
    try:
        production.run_startup_checks(_prod_settings(key_id))
    except RuntimeError as e:
        return str(e)
    return ""


def test_production_refuses_razorpay_test_keys(monkeypatch):
    assert "test-mode key" in _boot_error(monkeypatch, "rzp_test_abc")


def test_production_allows_test_keys_only_with_explicit_flag(monkeypatch):
    assert "test-mode key" not in _boot_error(monkeypatch, "rzp_test_abc", allow="1")


def test_production_accepts_live_keys(monkeypatch):
    assert "test-mode key" not in _boot_error(monkeypatch, "rzp_live_abc")


# -- webhook amount check -------------------------------------------------------------


class _Req:
    def __init__(self, body: dict):
        self._raw = json.dumps(body).encode()
        self.headers = {"X-Razorpay-Signature": "sig", "x-razorpay-event-id": body["id"]}

    async def body(self):
        return self._raw


def _webhook(monkeypatch, *, amount, currency="INR", status="captured"):
    st = _FakeStorage(payments=[{"razorpay_order_id": "order_1", "user_id": "u1", "plan_key": "pro",
                                 "status": "created", "amount_paise": 149900, "currency": "INR"}])
    st.mark_webhook_event_seen = lambda eid: True
    paid: list[str] = []

    async def fake_mark_paid(*, order_id, payment_id, signature):
        paid.append(order_id)

    monkeypatch.setattr(payments_mod, "get_legacy_storage_module", lambda: st)
    monkeypatch.setattr(payments_mod, "_mark_payment_paid", fake_mark_paid)
    monkeypatch.setattr(payments_mod.razorpay_client, "verify_webhook_signature", lambda **k: True)
    monkeypatch.setattr(type(payments_mod.settings), "razorpay_configured", property(lambda self: True))
    body = {"id": f"evt_{amount}_{currency}_{status}", "event": "payment.captured",
            "payload": {"payment": {"entity": {"id": "pay_1", "order_id": "order_1", "amount": amount,
                                               "currency": currency, "status": status}}}}
    asyncio.run(payments_mod.razorpay_webhook(_Req(body)))
    return paid, st


def test_webhook_grants_plan_for_exact_captured_amount(monkeypatch):
    paid, _ = _webhook(monkeypatch, amount=149900)
    assert paid == ["order_1"]


@pytest.mark.parametrize("kw", [{"amount": 100}, {"amount": 149900, "currency": "USD"}, {"amount": 149900, "status": "authorized"}])
def test_webhook_refuses_mismatched_capture(monkeypatch, kw):
    paid, st = _webhook(monkeypatch, **kw)
    assert paid == []
    assert st.payment_updates[-1][1]["failure_reason"] == "captured_amount_mismatch"


# -- reconciliation of orders unknown to the current keys --------------------------------


def test_reconcile_closes_order_unknown_to_current_keys(monkeypatch):
    from app.services import razorpay_client
    from app.services.subscription_reconcile_service import reconcile_pending_payments

    def gone(order_id):
        raise BadRequestError("The id provided does not exist")

    monkeypatch.setattr(razorpay_client, "fetch_order", gone)
    st = _FakeStorage(payments=[{"razorpay_order_id": "order_test_old", "user_id": "u1", "plan_key": "pro", "status": "created"}])
    asyncio.run(reconcile_pending_payments(st))
    assert st.payment_updates[0][1]["status"] == "failed"
    assert "not_found" in st.payment_updates[0][1]["failure_reason"]
