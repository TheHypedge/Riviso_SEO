"""
RankMonitorService — Feature 4 (Rank Monitoring & Smart Refresh).

v1 ships:

- :meth:`upsert_for_article` — call from article generation / publish to register the
  monitor row with a ``next_check_at`` 30 days from publication.
- :meth:`mark_status` — manual flip used by the "Mark stale" / "Mark fresh" UI.
- :meth:`due_monitors` — read-only sweep helper for the scheduler hook (no-op in v1).
- :meth:`refresh_article` — surface the eventual one-click "Smart Refresh" entry point;
  raises ``NotImplementedError`` until the SERP-diff + regeneration pipeline lands.

The actual SERP-shift detection is intentionally not in this PR — it requires a SERP
data source decision (research module simulator vs. paid API) that we want to make
together. The schema, API surface, and UI badges go in now so the rollout is incremental.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from app.legacy.storage import get_legacy_storage_module


log = logging.getLogger(__name__)


_DEFAULT_INTERVAL_DAYS = 30


def _now_iso_seconds() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")


def _next_check_iso(*, days_from_now: int = _DEFAULT_INTERVAL_DAYS) -> str:
    return (datetime.utcnow() + timedelta(days=days_from_now)).strftime("%Y-%m-%d %H:%M:%S")


class RankMonitorService:
    def __init__(self, *, project: dict[str, Any]) -> None:
        self.project = project
        self.project_id = (project.get("id") or "").strip()

    # ----- bookkeeping (working in v1) ----------------------------------------

    def upsert_for_article(self, article: dict[str, Any]) -> dict[str, Any]:
        """
        Register / refresh a monitor row for ``article``. Idempotent.

        Should be called immediately after a successful WordPress publish so the
        article's ``wp_link`` is present.
        """
        st = get_legacy_storage_module()
        return st.upsert_content_monitor(
            {
                "project_id": self.project_id,
                "article_id": (article.get("id") or "").strip(),
                "url": (article.get("wp_link") or "").strip(),
                "status": "fresh",  # newly-published content is fresh by definition
                "score": "",
                "signature": "",
                "last_checked_at": _now_iso_seconds(),
                "next_check_at": _next_check_iso(),
            }
        )

    def mark_status(self, *, article_id: str, status: str) -> dict[str, Any]:
        """Manual override: ``status`` must be one of ``fresh``, ``stale``, ``unknown``."""
        s = (status or "").strip().lower()
        if s not in {"fresh", "stale", "unknown"}:
            raise ValueError("status must be one of fresh|stale|unknown")
        st = get_legacy_storage_module()
        return st.upsert_content_monitor(
            {
                "project_id": self.project_id,
                "article_id": article_id,
                "url": "",
                "status": s,
                "score": "",
                "signature": "",
                "last_checked_at": _now_iso_seconds(),
                "next_check_at": _next_check_iso(days_from_now=_DEFAULT_INTERVAL_DAYS),
            }
        )

    def list_for_project(self, *, status: str | None = None) -> list[dict[str, Any]]:
        st = get_legacy_storage_module()
        return st.list_content_monitors_for_project(self.project_id, status=status)

    # ----- scheduler sweep helper --------------------------------------------

    @staticmethod
    def due_monitors(*, before_iso: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        st = get_legacy_storage_module()
        cutoff = before_iso or _now_iso_seconds()
        return st.list_due_content_monitors(before_iso=cutoff, limit=limit)

    # ----- smart refresh (skeleton) -------------------------------------------

    async def refresh_article(self, *, article_id: str) -> dict[str, Any]:
        """One-click refresh — regenerate the article body using updated SERP signals."""
        raise NotImplementedError(
            "RankMonitorService.refresh_article is scheduled for the next iteration. "
            "The schema, monitor lifecycle, and 'Mark stale' API are all in place; the "
            "SERP-diff + regeneration pipeline lands in the follow-up PR."
        )
