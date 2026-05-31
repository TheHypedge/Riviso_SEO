"""UTC midnight reset for subscription daily usage counters."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from app.legacy.storage import get_legacy_storage_module

log = logging.getLogger(__name__)


def _seconds_until_next_utc_midnight() -> float:
    now = datetime.now(timezone.utc)
    tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return max(30.0, (tomorrow - now).total_seconds())


async def subscription_daily_reset_loop() -> None:
    """Background loop: reset ``articlesGeneratedToday`` at each UTC midnight."""
    log.info("Subscription daily reset loop started")
    while True:
        await asyncio.sleep(_seconds_until_next_utc_midnight())
        st = get_legacy_storage_module()
        if not hasattr(st, "reset_daily_subscription_usage"):
            continue
        try:
            n = await asyncio.to_thread(st.reset_daily_subscription_usage)
            log.info("Subscription daily usage reset complete (rows=%s)", n)
        except Exception:
            log.exception("Subscription daily usage reset failed")
