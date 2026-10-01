"""
LinkedIn reconnect reminder — LinkedIn's standard OAuth flow issues no refresh token
(~60-day access tokens), so a connected project silently stops being able to post once
its token expires. This fires an in-app notification ~7 days before
`linkedin_token_expires_at`, once per connection (tracked via `linkedin_reconnect_notified`,
reset to False on every fresh connect/reconnect in project_linkedin.py).

Called from the scheduler loop, same cadence as the subscription reconcile check.
"""

from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timezone

log = logging.getLogger(__name__)

_REMINDER_WINDOW_SECONDS = 7 * 24 * 3600


async def check_linkedin_reconnect_reminders(st) -> None:
    from app.services.to_thread import run_sync

    try:
        projects = await run_sync(st.load_projects) if hasattr(st, "load_projects") else []
    except Exception as exc:
        log.warning("linkedin_reconnect: could not load projects: %s", exc)
        return

    now = time.time()

    for proj in (projects or []):
        if not isinstance(proj, dict):
            continue
        expires_at_raw = (proj.get("linkedin_token_expires_at") or "").strip()
        if not expires_at_raw or proj.get("linkedin_reconnect_notified"):
            continue
        try:
            expires_at = int(expires_at_raw)
        except ValueError:
            continue
        if not (now <= expires_at <= now + _REMINDER_WINDOW_SECONDS):
            continue

        pid = (proj.get("id") or "").strip()
        owner_uid = (proj.get("owner_user_id") or "").strip()
        if not pid or not owner_uid:
            continue

        try:
            await run_sync(
                st.insert_notification,
                {
                    "id": str(uuid.uuid4()),
                    "user_id": owner_uid,
                    "type": "linkedin_reconnect_reminder",
                    "title": "LinkedIn connection expiring soon",
                    "body": (
                        f"Your LinkedIn connection for \"{(proj.get('name') or 'your project').strip()}\" "
                        "expires within a week. Reconnect to keep auto-posting working."
                    ),
                    "data": {"project_id": pid},
                    "read": False,
                    "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                },
            )
            await run_sync(st.update_project_fields, pid, {"linkedin_reconnect_notified": True})
            log.info("linkedin_reconnect: notified project %s", pid)
        except Exception as exc:
            log.warning("linkedin_reconnect: failed to notify project %s: %s", pid, exc)
