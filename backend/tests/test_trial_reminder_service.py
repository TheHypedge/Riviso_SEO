"""Self-check for check_trial_milestones' notification payload -- it used to omit
"id" entirely and send "message" instead of "body", so storage.insert_notification
raised ValueError("notification id is required") on every single call (100%
failure rate, once per milestone per trial user, every hour)."""

import asyncio
from datetime import datetime, timedelta, timezone

from app.services.trial_reminder_service import check_trial_milestones


class _FakeStorage:
    def __init__(self, users, subs):
        self._users = users
        self._subs = subs
        self.inserted: list[dict] = []
        self.patched: list[tuple[str, dict]] = []

    def list_users(self):
        return self._users

    def get_trial_plan_key(self):
        return "beta"

    def get_subscription_by_user_id(self, uid):
        return self._subs.get(uid)

    def insert_notification(self, data):
        if not (data.get("id") or "").strip():
            raise ValueError("notification id is required")
        self.inserted.append(data)

    def patch_subscription_fields(self, uid, fields):
        self.patched.append((uid, fields))


def test_milestone_notification_has_id_and_body_not_message():
    trial_end = (datetime.now(timezone.utc) + timedelta(days=2, hours=1)).strftime("%Y-%m-%d %H:%M:%S")
    st = _FakeStorage(
        users=[{"id": "u1", "subscription_type": "beta"}],
        subs={"u1": {"trial_end_date": trial_end, "trial_notified_milestones": ["7d"]}},
    )

    asyncio.run(check_trial_milestones(st))

    assert len(st.inserted) == 1
    row = st.inserted[0]
    assert row["id"]
    assert row["user_id"] == "u1"
    assert row["body"]
    assert "message" not in row
    assert st.patched == [("u1", {"trial_notified_milestones": ["7d", "3d"]})]


if __name__ == "__main__":
    test_milestone_notification_has_id_and_body_not_message()
    print("ok")
