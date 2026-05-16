"""Shared schedule lead-time rules for API validation."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

# Typical prep window (content + image + WP) — documented for operators.
SCHEDULE_PREP_MINUTES = 7
# Minimum lead time users may select (datetime-local minute slots).
SCHEDULE_BUFFER_MINUTES = 10


def minimum_schedule_utc(now: datetime | None = None) -> datetime:
    """Earliest allowed schedule instant (UTC), truncated to the minute."""
    ref = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    ref = ref.replace(second=0, microsecond=0)
    return ref + timedelta(minutes=SCHEDULE_BUFFER_MINUTES)


def is_schedule_time_allowed(dt_utc: datetime, now: datetime | None = None) -> bool:
    """True when ``dt_utc`` is at or after the minimum buffer (minute precision)."""
    if dt_utc.tzinfo is None:
        dt = dt_utc.replace(tzinfo=timezone.utc)
    else:
        dt = dt_utc.astimezone(timezone.utc)
    dt = dt.replace(second=0, microsecond=0)
    return dt >= minimum_schedule_utc(now)


SCHEDULE_TOO_SOON_MESSAGE = (
    f"Scheduled time must be at least {SCHEDULE_BUFFER_MINUTES} minutes from now"
)
