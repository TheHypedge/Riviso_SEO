"""Regression: a manual status change on a scheduled article must survive a reload.

change_status used to write only ``status``; ``wp_scheduled_at`` stayed set, so both the
list route and the persisted ``listing_status`` re-derived "scheduled" on the next load.
It now applies the same schedule-clearing fields as cancelling the job."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
os.environ.setdefault("FORCE_JSON_STORAGE", "1")
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")
os.environ.setdefault("ENVIRONMENT", "test")

import storage as storage_module
from app.api.routes.articles import _derive_listing_status
from app.api.routes.scheduled_jobs import _cleared_article_schedule_fields

SCHEDULED = {"id": "a1", "project_id": "p1", "status": "pending", "wp_scheduled_at": "2026-11-01 08:00:00"}


def test_scheduled_article_derives_scheduled() -> None:
    assert _derive_listing_status(SCHEDULED) == "scheduled"


def test_manual_status_change_sticks_after_reload() -> None:
    for ns in ("pending", "draft", "published"):
        row = {**SCHEDULED, **_cleared_article_schedule_fields(), "status": ns}
        assert _derive_listing_status(row) == ns
        assert storage_module._derive_article_listing_status(row) == ns
