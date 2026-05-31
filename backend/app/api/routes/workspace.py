"""Cross-project workspace overview for the dashboard."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from app.api.routes.articles import _derive_listing_status
from app.core.deps import get_current_user
from app.schemas.workspace import (
    WorkspaceActivityDay,
    WorkspaceFeedItem,
    WorkspaceOverviewResponse,
    WorkspaceOverviewStats,
)
from app.services.mongo_listings_async import fetch_workspace_overview_bundle

router = APIRouter(prefix="/workspace", tags=["workspace"])
log = logging.getLogger(__name__)

_FEED_LIMIT = 6
_UPCOMING_LIMIT = 6
_ACTIVITY_DAYS = 14


def _parse_ms(raw: str | None) -> float:
    if not raw:
        return 0.0
    try:
        t = datetime.fromisoformat(str(raw).replace("Z", "+00:00")).timestamp()
        return t if t > 0 else 0.0
    except Exception:
        return 0.0


def _article_feed_item(a: dict, *, by_id: dict[str, dict], status_tag: str, sort_at: str | None) -> WorkspaceFeedItem | None:
    aid = (a.get("id") or "").strip()
    pid = (a.get("project_id") or "").strip()
    if not aid or not pid:
        return None
    pname = str((by_id.get(pid) or {}).get("name") or "").strip() or pid
    title = (str(a.get("title") or "").strip() or "(Untitled)")
    img = (str(a.get("image_url") or "").strip() or None)
    return WorkspaceFeedItem(
        id=aid,
        article_id=aid,
        project_id=pid,
        project_name=pname,
        title=title,
        status_tag=status_tag,
        sort_at=(sort_at or "").strip() or None,
        image_url=img,
    )


def _day_key_from_ms(ms: float) -> str | None:
    if not ms:
        return None
    return datetime.fromtimestamp(ms, tz=timezone.utc).strftime("%Y-%m-%d")


def _build_activity_series(
    raw_articles: list[dict],
    scheduled_run_ats: list[str],
) -> list[WorkspaceActivityDay]:
    end = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    keys: list[str] = []
    buckets: dict[str, dict[str, int | str]] = {}
    for i in range(_ACTIVITY_DAYS - 1, -1, -1):
        day = end - timedelta(days=i)
        key = day.strftime("%Y-%m-%d")
        keys.append(key)
        buckets[key] = {"date": key, "published": 0, "pending": 0, "scheduled": 0}

    for a in raw_articles:
        if not isinstance(a, dict):
            continue
        status = _derive_listing_status(a)
        if status == "published":
            ms = _parse_ms((a.get("posted_at") or a.get("updated_at") or a.get("created_at") or ""))
            key = _day_key_from_ms(ms)
            if key in buckets:
                buckets[key]["published"] = int(buckets[key]["published"]) + 1
        elif status == "pending":
            ms = _parse_ms((a.get("updated_at") or a.get("created_at") or ""))
            key = _day_key_from_ms(ms)
            if key in buckets:
                buckets[key]["pending"] = int(buckets[key]["pending"]) + 1
        elif status == "scheduled":
            ms = _parse_ms((a.get("wp_scheduled_at") or a.get("updated_at") or a.get("created_at") or ""))
            key = _day_key_from_ms(ms)
            if key in buckets:
                buckets[key]["scheduled"] = int(buckets[key]["scheduled"]) + 1

    for run_at in scheduled_run_ats:
        ms = _parse_ms(run_at)
        key = _day_key_from_ms(ms)
        if key in buckets:
            buckets[key]["scheduled"] = int(buckets[key]["scheduled"]) + 1

    return [
        WorkspaceActivityDay(
            date=str(buckets[k]["date"]),
            published=int(buckets[k]["published"]),
            pending=int(buckets[k]["pending"]),
            scheduled=int(buckets[k]["scheduled"]),
        )
        for k in keys
    ]


@router.get("/overview", response_model=WorkspaceOverviewResponse)
async def workspace_overview(user: dict = Depends(get_current_user)) -> WorkspaceOverviewResponse:
    uid = (user.get("id") or "").strip()
    bundle = await fetch_workspace_overview_bundle(uid, article_limit=1500)
    by_id: dict[str, dict] = bundle.get("projects_by_id") or {}
    pids: list[str] = bundle.get("pids") or []
    if not pids:
        return WorkspaceOverviewResponse(stats=WorkspaceOverviewStats(), activity_series=[])

    raw_articles: list[dict] = bundle.get("articles") or []

    title_by_id: dict[str, str] = {}
    published_rows: list[tuple[float, dict]] = []
    pending_rows: list[tuple[float, dict]] = []
    draft_rows: list[tuple[float, dict]] = []
    stats = WorkspaceOverviewStats(project_count=len(pids))

    for a in raw_articles:
        if not isinstance(a, dict):
            continue
        aid = (a.get("id") or "").strip()
        if aid:
            title_by_id[aid] = (str(a.get("title") or "").strip() or "(Untitled)")
        status = _derive_listing_status(a)
        stats.total_articles += 1
        if status == "published":
            stats.published += 1
            sort_ms = _parse_ms((a.get("posted_at") or a.get("updated_at") or a.get("created_at") or ""))
            published_rows.append((sort_ms, a))
        elif status == "pending":
            stats.pending += 1
            sort_ms = _parse_ms((a.get("updated_at") or a.get("created_at") or ""))
            pending_rows.append((sort_ms, a))
        elif status == "draft":
            stats.draft += 1
            sort_ms = _parse_ms((a.get("updated_at") or a.get("created_at") or ""))
            draft_rows.append((sort_ms, a))
        elif status == "scheduled":
            stats.scheduled += 1

    now_ms = datetime.now(timezone.utc).timestamp()
    upcoming: list[tuple[float, WorkspaceFeedItem]] = []
    seen_job_article: set[tuple[str, str]] = set()
    scheduled_run_ats: list[str] = []

    for j in bundle.get("scheduled_jobs") or []:
        if not isinstance(j, dict):
            continue
        pid = (j.get("project_id") or "").strip()
        if pid not in by_id:
            continue
        st_state = (j.get("state") or "").strip().lower()
        if st_state in {"cancelled", "completed", "failed", "posted"}:
            continue
        run_at = (j.get("run_at") or "").strip()
        if run_at:
            scheduled_run_ats.append(run_at)
        run_ms = _parse_ms(run_at)
        if run_ms and run_ms < now_ms - 86_400:
            continue
        aid = (j.get("article_id") or "").strip()
        if not aid:
            continue
        jid = (j.get("id") or "").strip() or f"{pid}:{aid}:{run_at}"
        key = (pid, aid)
        if key in seen_job_article:
            continue
        seen_job_article.add(key)
        pname = str((by_id.get(pid) or {}).get("name") or "").strip() or pid
        title = title_by_id.get(aid) or "(Scheduled article)"
        upcoming.append(
            (
                run_ms or now_ms,
                WorkspaceFeedItem(
                    id=jid,
                    article_id=aid,
                    project_id=pid,
                    project_name=pname,
                    title=title,
                    status_tag="scheduled",
                    sort_at=run_at or None,
                ),
            ),
        )

    upcoming.sort(key=lambda x: (x[0], x[1].title.lower()))
    stats.upcoming_scheduled = len(upcoming)

    published_rows.sort(key=lambda x: x[0], reverse=True)
    pending_rows.sort(key=lambda x: x[0], reverse=True)
    draft_rows.sort(key=lambda x: x[0], reverse=True)

    def take(rows: list[tuple[float, dict]], tag: str, limit: int) -> list[WorkspaceFeedItem]:
        out: list[WorkspaceFeedItem] = []
        for _ms, row in rows[:limit]:
            sort_raw = (
                (row.get("posted_at") or row.get("updated_at") or row.get("created_at") or "")
                if tag == "published"
                else (row.get("updated_at") or row.get("created_at") or "")
            )
            item = _article_feed_item(row, by_id=by_id, status_tag=tag, sort_at=str(sort_raw).strip() or None)
            if item:
                out.append(item)
        return out

    activity_series = _build_activity_series(raw_articles, scheduled_run_ats)

    return WorkspaceOverviewResponse(
        stats=stats,
        activity_series=activity_series,
        upcoming_scheduled=[x[1] for x in upcoming[:_UPCOMING_LIMIT]],
        recently_published=take(published_rows, "published", _FEED_LIMIT),
        pending=take(pending_rows, "pending", _FEED_LIMIT),
        drafts=take(draft_rows, "draft", _FEED_LIMIT),
    )
