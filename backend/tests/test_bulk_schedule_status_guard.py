"""Unit test for the status check `bulk_schedule_articles` relies on to reject
already-published/already-scheduled articles (see `articles.py`'s bulk-schedule
validation loop, right after the "Article not found" check).

The full route has heavy storage/plan-gatekeeper dependencies; the actual new logic
is a direct call to the existing, already-tested-by-production-use
`_derive_listing_status` helper, so this tests that helper's four relevant outcomes
directly rather than standing up a fake storage layer for the whole route.
"""

from __future__ import annotations

import os

os.environ.setdefault("FORCE_JSON_STORAGE", "1")
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")
os.environ.setdefault("ENVIRONMENT", "test")

from app.api.routes.articles import _derive_listing_status


def test_pending_article_is_schedulable() -> None:
    assert _derive_listing_status({"status": "pending"}) == "pending"


def test_draft_article_is_schedulable() -> None:
    assert _derive_listing_status({"status": "draft"}) == "draft"


def test_published_article_is_not_schedulable() -> None:
    assert _derive_listing_status({"status": "published"}) == "published"


def test_scheduled_article_is_not_schedulable() -> None:
    # "scheduled" is derived from wp_scheduled_at being set, not a raw status value.
    assert _derive_listing_status({"status": "pending", "wp_scheduled_at": "2030-01-01 09:00:00"}) == "scheduled"
