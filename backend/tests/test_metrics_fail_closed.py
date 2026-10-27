"""Regression (QA run 2026-10-27, PRD-06): GET /metrics was public in production because no
METRICS_TOKEN was set. Production must fail closed (404) without a token."""

import os

os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")

from fastapi.testclient import TestClient

import app.main as main_mod


def test_metrics_hidden_in_production_without_token(monkeypatch):
    monkeypatch.setattr(main_mod.settings, "environment", "production")
    assert TestClient(main_mod.app).get("/metrics").status_code == 404


def test_metrics_open_in_development(monkeypatch):
    monkeypatch.setattr(main_mod.settings, "environment", "development")
    assert TestClient(main_mod.app).get("/metrics").status_code in (200, 503)
