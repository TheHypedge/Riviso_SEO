"""Self-check for subscription_reconcile_service -- mirrors test_trial_reminder_service.py's
fake-storage approach. Covers the renewal-milestone notification path (copy-not-alias
correctness, same bug class fixed in trial_reminder_service.py this session) and the
stale-payment reconciliation sweep (resolving a payment Razorpay itself reports as paid,
even though our own confirmation paths never received it)."""

import asyncio
from datetime import datetime, timedelta, timezone

from app.services.subscription_reconcile_service import check_renewal_milestones, reconcile_pending_payments


class _FakeStorage:
    def __init__(self, users=None, subs=None, payments=None, plans=None):
        self._users = users or []
        self._subs = subs or {}
        self._payments = {p["razorpay_order_id"]: p for p in (payments or [])}
        self._plans = plans or {"pro": {"name": "Riviso Pro", "cost_monthly": 1499}}
        self.inserted: list[dict] = []
        self.patched: list[tuple[str, dict]] = []
        self.user_field_updates: list[tuple[str, dict]] = []
        self.payment_updates: list[tuple[str, dict]] = []

    # -- users / subscriptions --
    def list_users(self):
        return self._users

    def get_user_by_id(self, uid):
        return next((u for u in self._users if u["id"] == uid), None)

    def get_subscription_by_user_id(self, uid):
        return self._subs.get(uid)

    def patch_subscription_fields(self, uid, fields):
        self.patched.append((uid, fields))
        self._subs.setdefault(uid, {}).update(fields)
        return True

    def update_user_fields(self, uid, fields):
        self.user_field_updates.append((uid, fields))
        return True

    def insert_notification(self, data):
        assert (data.get("id") or "").strip(), "notification id is required"
        self.inserted.append(data)

    def load_plans(self):
        return self._plans

    # -- payments --
    def load_stale_pending_payments(self, older_than_minutes=15):
        return list(self._payments.values())

    def get_payment_by_order_id(self, order_id):
        return self._payments.get(order_id)

    def update_payment_fields(self, order_id, fields):
        self.payment_updates.append((order_id, fields))
        self._payments[order_id] = {**self._payments[order_id], **fields}
        return True


def test_renewal_milestone_fires_once_and_copies_not_aliases_the_list():
    period_end = (datetime.now(timezone.utc) + timedelta(days=2, hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    st = _FakeStorage(
        users=[{"id": "u1", "email": "u1@example.com", "subscription_type": "pro"}],
        subs={"u1": {"current_period_end": period_end, "payment_notified_milestones": ["7d"]}},
    )

    asyncio.run(check_renewal_milestones(st))

    assert len(st.inserted) == 1
    row = st.inserted[0]
    assert row["id"]
    assert row["user_id"] == "u1"
    assert row["type"] == "subscription_renewal"
    assert st.patched == [("u1", {"payment_notified_milestones": ["7d", "3d"]})]


def test_renewal_milestone_skips_users_with_no_period_end():
    st = _FakeStorage(users=[{"id": "u1", "subscription_type": "beta"}], subs={"u1": {"current_period_end": None}})
    asyncio.run(check_renewal_milestones(st))
    assert st.inserted == []
    assert st.patched == []


def test_reconcile_resolves_stale_order_razorpay_reports_paid(monkeypatch):
    from app.services import razorpay_client, subscription_reconcile_service as svc

    monkeypatch.setattr(razorpay_client, "fetch_order", lambda order_id: {"id": order_id, "status": "paid"})
    monkeypatch.setattr(
        razorpay_client,
        "list_order_payments",
        lambda order_id: [{"id": "pay_123", "status": "captured"}],
    )

    marked: list[dict] = []

    async def _fake_mark_paid(*, order_id, payment_id, signature):
        marked.append({"order_id": order_id, "payment_id": payment_id, "signature": signature})
        return {"status": "paid"}

    monkeypatch.setattr("app.api.routes.payments._mark_payment_paid", _fake_mark_paid)

    st = _FakeStorage(payments=[{
        "razorpay_order_id": "order_stale1",
        "user_id": "u1",
        "plan_key": "pro",
        "status": "created",
    }])

    asyncio.run(reconcile_pending_payments(st))

    assert marked == [{"order_id": "order_stale1", "payment_id": "pay_123", "signature": None}]
    assert st.payment_updates == []  # resolved via _mark_payment_paid, not a direct failed-update


def test_reconcile_marks_genuinely_abandoned_order_as_failed(monkeypatch):
    from app.services import razorpay_client

    monkeypatch.setattr(razorpay_client, "fetch_order", lambda order_id: {"id": order_id, "status": "created"})

    st = _FakeStorage(payments=[{
        "razorpay_order_id": "order_stale2",
        "user_id": "u1",
        "plan_key": "pro",
        "status": "created",
    }])

    asyncio.run(reconcile_pending_payments(st))

    assert len(st.payment_updates) == 1
    order_id, fields = st.payment_updates[0]
    assert order_id == "order_stale2"
    assert fields["status"] == "failed"
    assert "reconciliation_timeout" in fields["failure_reason"]


if __name__ == "__main__":
    test_renewal_milestone_fires_once_and_copies_not_aliases_the_list()
    test_renewal_milestone_skips_users_with_no_period_end()
    print("ok")
