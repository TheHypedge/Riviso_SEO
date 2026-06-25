"""
Trial reminder service — fires in-app notifications at subscription milestones.

Called from the scheduler loop approximately once per hour.
Milestones: 7 days, 3 days, 1 day remaining, and expired.
Each milestone fires once per user (tracked in subscription.trial_notified_milestones).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)

_MILESTONES = [
    ("7d", 7, "Your Riviso trial ends in one week. Upgrade to keep all premium features."),
    ("3d", 3, "Only three days of premium access remaining. Upgrade today to avoid interruption."),
    ("1d", 1, "Your trial expires today. Upgrade now to keep your projects and content."),
    ("expired", 0, "Your Riviso trial has expired. Upgrade your subscription to regain access."),
]


def _parse_iso(raw: str | None) -> datetime | None:
    s = (raw or "").strip()
    if not s:
        return None
    try:
        s2 = s.replace(" ", "T")
        if not s2.endswith("Z") and "+" not in s2[10:]:
            s2 += "Z"
        s2 = s2.replace("Z", "+00:00")
        return datetime.fromisoformat(s2)
    except Exception:
        return None


def _remaining_days(trial_end_date: str | None) -> int | None:
    """Return whole days remaining, or None if no trial end date."""
    end = _parse_iso(trial_end_date)
    if end is None:
        return None
    delta = end - datetime.now(timezone.utc)
    return max(-1, int(delta.total_seconds() // 86400))


async def check_trial_milestones(st) -> None:
    """
    Check all users on trial plans and insert in-app notifications for
    approaching milestones. Each milestone fires at most once per user.
    """
    from app.services.to_thread import run_sync

    try:
        users = await run_sync(st.list_users) if hasattr(st, "list_users") else []
    except Exception as exc:
        log.warning("trial_reminder: could not load users: %s", exc)
        return

    trial_plan_key = None
    try:
        trial_plan_key = (st.get_trial_plan_key() if hasattr(st, "get_trial_plan_key") else None)
    except Exception:
        pass

    if not trial_plan_key:
        return

    for user in (users or []):
        if not isinstance(user, dict):
            continue
        uid = (user.get("id") or "").strip()
        plan = (user.get("subscription_type") or "").strip().lower()
        if not uid or plan != trial_plan_key:
            continue

        # Load subscription for this user
        try:
            sub = await run_sync(st.get_subscription_by_user_id, uid)
        except Exception:
            continue

        if not isinstance(sub, dict):
            continue

        trial_end = sub.get("trial_end_date")
        if not trial_end:
            continue

        days_left = _remaining_days(trial_end)
        if days_left is None:
            continue

        notified: list[str] = sub.get("trial_notified_milestones") or []
        if not isinstance(notified, list):
            notified = []

        new_milestones: list[str] = []

        for key, threshold, msg in _MILESTONES:
            if key in notified:
                continue
            # Fire this milestone?
            if key == "expired":
                if days_left < 0:
                    new_milestones.append((key, msg))
            else:
                if days_left <= threshold:
                    new_milestones.append((key, msg))

        if not new_milestones:
            continue

        for key, msg in new_milestones:
            try:
                await run_sync(
                    st.insert_notification,
                    {
                        "user_id": uid,
                        "type": "trial_reminder",
                        "title": "Trial reminder",
                        "message": msg,
                        "read": False,
                    },
                )
                notified.append(key)
                log.info("trial_reminder: notified user %s milestone=%s", uid, key)
            except Exception as exc:
                log.warning("trial_reminder: failed to insert notification uid=%s key=%s: %s", uid, key, exc)

        if notified != (sub.get("trial_notified_milestones") or []):
            try:
                await run_sync(
                    st.patch_subscription_fields,
                    uid,
                    {"trial_notified_milestones": notified},
                )
            except Exception as exc:
                log.warning("trial_reminder: failed to save milestones uid=%s: %s", uid, exc)
