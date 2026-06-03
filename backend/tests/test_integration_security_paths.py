"""I5.6: integration tests for the security-sensitive paths.

Covers, end-to-end through FastAPI's routing + dependency + middleware stack:

* Auth gating         — protected route rejects anonymous callers, serves authed ones.
* CSRF protection     — cookie-auth mutations without ``X-Requested-With`` are blocked (S1.7).
* Plan / trial gating — feature flags, quota exhaustion, and trial expiry return 403 (publish/
                        generate/schedule paths share the same gatekeeper).
* Observability       — every response carries an ``X-Request-ID`` and ``/metrics`` is exposed.

Storage is forced to the JSON fallback and never touches a real database.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

os.environ.setdefault("FORCE_JSON_STORAGE", "1")
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")
os.environ.setdefault("ENVIRONMENT", "test")

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

import app.main as main_mod
from app.core.deps import get_current_user
import app.services.plan_gatekeeper as pg
from app.services.plan_gatekeeper import PlanAction, require_plan_action


# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #
class FakeStorage:
    """Minimal storage stand-in for the gatekeeper (no DB)."""

    def __init__(self, plan: dict, *, subscription: dict | None = None, consume_ok: bool = True):
        self._plan = plan
        self._subscription = subscription or {}
        self._consume_ok = consume_ok

    def load_plans(self) -> dict:
        return {"beta": self._plan}

    def ensure_subscription_for_user(self, _user) -> dict:
        return self._subscription

    def get_subscription_by_user_id(self, _uid):
        return self._subscription

    def consume_scheduled_usage(self, _uid, *, month_limit=None, amount=1):
        return (self._consume_ok, None if self._consume_ok else "Schedule limit reached.")

    def consume_article_usage(self, _uid, *, day_limit=None, month_limit=None, amount=1):
        return (self._consume_ok, None if self._consume_ok else "Article limit reached.")


def _gating_app() -> FastAPI:
    app = FastAPI()

    @app.post("/schedule")
    async def _schedule(_user=Depends(require_plan_action(PlanAction.SCHEDULE_POST))):
        return {"ok": True}

    @app.post("/generate")
    async def _generate(_user=Depends(require_plan_action(PlanAction.GENERATE_CONTENT))):
        return {"ok": True}

    return app


def _use_storage(monkeypatch, storage: FakeStorage) -> None:
    monkeypatch.setattr(pg, "get_legacy_storage_module", lambda: storage)


def _use_user(app: FastAPI, user: dict) -> None:
    app.dependency_overrides[get_current_user] = lambda: user


# --------------------------------------------------------------------------- #
# Auth + observability against the real app
# --------------------------------------------------------------------------- #
@pytest.fixture(scope="module")
def client():
    with TestClient(main_mod.app) as c:
        yield c


def test_protected_route_requires_auth(client):
    resp = client.get("/api/health/ready")
    assert resp.status_code == 401


def test_protected_route_serves_authenticated_user(client):
    main_mod.app.dependency_overrides[get_current_user] = lambda: {"id": "u1", "role": "user"}
    try:
        resp = client.get("/api/health/ready")
        assert resp.status_code == 200
        assert resp.json()["service"]
    finally:
        main_mod.app.dependency_overrides.pop(get_current_user, None)


def test_public_liveness_is_open(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_every_response_has_request_id(client):
    resp = client.get("/api/health")
    assert resp.headers.get("x-request-id")


def test_inbound_request_id_is_echoed(client):
    resp = client.get("/api/health", headers={"X-Request-ID": "corr-abc-123"})
    assert resp.headers.get("x-request-id") == "corr-abc-123"


def test_metrics_endpoint_exposed(client):
    resp = client.get("/metrics")
    # 200 when prometheus-client is installed, 503 when it is not — both prove wiring.
    assert resp.status_code in (200, 503)


def test_csrf_blocks_cookie_mutation_without_header(client):
    # Cookie-authenticated POST without X-Requested-With must be rejected (S1.7),
    # before any route/storage is touched.
    client.cookies.set("aa_access", "dummy")
    try:
        resp = client.post("/api/projects", json={})
    finally:
        client.cookies.clear()
    assert resp.status_code == 403
    assert "X-Requested-With" in resp.json().get("detail", "")


# --------------------------------------------------------------------------- #
# Plan / trial / publish gating
# --------------------------------------------------------------------------- #
def test_schedule_blocked_when_feature_disabled(monkeypatch):
    _use_storage(monkeypatch, FakeStorage({"allow_scheduling": False}))
    app = _gating_app()
    _use_user(app, {"id": "u1", "role": "user", "subscription_type": "beta"})
    with TestClient(app) as c:
        resp = c.post("/schedule")
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "feature_disabled"


def test_schedule_blocked_when_quota_exhausted(monkeypatch):
    _use_storage(monkeypatch, FakeStorage({"allow_scheduling": True}, consume_ok=False))
    app = _gating_app()
    _use_user(app, {"id": "u1", "role": "user", "subscription_type": "beta"})
    with TestClient(app) as c:
        resp = c.post("/schedule")
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "quota_exceeded"


def test_generate_blocked_when_quota_exhausted(monkeypatch):
    _use_storage(monkeypatch, FakeStorage({}, consume_ok=False))
    app = _gating_app()
    _use_user(app, {"id": "u1", "role": "user", "subscription_type": "beta"})
    with TestClient(app) as c:
        resp = c.post("/generate")
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "quota_exceeded"


def test_generate_allowed_within_quota(monkeypatch):
    _use_storage(monkeypatch, FakeStorage({}, consume_ok=True))
    app = _gating_app()
    _use_user(app, {"id": "u1", "role": "user", "subscription_type": "beta"})
    with TestClient(app) as c:
        resp = c.post("/generate")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_expired_trial_blocks_action(monkeypatch):
    past = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    _use_storage(monkeypatch, FakeStorage({}, subscription={"trial_end_date": past}))
    app = _gating_app()
    _use_user(app, {"id": "u1", "role": "user", "subscription_type": "beta"})
    with TestClient(app) as c:
        resp = c.post("/generate")
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "trial_expired"


def test_admin_bypasses_gating(monkeypatch):
    _use_storage(monkeypatch, FakeStorage({"allow_scheduling": False}, consume_ok=False))
    app = _gating_app()
    _use_user(app, {"id": "admin1", "role": "admin", "subscription_type": "beta"})
    with TestClient(app) as c:
        resp = c.post("/schedule")
    assert resp.status_code == 200
