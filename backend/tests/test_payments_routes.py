"""Self-check for the payment route module's core logic -- plan-price resolution
(rejecting the trial plan and unpriced plans, so a client can never "buy" something that
isn't actually for sale) and _mark_payment_paid's idempotency (the property the whole
dual-confirmation design in payments.py depends on: whichever of /verify or /webhook
arrives first does the work, the other is a safe no-op)."""

import asyncio

import pytest
from fastapi import HTTPException

from app.api.routes.payments import _mark_payment_paid, _resolve_paid_plan


class _FakeStorage:
    def __init__(self, payments=None, users=None, plans=None):
        self._payments = {p["razorpay_order_id"]: p for p in (payments or [])}
        self._users = {u["id"]: u for u in (users or [])}
        self._plans = plans or {"pro": {"name": "Riviso Pro", "cost_monthly": 1499}}
        self.subscription_patches: list[tuple[str, dict]] = []
        self.user_field_updates: list[tuple[str, dict]] = []

    def load_plans(self):
        return self._plans

    def get_payment_by_order_id(self, order_id):
        return self._payments.get(order_id)

    def update_payment_fields(self, order_id, fields):
        self._payments[order_id] = {**self._payments[order_id], **fields}
        return True

    def patch_subscription_fields(self, uid, fields):
        self.subscription_patches.append((uid, fields))
        return True

    def update_user_fields(self, uid, fields):
        self.user_field_updates.append((uid, fields))
        return True

    def get_user_by_id(self, uid):
        return self._users.get(uid)


def test_resolve_paid_plan_rejects_trial_plan():
    st = _FakeStorage(plans={"beta": {"name": "Beta", "is_trial_plan": True, "cost_monthly": 0}})
    with pytest.raises(HTTPException) as exc:
        _resolve_paid_plan(st, "beta")
    assert exc.value.status_code == 400


def test_resolve_paid_plan_rejects_zero_cost_plan():
    st = _FakeStorage(plans={"free": {"name": "Free", "cost_monthly": 0}})
    with pytest.raises(HTTPException) as exc:
        _resolve_paid_plan(st, "free")
    assert exc.value.status_code == 400


def test_resolve_paid_plan_rejects_unknown_plan():
    st = _FakeStorage(plans={})
    with pytest.raises(HTTPException) as exc:
        _resolve_paid_plan(st, "nonexistent")
    assert exc.value.status_code == 404


def test_resolve_paid_plan_accepts_priced_non_trial_plan():
    st = _FakeStorage()
    plan = _resolve_paid_plan(st, "pro")
    assert plan["cost_monthly"] == 1499


def test_mark_payment_paid_sets_period_and_plan(monkeypatch):
    import app.api.routes.payments as payments_mod

    st = _FakeStorage(
        payments=[{"razorpay_order_id": "order_1", "user_id": "u1", "plan_key": "pro", "status": "created", "amount_paise": 149900}],
        users=[{"id": "u1", "email": "u1@example.com"}],
    )
    monkeypatch.setattr(payments_mod, "get_legacy_storage_module", lambda: st)
    # Email dispatch is fire-and-forget via asyncio.create_task inside dispatch_*; just
    # make sure the import path resolves without needing real SMTP config.
    monkeypatch.setattr("app.services.email_dispatch.dispatch_plan_notification_email", lambda **kw: None)
    monkeypatch.setattr("app.services.email_dispatch.dispatch_payment_receipt_email", lambda **kw: None)

    result = asyncio.run(_mark_payment_paid(order_id="order_1", payment_id="pay_1", signature="sig_1"))

    assert result["status"] == "paid"
    assert st.user_field_updates == [("u1", {"subscription_type": "pro"})]
    assert len(st.subscription_patches) == 1
    uid, fields = st.subscription_patches[0]
    assert uid == "u1"
    assert fields["current_period_start"] and fields["current_period_end"]
    assert fields["last_payment_order_id"] == "order_1"
    assert fields["payment_notified_milestones"] == []


def test_mark_payment_paid_is_idempotent_on_second_call(monkeypatch):
    import app.api.routes.payments as payments_mod

    st = _FakeStorage(
        payments=[{"razorpay_order_id": "order_2", "user_id": "u1", "plan_key": "pro", "status": "created", "amount_paise": 149900}],
        users=[{"id": "u1", "email": "u1@example.com"}],
    )
    monkeypatch.setattr(payments_mod, "get_legacy_storage_module", lambda: st)
    monkeypatch.setattr("app.services.email_dispatch.dispatch_plan_notification_email", lambda **kw: None)
    monkeypatch.setattr("app.services.email_dispatch.dispatch_payment_receipt_email", lambda **kw: None)

    asyncio.run(_mark_payment_paid(order_id="order_2", payment_id="pay_1", signature="sig_1"))
    first_patch_count = len(st.subscription_patches)
    first_user_update_count = len(st.user_field_updates)

    # Second call (e.g. the webhook arriving after /verify already processed it) must be
    # a pure no-op -- no duplicate plan assignment, no duplicate period extension.
    asyncio.run(_mark_payment_paid(order_id="order_2", payment_id="pay_1", signature=None))

    assert len(st.subscription_patches) == first_patch_count
    assert len(st.user_field_updates) == first_user_update_count


if __name__ == "__main__":
    test_resolve_paid_plan_rejects_trial_plan()
    test_resolve_paid_plan_accepts_priced_non_trial_plan()
    print("ok")
