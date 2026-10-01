"""Self-check for check_linkedin_reconnect_reminders: fires once per connection within
the 7-day window, never re-fires once linkedin_reconnect_notified is set, and ignores
projects that aren't connected or aren't close to expiry."""

import asyncio
import time

from app.services.linkedin_reconnect_service import check_linkedin_reconnect_reminders


class _FakeStorage:
    def __init__(self, projects):
        self._projects = projects
        self.inserted: list[dict] = []
        self.patched: list[tuple[str, dict]] = []

    def load_projects(self):
        return self._projects

    def insert_notification(self, data):
        self.inserted.append(data)

    def update_project_fields(self, pid, fields):
        self.patched.append((pid, fields))


def test_notifies_project_expiring_within_a_week():
    soon = str(int(time.time()) + 3 * 24 * 3600)
    st = _FakeStorage([
        {"id": "p1", "owner_user_id": "u1", "name": "Acme Blog", "linkedin_token_expires_at": soon, "linkedin_reconnect_notified": False},
    ])

    asyncio.run(check_linkedin_reconnect_reminders(st))

    assert len(st.inserted) == 1
    assert st.inserted[0]["user_id"] == "u1"
    assert st.inserted[0]["data"] == {"project_id": "p1"}
    assert st.patched == [("p1", {"linkedin_reconnect_notified": True})]


def test_skips_already_notified_and_not_connected_and_far_future():
    far = str(int(time.time()) + 30 * 24 * 3600)
    st = _FakeStorage([
        {"id": "p2", "owner_user_id": "u2", "linkedin_token_expires_at": "", "linkedin_reconnect_notified": False},
        {"id": "p3", "owner_user_id": "u3", "linkedin_token_expires_at": far, "linkedin_reconnect_notified": False},
        {"id": "p4", "owner_user_id": "u4", "linkedin_token_expires_at": str(int(time.time()) + 3600), "linkedin_reconnect_notified": True},
    ])

    asyncio.run(check_linkedin_reconnect_reminders(st))

    assert st.inserted == []
    assert st.patched == []


if __name__ == "__main__":
    test_notifies_project_expiring_within_a_week()
    test_skips_already_notified_and_not_connected_and_far_future()
    print("ok")
