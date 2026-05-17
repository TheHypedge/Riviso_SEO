"""Shared schedule lead-time rules for API validation."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

# Typical prep window (content + image + WP) — documented for operators.
SCHEDULE_PREP_MINUTES = 7
# Minimum lead time users may select (datetime-local minute slots).
SCHEDULE_BUFFER_MINUTES = 10
# Default: start background prep this many minutes before ``run_at`` (overridable via env).
DEFAULT_SCHEDULE_PREP_LEAD_MINUTES = 45


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


def _parse_run_at_utc_str(raw: str) -> datetime | None:
    s = (raw or "").strip().replace("T", " ")[:19]
    if len(s) < 16:
        return None
    try:
        dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
        return dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def prep_lead_minutes_from_settings() -> int:
    try:
        from app.core.config import settings

        n = int(getattr(settings, "schedule_prep_lead_minutes", DEFAULT_SCHEDULE_PREP_LEAD_MINUTES) or 0)
        return max(SCHEDULE_PREP_MINUTES, min(n, 24 * 60))
    except Exception:
        return DEFAULT_SCHEDULE_PREP_LEAD_MINUTES


def is_within_scheduled_prep_window(run_at_utc_str: str, *, now: datetime | None = None) -> bool:
    """
    True when background content/image prep should run for this job.

    Prep starts at ``run_at - lead`` so far-future bulk schedules stay ``scheduled``
    until the publish window approaches.
    """
    run_at = _parse_run_at_utc_str(run_at_utc_str)
    if not run_at:
        return False
    ref = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(second=0, microsecond=0)
    lead = timedelta(minutes=prep_lead_minutes_from_settings())
    return run_at - lead <= ref


def prep_dispatch_before_utc_str(*, now: datetime | None = None) -> str:
    """UTC wall string: jobs with ``run_at`` on or before this need prep consideration."""
    ref = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(second=0, microsecond=0)
    return (ref + timedelta(minutes=prep_lead_minutes_from_settings())).strftime("%Y-%m-%d %H:%M:%S")
