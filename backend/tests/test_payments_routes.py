"""Regression test for a real, previously-shipped bug: payments.py combined
``from __future__ import annotations`` with ``@limiter.limit`` on
``POST /api/payments/razorpay/order``, which silently made FastAPI treat the
``payload: CreateOrderRequest`` body param as a required *query* parameter instead --
no import-time error, just a 422 "Field required" the instant a real checkout was
attempted. Static checks (pyflakes/mypy) never catch this class of bug; only an actual
request through the real route does, which is what this test does.
"""

from __future__ import annotations

import os

os.environ.setdefault("FORCE_JSON_STORAGE", "1")
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")
os.environ.setdefault("ENVIRONMENT", "test")

import pytest
from fastapi.testclient import TestClient

import app.main as main_mod
from app.api.routes import payments as payments_mod
from app.core.deps import get_current_user


class _FakeStorage:
    def __init__(self):
        self.created_orders: list[dict] = []

    def load_plans(self) -> dict:
        return {"basic": {"key": "basic", "name": "Basic Plan", "cost_monthly": 499, "is_trial_plan": False}}

    def create_payment_order(self, doc: dict) -> None:
        self.created_orders.append(doc)


@pytest.fixture
def client(monkeypatch):
    fake_storage = _FakeStorage()
    monkeypatch.setattr(payments_mod, "get_legacy_storage_module", lambda: fake_storage)
    monkeypatch.setattr(payments_mod.settings, "razorpay_key_id", "rzp_test_fake")
    monkeypatch.setattr(payments_mod.settings, "razorpay_key_secret", "fake_secret")
    monkeypatch.setattr(
        payments_mod.razorpay_client,
        "create_order",
        lambda *, amount_paise, currency, receipt, notes=None: {"id": "order_fake123"},
    )
    main_mod.app.dependency_overrides[get_current_user] = lambda: {"id": "u1", "role": "user"}
    try:
        with TestClient(main_mod.app) as c:
            yield c, fake_storage
    finally:
        main_mod.app.dependency_overrides.pop(get_current_user, None)


def test_create_order_reads_plan_key_from_json_body_not_query_string(client):
    c, fake_storage = client
    resp = c.post("/api/payments/razorpay/order", json={"plan_key": "basic"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["order_id"] == "order_fake123"
    assert body["plan_key"] == "basic"
    assert body["key_id"] == "rzp_test_fake"
    assert len(fake_storage.created_orders) == 1


def test_create_order_without_body_reports_missing_body_field_not_query_param():
    """If this regresses to the query-param bug, FastAPI reports the whole `payload`
    object missing at ``loc: ["query", "payload"]`` instead of the real body field
    ``plan_key`` at ``loc: ["body", "plan_key"]``."""
    main_mod.app.dependency_overrides[get_current_user] = lambda: {"id": "u1", "role": "user"}
    try:
        with TestClient(main_mod.app) as c:
            resp = c.post("/api/payments/razorpay/order", json={})
    finally:
        main_mod.app.dependency_overrides.pop(get_current_user, None)

    assert resp.status_code == 422
    detail = resp.json()["detail"]
    locs = [tuple(d["loc"]) for d in detail]
    assert ("query", "payload") not in locs
    assert ("body", "plan_key") in locs


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
