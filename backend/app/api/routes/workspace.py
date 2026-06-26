"""Cross-project workspace overview for the dashboard."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from app.api.routes.articles import _derive_listing_status
from app.core.deps import get_current_user
from app.schemas.workspace import (
    FilteredStats,
    ProjectSummary,
    WorkspaceActivityDay,
    WorkspaceFeedItem,
    WorkspaceOverviewResponse,
    WorkspaceOverviewStats,
)
from app.services.mongo_listings_async import fetch_workspace_overview_bundle

router = APIRouter(prefix="/workspace", tags=["workspace"])
log = logging.getLogger(__name__)

_FEED_LIMIT = 10
_UPCOMING_LIMIT = 10


def _parse_ms(raw: str | None) -> float:
    if not raw:
        return 0.0
    try:
        t = datetime.fromisoformat(str(raw).replace("Z", "+00:00")).timestamp()
        return t if t > 0 else 0.0
    except Exception:
        return 0.0


def _parse_date_range(start_date: str | None, end_date: str | None) -> tuple[datetime, datetime]:
    """Return (start_dt, end_dt) in UTC. Defaults to last 14 days."""
    utc = timezone.utc
    today = datetime.now(utc).replace(hour=0, minute=0, second=0, microsecond=0)

    if end_date:
        try:
            ed = datetime.strptime(end_date.strip(), "%Y-%m-%d").replace(tzinfo=utc)
        except ValueError:
            ed = today
    else:
        ed = today

    end_dt = ed.replace(hour=23, minute=59, second=59, microsecond=999999)

    if start_date:
        try:
            sd = datetime.strptime(start_date.strip(), "%Y-%m-%d").replace(tzinfo=utc)
        except ValueError:
            sd = today - timedelta(days=13)
    else:
        sd = today - timedelta(days=13)

    return sd, end_dt


def _compute_filtered_stats(
    raw_articles: list[dict],
    start_dt: datetime,
    end_dt: datetime,
) -> FilteredStats:
    utc = timezone.utc
    stats = FilteredStats(
        period_start=start_dt.strftime("%Y-%m-%d"),
        period_end=end_dt.strftime("%Y-%m-%d"),
    )
    for a in raw_articles:
        if not isinstance(a, dict):
            continue
        status = _derive_listing_status(a)

        # Use created_at to place article in time for all status types.
        # For published articles, use posted_at so the KPI reflects publishing activity.
        if status == "published":
            date_raw = a.get("posted_at") or a.get("updated_at") or a.get("created_at")
        else:
            date_raw = a.get("created_at") or a.get("updated_at")

        if not date_raw:
            continue

        ms = _parse_ms(str(date_raw))
        if not ms:
            continue

        try:
            dt = datetime.fromtimestamp(ms, tz=utc)
        except Exception:
            continue

        if not (start_dt <= dt <= end_dt):
            continue

        stats.total_articles += 1
        if status == "published":
            stats.published += 1
        elif status == "pending":
            stats.pending += 1
        elif status == "draft":
            stats.draft += 1

    return stats


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
    start_dt: datetime,
    end_dt: datetime,
) -> list[WorkspaceActivityDay]:
    # Build daily buckets spanning the full date range
    keys: list[str] = []
    buckets: dict[str, dict[str, int | str]] = {}
    cur = start_dt.replace(hour=0, minute=0, second=0, microsecond=0)
    end_day = end_dt.replace(hour=0, minute=0, second=0, microsecond=0)
    while cur <= end_day:
        key = cur.strftime("%Y-%m-%d")
        keys.append(key)
        buckets[key] = {"date": key, "published": 0, "pending": 0, "scheduled": 0}
        cur += timedelta(days=1)

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
async def workspace_overview(
    start_date: str | None = None,
    end_date: str | None = None,
    project_ids: str | None = None,
    user: dict = Depends(get_current_user),
) -> WorkspaceOverviewResponse:
    uid = (user.get("id") or "").strip()
    bundle = await fetch_workspace_overview_bundle(uid, article_limit=1500)
    all_by_id: dict[str, dict] = bundle.get("projects_by_id") or {}
    all_pids: list[str] = bundle.get("pids") or []

    if not all_pids:
        return WorkspaceOverviewResponse(stats=WorkspaceOverviewStats(), activity_series=[])

    # Parse date range (defaults to last 14 days)
    start_dt, end_dt = _parse_date_range(start_date, end_date)

    # Compute comparison period (same duration, immediately before)
    duration_days = (end_dt.date() - start_dt.date()).days + 1
    comp_end = start_dt - timedelta(seconds=1)
    comp_start_date = comp_end.date() - timedelta(days=duration_days - 1)
    comp_start_dt = datetime(comp_start_date.year, comp_start_date.month, comp_start_date.day, tzinfo=timezone.utc)
    comp_end_dt = datetime(comp_end.year, comp_end.month, comp_end.day, 23, 59, 59, tzinfo=timezone.utc)

    # Apply project filter
    requested_pids: set[str] | None = None
    if project_ids:
        requested_pids = {p.strip() for p in project_ids.split(",") if p.strip()}

    pids = [p for p in all_pids if requested_pids is None or p in requested_pids]
    pids_set = set(pids)

    # Filter by_id to only selected projects so downstream pid-in-by_id checks work correctly
    by_id = {pid: proj for pid, proj in all_by_id.items() if pid in pids_set}

    raw_articles: list[dict] = [
        a for a in (bundle.get("articles") or [])
        if isinstance(a, dict) and (a.get("project_id") or "").strip() in pids_set
    ]

    # Compute filtered and comparison stats
    filtered_stats = _compute_filtered_stats(raw_articles, start_dt, end_dt)
    comparison_stats = _compute_filtered_stats(raw_articles, comp_start_dt, comp_end_dt)

    # Compute lifetime stats
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

    # Per-project summary
    proj_pub: dict[str, int] = {}
    proj_pend: dict[str, int] = {}
    proj_draft: dict[str, int] = {}
    proj_total: dict[str, int] = {}
    proj_last: dict[str, float] = {}

    for a in raw_articles:
        if not isinstance(a, dict):
            continue
        pid = (a.get("project_id") or "").strip()
        if not pid or pid not in by_id:
            continue
        st = _derive_listing_status(a)
        proj_total[pid] = proj_total.get(pid, 0) + 1
        act_ms = _parse_ms((a.get("posted_at") or a.get("updated_at") or a.get("created_at") or ""))
        if act_ms and act_ms > proj_last.get(pid, 0):
            proj_last[pid] = act_ms
        if st == "published":
            proj_pub[pid] = proj_pub.get(pid, 0) + 1
        elif st == "pending":
            proj_pend[pid] = proj_pend.get(pid, 0) + 1
        elif st == "draft":
            proj_draft[pid] = proj_draft.get(pid, 0) + 1

    proj_sched: dict[str, int] = {}
    for _, item in (upcoming or []):
        if item.project_id:
            proj_sched[item.project_id] = proj_sched.get(item.project_id, 0) + 1

    project_summaries: list[ProjectSummary] = []
    for pid in pids:
        proj = by_id.get(pid) or {}
        last_ts = proj_last.get(pid)
        last_at: str | None = None
        if last_ts:
            try:
                last_at = datetime.fromtimestamp(last_ts, tz=timezone.utc).isoformat()
            except Exception:
                pass
        project_summaries.append(ProjectSummary(
            project_id=pid,
            name=str(proj.get("name") or "").strip() or pid,
            website_url=(proj.get("website_url") or None),
            platform=(proj.get("platform") or None),
            published=proj_pub.get(pid, 0),
            pending=proj_pend.get(pid, 0),
            draft=proj_draft.get(pid, 0),
            upcoming_scheduled=proj_sched.get(pid, 0),
            total_articles=proj_total.get(pid, 0),
            last_activity_at=last_at,
        ))
    project_summaries.sort(key=lambda x: x.published, reverse=True)

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

    activity_series = _build_activity_series(raw_articles, scheduled_run_ats, start_dt, end_dt)

    return WorkspaceOverviewResponse(
        stats=stats,
        filtered_stats=filtered_stats,
        comparison_stats=comparison_stats,
        date_range_start=start_dt.strftime("%Y-%m-%d"),
        date_range_end=end_dt.strftime("%Y-%m-%d"),
        activity_series=activity_series,
        upcoming_scheduled=[x[1] for x in upcoming[:_UPCOMING_LIMIT]],
        recently_published=take(published_rows, "published", _FEED_LIMIT),
        pending=take(pending_rows, "pending", _FEED_LIMIT),
        drafts=take(draft_rows, "draft", _FEED_LIMIT),
        project_summaries=project_summaries,
    )
