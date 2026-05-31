from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.services.plan_gatekeeper import build_subscription_status, is_trial_expired


def test_is_trial_expired_when_end_in_past():
    user = {"id": "u1", "role": "user"}
    end = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    sub = {"trial_end_date": end}
    assert is_trial_expired(user=user, subscription=sub) is True


def test_admin_never_expired():
    user = {"id": "a1", "role": "admin"}
    end = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    sub = {"trial_end_date": end}
    assert is_trial_expired(user=user, subscription=sub) is False


def test_build_subscription_status_remaining_time():
    class _St:
        def load_plans(self):
            return {"beta": {"name": "Beta Plan", "max_projects": 2, "allow_bulk_upload": True, "allow_export": True}}

        def ensure_subscription_for_user(self, user):
            end = datetime.now(timezone.utc) + timedelta(hours=25, minutes=30)
            return {
                "trial_start_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "trial_end_date": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "usage": {"articlesGeneratedToday": 1, "articlesGeneratedThisMonth": 2},
            }

        def get_trial_plan_key(self):
            return "beta"

    user = {"id": "u1", "role": "user", "subscription_type": "beta"}
    payload = build_subscription_status(st=_St(), user=user)
    assert payload["status"] == "active"
    assert payload["remaining_days"] >= 1
    assert payload["features"]["allowBulkUpload"] is True
