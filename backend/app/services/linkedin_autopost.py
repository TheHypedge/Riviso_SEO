"""LinkedIn auto-post: when a project opts in, every article that goes live gets a LinkedIn
post scheduled `delay` minutes later. It is an ordinary `platform="linkedin"` scheduled job
with no caption, so the existing scheduler generates the caption at run time, attaches the
featured image, posts, and applies its double-post guard -- no new worker."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta

from app.services.to_thread import run_sync

log = logging.getLogger(__name__)

# Offered in Social → LinkedIn → Settings (minutes): 5 min … 24 h.
AUTO_POST_DELAYS_MIN: tuple[int, ...] = (5, 10, 15, 30, 60, 120, 180, 360, 720, 1440)
DEFAULT_DELAY_MIN = 30
_OPEN_STATES = {"scheduled", "posting", "generating", "queued"}


def auto_post_settings(proj: dict) -> tuple[bool, int]:
    enabled = bool(proj.get("linkedin_auto_post_enabled", False))
    try:
        delay = int(proj.get("linkedin_auto_post_delay_minutes") or DEFAULT_DELAY_MIN)
    except (TypeError, ValueError):
        delay = DEFAULT_DELAY_MIN
    return enabled, delay if delay in AUTO_POST_DELAYS_MIN else DEFAULT_DELAY_MIN


async def schedule_after_publish(*, st, proj: dict, article_id: str) -> str | None:
    """Queue the LinkedIn post for a just-published article. Returns the job id, or None when
    auto-post is off, LinkedIn isn't connected, or the article is already shared/queued.
    Never raises -- publishing must not fail because of LinkedIn."""
    try:
        enabled, delay = auto_post_settings(proj)
        pid = (proj.get("id") or "").strip()
        aid = (article_id or "").strip()
        if not enabled or not pid or not aid:
            return None
        if not (proj.get("linkedin_access_token") or "").strip():
            return None
        if not (proj.get("linkedin_selected_author_urn") or proj.get("linkedin_person_urn") or "").strip():
            return None

        art = await run_sync(st.get_article, project_id=pid, article_id=aid)
        if not isinstance(art, dict) or (art.get("linkedin_post_urn") or art.get("linkedin_post_url") or "").strip():
            return None
        jobs = await run_sync(st.load_scheduled_jobs, project_id=pid) if hasattr(st, "load_scheduled_jobs") else []
        if any(
            isinstance(j, dict)
            and (j.get("platform") or "") == "linkedin"
            and (j.get("article_id") or "").strip() == aid
            and (j.get("state") or "scheduled") in _OPEN_STATES
            for j in (jobs or [])
        ):
            return None

        now = datetime.utcnow()
        job_id = str(uuid.uuid4())
        await run_sync(
            st.insert_scheduled_job,
            {
                "id": job_id,
                "project_id": pid,
                "article_id": aid,
                "run_at": (now + timedelta(minutes=delay)).strftime("%Y-%m-%d %H:%M:%S"),
                "state": "scheduled",
                "platform": "linkedin",
                # Empty on purpose: the scheduler writes the caption when the job runs.
                "linkedin_commentary": "",
                "created_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            },
        )
        log.info("LinkedIn auto-post queued project=%s article=%s in %s min", pid, aid, delay)
        return job_id
    except Exception:
        log.exception("LinkedIn auto-post scheduling failed for article=%s", article_id)
        return None
