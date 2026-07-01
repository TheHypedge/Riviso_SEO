from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.core.deps import get_current_user
from app.core.project_lookup import async_require_project_access, require_project_access
from app.legacy.storage import get_legacy_storage_module
from app.repositories import ScheduledJobRepository
from app.schemas.scheduled_jobs import ScheduledJobPublic, ScheduledJobPostNow, ScheduledJobUpdate
from app.services.scheduler import start_scheduled_job_preparation_task, start_scheduled_job_post_now_task
from app.services.user_timezone import parse_schedule_input_to_utc, zoneinfo_for_user
from app.services.schedule_timing import SCHEDULE_TOO_SOON_MESSAGE, is_schedule_time_allowed, minimum_schedule_utc
from app.services.to_thread import run_sync
from app.services.storage_db import call_storage, is_transient_storage_error


router = APIRouter(prefix="/projects/{project_id}/scheduled-jobs", tags=["scheduled"])

_STALE_POSTING_MINUTES = 3


def _parse_job_timestamp(raw: str) -> datetime | None:
    v = (raw or "").strip()
    if not v:
        return None
    try:
        if "T" in v:
            dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        else:
            dt = datetime.strptime(v[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _heal_stale_posting_jobs(*, st, project_id: str, rows: list[dict]) -> list[dict]:
    """
    Reset jobs stuck in ``posting`` with no WordPress post id (crashed worker, tab closed, etc.).
    """
    if not rows or not hasattr(st, "update_scheduled_job_fields"):
        return rows
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=_STALE_POSTING_MINUTES)
    healed: list[dict] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        if (row.get("state") or "").strip().lower() != "posting":
            healed.append(row)
            continue
        if str(row.get("wp_post_id") or "").strip():
            healed.append(row)
            continue
        ts = _parse_job_timestamp(str(row.get("updated_at") or row.get("last_attempt_at") or ""))
        if ts is not None and ts > cutoff:
            healed.append(row)
            continue
        jid = (row.get("id") or "").strip()
        aid = (row.get("article_id") or "").strip()
        if not jid:
            healed.append(row)
            continue
        next_state = "scheduled"
        try:
            art = _find_article_for_job(st=st, project_id=project_id, article_id=aid) if aid else None
            if isinstance(art, dict) and (art.get("title") or "").strip() and (art.get("article") or "").strip():
                next_state = "ready_to_post"
        except Exception:
            pass
        patch = {
            "state": next_state,
            "last_error": "Previous publish attempt did not finish. You can use Post Now again.",
            "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        }
        try:
            st.update_scheduled_job_fields(jid, patch)
            healed.append({**row, **patch})
        except Exception:
            healed.append(row)
    return healed


async def _require_project_access(*, st, user: dict, project_id: str) -> dict:
    # P2.3: use Motor-backed async lookup to keep blocking I/O off the event loop.
    # allow_collaborators=True: scheduling is a content operation shared members must access.
    return await async_require_project_access(user=user, project_id=project_id, full=False, allow_collaborators=True)


def _require_verified_website(proj: dict) -> None:
    plat = (proj.get("platform") or "").strip().lower()
    if plat == "shopify" or bool(proj.get("shopify_connected")) or (proj.get("shopify_shop") or "").strip():
        raise HTTPException(
            status_code=400,
            detail={
                "code": "website_not_connected",
                "message": "Shopify projects can generate drafts, but scheduling/publishing is not enabled yet.",
            },
        )
    if (proj.get("wp_verified_status") or "").strip().lower() != "connected":
        raise HTTPException(
            status_code=400,
            detail={
                "code": "website_not_connected",
                "message": "Website is not connected for this project. Connect and verify WordPress before editing scheduled articles.",
            },
        )


_ACTIVE_SCHEDULED_JOB_STATES = frozenset(
    {
        "scheduled",
        "content_generating",
        "image_generating",
        "ready_to_post",
        "posting",
        "failed",
    }
)


def _scheduled_job_preference(row: ScheduledJobPublic) -> tuple[int, str]:
    st = (row.state or "").strip().lower()
    active = 1 if st in _ACTIVE_SCHEDULED_JOB_STATES else 0
    return active, (row.run_at or "").strip()


def _pick_better_scheduled_job(a: ScheduledJobPublic, b: ScheduledJobPublic) -> ScheduledJobPublic:
    pa = _scheduled_job_preference(a)
    pb = _scheduled_job_preference(b)
    if pa[0] != pb[0]:
        return a if pa[0] > pb[0] else b
    if pa[1] != pb[1]:
        return a if pa[1] > pb[1] else b
    return a


def _dedupe_scheduled_jobs(rows: list[ScheduledJobPublic]) -> list[ScheduledJobPublic]:
    active = [j for j in rows if (j.state or "").strip().lower() != "cancelled"]
    best_by_article: dict[str, ScheduledJobPublic] = {}
    for j in active:
        aid = (j.article_id or "").strip()
        if not aid:
            continue
        cur = best_by_article.get(aid)
        best_by_article[aid] = _pick_better_scheduled_job(cur, j) if cur else j
    out = list(best_by_article.values())
    out.sort(key=lambda x: x.run_at or "", reverse=True)
    return out


def _normalize_article_schedule_run_at(raw: str) -> str:
    v = (raw or "").strip()
    if not v:
        return ""
    if "T" in v:
        return v.replace("T", " ").replace("Z", "").split(".")[0][:19]
    return v[:19]


def _build_scheduled_jobs_board(
    *,
    project_id: str,
    jobs: list[ScheduledJobPublic],
    article_stubs: list[dict],
) -> list[ScheduledJobPublic]:
    merged = _dedupe_scheduled_jobs(jobs)
    have_job = {j.article_id for j in merged if j.article_id}
    extras: list[ScheduledJobPublic] = []
    pid = (project_id or "").strip()
    for a in article_stubs or []:
        if not isinstance(a, dict):
            continue
        aid = (a.get("id") or "").strip()
        run_at = _normalize_article_schedule_run_at(str(a.get("wp_scheduled_at") or ""))
        if not aid or not run_at or aid in have_job:
            continue
        extras.append(
            ScheduledJobPublic(
                id=f"pending_job_{aid}",
                project_id=pid,
                article_id=aid,
                run_at=run_at,
                post_type="posts",
                wp_status="draft",
                category_ids=[],
                state="scheduled",
                attempts=0,
                wp_link=(a.get("wp_link") or "").strip() or None,
            )
        )
    return _dedupe_scheduled_jobs([*merged, *extras])


def _to_public(row: dict) -> ScheduledJobPublic:
    cats: list[int] = []
    raw = (row.get("category_ids") or "").strip()
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            cats.append(int(part))
        except (TypeError, ValueError):
            continue
    cats = list(dict.fromkeys([x for x in cats if x > 0]))[:50]

    return ScheduledJobPublic(
        id=(row.get("id") or "").strip(),
        project_id=(row.get("project_id") or "").strip(),
        article_id=(row.get("article_id") or "").strip(),
        run_at=(row.get("run_at") or "").strip(),
        post_type=(row.get("post_type") or "posts").strip(),
        wp_status=(row.get("wp_status") or "draft").strip(),
        category_ids=cats,
        writing_prompt_id=((row.get("writing_prompt_id") or "").strip() or None),
        image_prompt_id=((row.get("image_prompt_id") or "").strip() or None),
        generate_image=bool(row.get("generate_image", True)),
        state=(row.get("state") or "scheduled").strip(),
        last_error=(row.get("last_error") or "").strip() or None,
        attempts=int(row.get("attempts") or 0),
        last_attempt_at=(row.get("last_attempt_at") or "").strip() or None,
        created_at=(row.get("created_at") or "").strip() or None,
        updated_at=(row.get("updated_at") or "").strip() or None,
        wp_post_id=(str(row.get("wp_post_id") or "").strip() or None),
        wp_link=(row.get("wp_link") or "").strip() or None,
    )

def _cleared_article_schedule_fields() -> dict:
    """Clear WordPress schedule markers and return article to the normal (pending) queue."""
    return {
        "status": "pending",
        "wp_scheduled_at": "",
        "wp_scheduled_at_utc": "",
        "wp_schedule_wp_status": "",
        "wp_schedule_error": "",
        "wp_schedule_batch_id": "",
        "wp_schedule_batch_index": "",
        "wp_schedule_batch_total": "",
        "wp_schedule_state": "",
        "wp_schedule_state_updated_at": "",
        "wp_schedule_next_retry_at": "",
        "wp_schedule_tz_offset_min": "",
    }


def _find_article_for_job(*, st, project_id: str, article_id: str) -> dict | None:
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    if not pid or not aid:
        return None
    # P2.4: use indexed single-doc lookup; fall back to listing scan only when
    # get_article is unavailable (JSON storage mode).
    if hasattr(st, "get_article"):
        return st.get_article(project_id=pid, article_id=aid)
    rows = st.load_articles_listing_for_project(pid, limit=20000) if hasattr(st, "load_articles_listing_for_project") else (st.load_articles() or [])
    for a in rows or []:
        if not isinstance(a, dict):
            continue
        if (a.get("id") or "").strip() == aid and (a.get("project_id") or "").strip() == pid:
            return a
    return None


@router.get("", response_model=list[ScheduledJobPublic])
async def list_scheduled(project_id: str, user: dict = Depends(get_current_user)) -> list[ScheduledJobPublic]:
    st = get_legacy_storage_module()
    await _require_project_access(st=st, user=user, project_id=project_id)
    rows = await run_sync(st.load_scheduled_jobs, project_id=project_id) if hasattr(st, "load_scheduled_jobs") else []
    rows = _heal_stale_posting_jobs(st=st, project_id=project_id, rows=[r for r in (rows or []) if isinstance(r, dict)])
    out = [
        _to_public(r)
        for r in (rows or [])
        if isinstance(r, dict) and (r.get("state") or "").strip().lower() != "cancelled"
    ]
    # Latest scheduled first
    out.sort(key=lambda x: x.run_at, reverse=True)
    return out


@router.get("/board", response_model=list[ScheduledJobPublic])
async def list_scheduled_board(project_id: str, user: dict = Depends(get_current_user)) -> list[ScheduledJobPublic]:
    """
    Scheduled tab: jobs plus orphan article stubs in one request (deduped server-side).
    Avoids loading every article page client-side.
    """
    st = get_legacy_storage_module()
    await _require_project_access(st=st, user=user, project_id=project_id)

    # P2.5: the scheduled-jobs read and the article-stub read are independent —
    # fetch them concurrently instead of one after the other.
    async def _load_rows() -> list:
        if hasattr(st, "load_scheduled_jobs"):
            return await run_sync(st.load_scheduled_jobs, project_id=project_id) or []
        return []

    async def _load_stubs() -> list:
        if hasattr(st, "load_articles_schedule_stubs_for_project"):
            return await run_sync(st.load_articles_schedule_stubs_for_project, project_id, limit=500) or []
        if hasattr(st, "load_scheduled_pending_for_project_minimal"):
            return await run_sync(st.load_scheduled_pending_for_project_minimal, project_id, limit=500) or []
        return []

    rows, stubs = await asyncio.gather(_load_rows(), _load_stubs())
    rows = _heal_stale_posting_jobs(st=st, project_id=project_id, rows=[r for r in (rows or []) if isinstance(r, dict)])
    jobs = [
        _to_public(r)
        for r in (rows or [])
        if isinstance(r, dict) and (r.get("state") or "").strip().lower() != "cancelled"
    ]
    return _build_scheduled_jobs_board(project_id=project_id, jobs=jobs, article_stubs=stubs)


@router.patch("/{job_id}", response_model=ScheduledJobPublic)
async def update_scheduled_job(
    project_id: str,
    job_id: str,
    payload: ScheduledJobUpdate,
    user: dict = Depends(get_current_user),
) -> ScheduledJobPublic:
    st = get_legacy_storage_module()
    proj = await _require_project_access(st=st, user=user, project_id=project_id)
    _require_verified_website(proj)
    jid = (job_id or "").strip()
    # Indexed single-doc lookup replaces the full project-jobs scan that caused
    # a 40-second hang on stale Atlas connections (socket timeout × retry count).
    if hasattr(st, "get_scheduled_job_by_id"):
        row = await run_sync(call_storage, st.get_scheduled_job_by_id, jid)
    else:
        rows = await run_sync(st.load_scheduled_jobs, project_id=project_id) if hasattr(st, "load_scheduled_jobs") else []
        row = next((r for r in (rows or []) if isinstance(r, dict) and (r.get("id") or "").strip() == jid), None)
    if not row:
        raise HTTPException(status_code=404, detail="Scheduled job not found")
    if (row.get("state") or "").strip().lower() in {"posted", "cancelled"}:
        raise HTTPException(status_code=400, detail="Cannot edit a completed/cancelled job")

    prev_state = (row.get("state") or "").strip().lower()
    updates: dict = {"updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")}
    updated_run_at_utc: str | None = None
    if payload.run_at is not None:
        raw = (payload.run_at or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="Missing schedule time")

        try:
            # Payload timezone (browser-supplied) takes precedence over stored profile.
            tz_name = (payload.user_timezone or "").strip() or (user.get("timezone") or "").strip()
            user_tz = zoneinfo_for_user(tz_name or None)
            dt_utc = parse_schedule_input_to_utc(raw, user_tz=user_tz)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e) or "Invalid schedule time format") from None
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid schedule time format") from None

        if not is_schedule_time_allowed(dt_utc):
            # Failed jobs often keep an old run_at in the past; bump forward so
            # Re-Schedule works instead of returning 400 and leaving them stuck.
            if prev_state == "failed":
                dt_utc = minimum_schedule_utc()
            else:
                raise HTTPException(status_code=400, detail=SCHEDULE_TOO_SOON_MESSAGE)

        norm_utc = dt_utc.replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")
        updates["run_at"] = norm_utc
        updated_run_at_utc = norm_utc
        # A reschedule should put the job back into the scheduler queue.
        updates["state"] = "scheduled"
        updates["attempts"] = 0
        updates["last_attempt_at"] = ""
        updates["last_error"] = ""
    if payload.post_type is not None:
        updates["post_type"] = payload.post_type.strip()[:200]
    if payload.wp_status is not None:
        updates["wp_status"] = payload.wp_status.strip().lower()[:16]
    if payload.category_ids is not None:
        ids = []
        for x in payload.category_ids:
            try:
                n = int(x)
            except (TypeError, ValueError):
                continue
            if n > 0:
                ids.append(n)
        ids = list(dict.fromkeys(ids))[:50]
        updates["category_ids"] = ",".join(str(x) for x in ids)
    if payload.writing_prompt_id is not None:
        updates["writing_prompt_id"] = (payload.writing_prompt_id or "").strip()[:100]
    if payload.image_prompt_id is not None:
        updates["image_prompt_id"] = (payload.image_prompt_id or "").strip()[:100]
    if payload.generate_image is not None:
        updates["generate_image"] = bool(payload.generate_image)

    # Rescheduling always returns the job to the queue (including failed / stuck generating).
    if prev_state in {"failed", "content_generating", "image_generating", "posting", "ready_to_post"}:
        updates.setdefault("state", "scheduled")
        updates.setdefault("last_error", "")
        updates.setdefault("attempts", 0)
        updates.setdefault("last_attempt_at", "")

    patch_job = getattr(st, "patch_scheduled_job_fields", None) or st.update_scheduled_job_fields

    ok = await run_sync(call_storage, patch_job, jid, updates)
    if not ok:
        raise HTTPException(status_code=500, detail="Could not save schedule changes. Please try again.")

    # Keep the article row in sync so the Articles list can show the latest scheduled time.
    try:
        aid = (row.get("article_id") or "").strip()
        art_patch = getattr(st, "patch_article_fields", None) or st.update_article_fields
        if updated_run_at_utc and aid:
            await run_sync(
                call_storage,
                art_patch,
                aid,
                {
                    "wp_scheduled_at": updated_run_at_utc,
                    "wp_schedule_error": "",
                    "wp_schedule_wp_status": (updates.get("wp_status") or (row.get("wp_status") or "")).strip()[:16],
                    "wp_rest_base": (updates.get("post_type") or (row.get("post_type") or "")).strip()[:200],
                },
            )
    except Exception:
        # Best-effort sync; scheduled job update succeeded already.
        pass

    # Build the post-update job row from the in-memory data we already have —
    # avoids reloading all scheduled jobs from Atlas (which was the 42-second
    # hang caused by a stale MongoDB connection after idle time).
    job_after = {**row, **updates}

    # Re-run preparation after reschedule or when recovering a failed job.
    reprep = (
        prev_state == "failed"
        or payload.run_at is not None
        or payload.writing_prompt_id is not None
        or payload.image_prompt_id is not None
        or payload.generate_image is not None
    )
    if reprep:
        try:
            aid = (job_after.get("article_id") or "").strip()
            st_after = (job_after.get("state") or "").strip().lower()
            if aid and st_after in {"scheduled", "failed"}:
                # Reuse `proj` already loaded above; avoid a second round-trip.
                proj2 = proj
                # Use the indexed single-doc lookup instead of scanning all articles.
                art = await run_sync(_find_article_for_job, st=st, project_id=project_id, article_id=aid)
                if proj2 and art:
                    prep_force = prev_state == "failed"
                    if not prep_force and updated_run_at_utc:
                        from app.services.schedule_timing import is_within_scheduled_prep_window

                        prep_force = is_within_scheduled_prep_window(updated_run_at_utc)
                    start_scheduled_job_preparation_task(
                        st=st,
                        jid=jid,
                        proj=proj2,
                        art=art,
                        job=job_after,
                        force=prep_force,
                    )
        except Exception:
            pass

    return _to_public(job_after)


@router.post("/retry-failed-preparations", status_code=200)
async def retry_all_failed_preparations(
    project_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """Re-queue every failed scheduled job in this project (e.g. after deploying the generation fix)."""
    st = get_legacy_storage_module()
    proj = await _require_project_access(st=st, user=user, project_id=project_id)
    _require_verified_website(proj)
    rows = await run_sync(st.load_scheduled_jobs, project_id=project_id) if hasattr(st, "load_scheduled_jobs") else []
    failed = [
        r
        for r in (rows or [])
        if isinstance(r, dict) and (r.get("state") or "").strip().lower() == "failed"
    ]
    if not failed:
        return {"ok": True, "retried": 0, "message": "No failed scheduled jobs to retry."}

    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    retried = 0
    for row in failed:
        jid = (row.get("id") or "").strip()
        aid = (row.get("article_id") or "").strip()
        if not jid or not aid:
            continue
        await run_sync(
            st.update_scheduled_job_fields,
            jid,
            {
                "state": "content_generating",
                "last_error": "",
                "attempts": 0,
                "last_attempt_at": "",
                "updated_at": now_str,
            },
        )
        art = await run_sync(_find_article_for_job, st=st, project_id=project_id, article_id=aid)
        if not art:
            continue
        # Use in-memory row + updates; avoids a per-job Atlas round-trip.
        job_after = {**row, "state": "content_generating", "last_error": "", "attempts": 0, "updated_at": now_str}
        start_scheduled_job_preparation_task(
            st=st, jid=jid, proj=proj, art=art, job=job_after, force=True
        )
        retried += 1

    return {
        "ok": True,
        "retried": retried,
        "message": f"Restarted preparation for {retried} failed job(s).",
    }


@router.post("/{job_id}/retry-preparation", status_code=200)
async def retry_scheduled_job_preparation(
    project_id: str,
    job_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Re-run background content/image generation for a scheduled job.

    Use when a job is FAILED (e.g. legacy ``image_prompt_text`` signature mismatch)
    or stuck before posting.
    """
    st = get_legacy_storage_module()
    proj = await _require_project_access(st=st, user=user, project_id=project_id)
    _require_verified_website(proj)
    jid = (job_id or "").strip()
    if hasattr(st, "get_scheduled_job_by_id"):
        row = await run_sync(call_storage, st.get_scheduled_job_by_id, jid)
    else:
        rows = await run_sync(st.load_scheduled_jobs, project_id=project_id) if hasattr(st, "load_scheduled_jobs") else []
        row = next((r for r in (rows or []) if isinstance(r, dict) and (r.get("id") or "").strip() == jid), None)
    if not row:
        raise HTTPException(status_code=404, detail="Scheduled job not found")
    state = (row.get("state") or "").strip().lower()
    if state in {"posted", "cancelled"}:
        raise HTTPException(status_code=400, detail="Cannot retry preparation for a completed/cancelled job")

    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    prep_state = "content_generating"
    await run_sync(
        st.update_scheduled_job_fields,
        jid,
        {
            "state": prep_state,
            "last_error": "",
            "attempts": 0,
            "last_attempt_at": "",
            "updated_at": now_str,
        },
    )

    aid = (row.get("article_id") or "").strip()
    art = await run_sync(_find_article_for_job, st=st, project_id=project_id, article_id=aid) if aid else None
    if not art:
        raise HTTPException(status_code=404, detail="Article not found")

    if not isinstance(row, dict):
        raise HTTPException(status_code=404, detail="Scheduled job not found")
    # Use in-memory row + updates instead of reloading all jobs from Atlas.
    job_after = {**row, "state": prep_state, "last_error": "", "attempts": 0, "updated_at": now_str}

    start_scheduled_job_preparation_task(st=st, jid=jid, proj=proj, art=art, job=job_after, force=True)
    job_after = {**job_after, "state": prep_state, "last_error": ""}
    return {
        "ok": True,
        "message": "Preparation started. The job will move to Ready when content and image are generated.",
        "job": _to_public(job_after),
    }


@router.post("/{job_id}/post-now", status_code=200)
async def post_scheduled_job_now(
    project_id: str,
    job_id: str,
    payload: ScheduledJobPostNow | None = None,
    user: dict = Depends(get_current_user),
) -> dict:
    """Generate content when needed, then publish the scheduled job to WordPress immediately."""
    st = get_legacy_storage_module()
    proj = await _require_project_access(st=st, user=user, project_id=project_id)
    _require_verified_website(proj)

    from app.api.routes.prompts import _ensure_default_prompt
    from app.api.routes.image_prompts import _ensure_default_image_prompt

    try:
        proj = _ensure_default_prompt(st=st, project_id=project_id, proj=proj)
        proj = _ensure_default_image_prompt(st=st, project_id=project_id, proj=proj)
    except Exception:
        pass

    jid = (job_id or "").strip()
    if jid.startswith("pending_job_"):
        aid = jid[len("pending_job_") :].strip()
        rows = await run_sync(st.load_scheduled_jobs, project_id=project_id) if hasattr(st, "load_scheduled_jobs") else []
        alt = next(
            (
                r
                for r in (rows or [])
                if isinstance(r, dict)
                and (r.get("article_id") or "").strip() == aid
                and (r.get("state") or "").strip().lower() not in {"posted", "cancelled"}
            ),
            None,
        )
        if alt:
            jid = (alt.get("id") or "").strip()
        else:
            raise HTTPException(
                status_code=400,
                detail="This schedule entry is not linked to a job yet. Use Re-Schedule to save it, then try Post Now.",
            )

    row = await run_sync(st.load_scheduled_jobs, project_id=project_id) if hasattr(st, "load_scheduled_jobs") else []
    row = next((r for r in (row or []) if isinstance(r, dict) and (r.get("id") or "").strip() == jid), None)
    if not isinstance(row, dict):
        raise HTTPException(status_code=404, detail="Scheduled job not found")

    body = payload or ScheduledJobPostNow()
    patch: dict = {}
    if body.writing_prompt_id is not None:
        wp = (body.writing_prompt_id or "").strip()
        patch["writing_prompt_id"] = wp or None
    if body.image_prompt_id is not None:
        ip = (body.image_prompt_id or "").strip()
        patch["image_prompt_id"] = ip or None
    if body.generate_image is not None:
        patch["generate_image"] = bool(body.generate_image)
    if patch and hasattr(st, "update_scheduled_job_fields"):
        await run_sync(st.update_scheduled_job_fields, jid, patch)
        row = {**row, **patch}

    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role != "admin" and uid and hasattr(st, "consume_article_usage"):
        plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
        plan = {}
        try:
            plans = st.load_plans() or {}
            plan = plans.get(plan_key) if isinstance(plans, dict) else {}
            if not isinstance(plan, dict):
                plan = {}
        except Exception:
            plan = {}
        ok, msg = st.consume_article_usage(
            uid,
            day_limit=plan.get("max_articles_per_day"),
            month_limit=plan.get("max_articles_per_month"),
            amount=1,
        )
        if not ok:
            raise HTTPException(status_code=403, detail=msg or "Limit reached for your plan")


    state = (row.get("state") or "scheduled").strip().lower()
    if state == "posting":
        ts = _parse_job_timestamp(str(row.get("updated_at") or row.get("last_attempt_at") or ""))
        stale = ts is None or ts <= datetime.now(timezone.utc) - timedelta(minutes=_STALE_POSTING_MINUTES)
        if not stale:
            return {
                "ok": True,
                "status": "posting",
                "async": True,
                "message": "Publish already in progress. The list refreshes automatically.",
                "job": _to_public(row),
            }

    aid = (row.get("article_id") or "").strip()
    art = _find_article_for_job(st=st, project_id=project_id, article_id=aid) if aid else None
    needs_generation = not (isinstance(art, dict) and (str(art.get("article") or "").strip()))

    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    try:
        await run_sync(
            call_storage,
            st.update_scheduled_job_fields,
            jid,
            {
                "state": "posting",
                "last_error": "",
                "updated_at": now_str,
            },
        )
    except Exception as e:
        if is_transient_storage_error(e):
            raise HTTPException(status_code=503, detail="Database temporarily unavailable. Try again in a moment.") from e
        raise

    row = {**row, "state": "posting", "last_error": "", "updated_at": now_str}
    start_scheduled_job_post_now_task(st=st, jid=jid, proj=proj, job=row)

    msg = (
        "Generating content and publishing to WordPress. This usually takes 1–3 minutes — status updates automatically."
        if needs_generation
        else "Publishing to WordPress. Status updates automatically."
    )
    return {
        "ok": True,
        "status": "accepted",
        "async": True,
        "message": msg,
        "job": _to_public(row),
    }


@router.delete("/{job_id}", status_code=200)
async def cancel_scheduled_job(project_id: str, job_id: str, user: dict = Depends(get_current_user)) -> dict:
    """
    Remove a scheduled job and return the article to the Articles list as pending.
    """
    st = get_legacy_storage_module()
    await _require_project_access(st=st, user=user, project_id=project_id)
    jid = (job_id or "").strip()
    rows = await run_sync(st.load_scheduled_jobs, project_id=project_id) if hasattr(st, "load_scheduled_jobs") else []
    row = next((r for r in (rows or []) if isinstance(r, dict) and (r.get("id") or "").strip() == jid), None)
    if not row:
        raise HTTPException(status_code=404, detail="Scheduled job not found")
    state = (row.get("state") or "").strip().lower()
    if state == "posted":
        raise HTTPException(status_code=400, detail="Cannot cancel a job that has already been posted")
    if state == "cancelled":
        return {"ok": True, "article_id": (row.get("article_id") or "").strip()}

    aid = (row.get("article_id") or "").strip()
    deleted = 0
    if aid and hasattr(st, "delete_scheduled_jobs_for_article"):
        # One delete_many for every non-posted row of this article (P4.4 via P4.6 repo).
        deleted = int(
            await run_sync(
                ScheduledJobRepository(st).delete_for_article, project_id, aid, exclude_states=["posted"]
            )
            or 0
        )
    elif hasattr(st, "delete_scheduled_job"):
        for r in rows or []:
            if not isinstance(r, dict):
                continue
            if (r.get("article_id") or "").strip() != aid:
                continue
            if (r.get("state") or "").strip().lower() == "posted":
                continue
            rid = (r.get("id") or "").strip()
            if rid and await run_sync(st.delete_scheduled_job, rid):
                deleted += 1
    if deleted == 0:
        ok = await run_sync(
            st.update_scheduled_job_fields,
            jid,
            {
                "state": "cancelled",
                "last_error": "",
                "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
            },
        )
        if not ok:
            raise HTTPException(status_code=404, detail="Scheduled job not found")

    if aid and hasattr(st, "update_article_fields"):
        art = await run_sync(_find_article_for_job, st=st, project_id=project_id, article_id=aid)
        if art and not (str(art.get("wp_post_id") or "").strip()):
            await run_sync(st.update_article_fields, aid, _cleared_article_schedule_fields())

    return {"ok": True, "article_id": aid}


@router.delete("", status_code=200)
async def clear_scheduled_jobs(project_id: str, user: dict = Depends(get_current_user)) -> dict:
    """
    Delete all scheduled-job rows for the project.
    This is meant as a "start fresh" button for the UI.
    """
    st = get_legacy_storage_module()
    await _require_project_access(st=st, user=user, project_id=project_id)

    # Fast path: one bulk delete_many instead of N per-row deletes (P4.4 via P4.6 repo).
    if hasattr(st, "delete_scheduled_jobs_for_project"):
        deleted = await run_sync(ScheduledJobRepository(st).delete_for_project, project_id)
        return {"ok": True, "deleted": int(deleted or 0)}

    if not hasattr(st, "load_scheduled_jobs"):
        return {"ok": True, "deleted": 0}
    rows = await run_sync(st.load_scheduled_jobs, project_id=project_id) or []
    ids = [(r.get("id") or "").strip() for r in rows if isinstance(r, dict)]
    ids = [x for x in ids if x]
    deleted = 0
    for jid in ids:
        try:
            if hasattr(st, "delete_scheduled_job") and await run_sync(st.delete_scheduled_job, jid):
                deleted += 1
            else:
                # Fallback: mark cancelled if delete isn't available
                if hasattr(st, "update_scheduled_job_fields") and await run_sync(
                    st.update_scheduled_job_fields, jid, {"state": "cancelled", "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")}
                ):
                    deleted += 1
        except Exception:
            continue
    return {"ok": True, "deleted": deleted}

