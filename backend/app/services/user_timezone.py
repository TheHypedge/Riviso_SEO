from __future__ import annotations

import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

# Deprecated / legacy IANA names still seen in browsers and older profiles.
_IANA_ALIASES: dict[str, str] = {
    "asia/calcutta": "Asia/Kolkata",
    "asia/saigon": "Asia/Ho_Chi_Minh",
    "asia/choibalsan": "Asia/Ulaanbaatar",
}


def normalize_user_timezone(tz_name: str | None) -> str:
    raw = (tz_name or "").strip()
    if not raw:
        return "UTC"
    key = raw.lower()
    return _IANA_ALIASES.get(key, raw)


def zoneinfo_for_user(tz_name: str | None) -> ZoneInfo:
    n = normalize_user_timezone(tz_name)
    try:
        return ZoneInfo(n)
    except Exception:
        return ZoneInfo("UTC")


def parse_schedule_input_to_utc(raw: str, *, user_tz: ZoneInfo) -> datetime:
    """
    Parse schedule time from the client.

    - If the value includes a timezone offset or Z, interpret as that instant in UTC.
    - Otherwise treat as a wall-clock time in the user's profile timezone (IANA).
    """
    v = (raw or "").strip()
    if not v:
        raise ValueError("Missing schedule time")

    candidate = v.replace(" ", "T").strip()
    # ISO-8601 with offset or Z (advanced clients)
    if candidate.endswith("Z") or re.search(r"[+-]\d{2}:\d{2}$", candidate):
        try:
            dt = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
            if dt.tzinfo is not None:
                return dt.astimezone(timezone.utc)
        except ValueError:
            pass

    norm_local = v.replace("T", " ").strip()
    if len(norm_local) == 16:
        norm_local = norm_local + ":00"
    norm_local = norm_local[:19]
    naive_local = datetime.strptime(norm_local, "%Y-%m-%d %H:%M:%S")
    return naive_local.replace(tzinfo=user_tz).astimezone(timezone.utc)
