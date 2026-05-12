from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.core.deps import get_current_user
from app.core.ids import user_ids_equal
from app.legacy.storage import get_legacy_storage_module
from app.schemas.scheduled_jobs import ScheduledJobPublic, ScheduledJobUpdate
from app.services.scheduler import prepare_article_for_scheduled_job, scheduler_error_message
from app.services.user_timezone import parse_schedule_input_to_utc, zoneinfo_for_user
from app.services.to_thread import run_sync


router = APIRouter(prefix="/projects/{project_id}/scheduled-jobs", tags=["scheduled"])


def _require_project_access(*, st, user: dict, project_id: str) -> dict:
    pid = (project_id or "").strip()
    proj = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role != "admin" and not user_ids_equal(proj.get("owner_user_id"), uid):
        raise HTTPException(status_code=404, detail="Project not found")
    return proj


def _require_verified_website(proj: dict) -> None:
    if (proj.get("wp_verified_status") or "").strip().lower() != "connected":
        raise HTTPException(
            status_code=400,
            detail={
                "code": "website_not_connected",
                "message": "Website is not connected for this project. Connect and verify WordPress before editing scheduled articles.",
            },
        )


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

def _find_article_for_job(*, st, project_id: str, article_id: str) -> dict | None:
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    if not pid or not aid:
        return None
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
    _require_project_access(st=st, user=user, project_id=project_id)
    rows = await run_sync(st.load_scheduled_jobs, project_id=project_id) if hasattr(st, "load_scheduled_jobs") else []
    out = [_to_public(r) for r in (rows or []) if isinstance(r, dict)]
    # Latest scheduled first
    out.sort(key=lambda x: x.run_at, reverse=True)
    return out


@router.patch("/{job_id}", response_model=ScheduledJobPublic)
async def update_scheduled_job(
    project_id: str,
    job_id: str,
    payload: ScheduledJobUpdate,
    user: dict = Depends(get_current_user),
) -> ScheduledJobPublic:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    _require_verified_website(proj)
    jid = (job_id or "").strip()
    rows = await run_sync(st.load_scheduled_jobs, project_id=project_id) if hasattr(st, "load_scheduled_jobs") else []
    row = next((r for r in (rows or []) if isinstance(r, dict) and (r.get("id") or "").strip() == jid), None)
    if not row:
        raise HTTPException(status_code=404, detail="Scheduled job not found")
    if (row.get("state") or "") in {"posted", "cancelled"}:
        raise HTTPException(status_code=400, detail="Cannot edit a completed/cancelled job")

    updates: dict = {"updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")}
    updated_run_at_utc: str | None = None
    if payload.run_at is not None:
        raw = (payload.run_at or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="Missing schedule time")

        try:
            user_tz = zoneinfo_for_user(user.get("timezone"))
            dt_utc = parse_schedule_input_to_utc(raw, user_tz=user_tz)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e) or "Invalid schedule time format") from None
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid schedule time format") from None

        if dt_utc < (datetime.now(timezone.utc) + timedelta(minutes=5)):
            raise HTTPException(status_code=400, detail="Scheduled time must be at least 5 minutes from now")

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

    await run_sync(st.update_scheduled_job_fields, jid, updates)

    # Keep the article row in sync so the Articles list can show the latest scheduled time.
    try:
        aid = (row.get("article_id") or "").strip()
        if updated_run_at_utc and aid and hasattr(st, "update_article_fields"):
            art = await run_sync(_find_article_for_job, st=st, project_id=project_id, article_id=aid)
            if art:
                await run_sync(
                    st.update_article_fields,
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

    # Best-effort: on reschedule or prompt changes, start background preparation again.
    # This ensures jobs don't show "ready_to_post" unless generation truly finished.
    try:
        # Reload job row to get the latest fields
        rows_after = await run_sync(st.load_scheduled_jobs, project_id=project_id) if hasattr(st, "load_scheduled_jobs") else []
        job_after = next((r for r in (rows_after or []) if isinstance(r, dict) and (r.get("id") or "").strip() == jid), None)
        aid = (job_after.get("article_id") or "").strip() if isinstance(job_after, dict) else ""
        if isinstance(job_after, dict) and aid and (job_after.get("state") or "").strip().lower() == "scheduled":
            prows = await run_sync(st.load_projects)
            proj = next((p for p in (prows or []) if isinstance(p, dict) and (p.get("id") or "") == (project_id or "").strip()), None)
            art = await run_sync(_find_article_for_job, st=st, project_id=project_id, article_id=aid)
            if proj and art:

                async def _prep() -> None:
                    try:
                        await prepare_article_for_scheduled_job(st=st, jid=jid, proj=proj, art=art, job=job_after)
                        await run_sync(
                            st.update_scheduled_job_fields,
                            jid,
                            {
                                "state": "ready_to_post",
                                "last_error": "",
                                "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                            },
                        )
                    except Exception as e:
                        err = scheduler_error_message(e)
                        await run_sync(
                            st.update_scheduled_job_fields,
                            jid,
                            {
                                "state": "failed",
                                "last_error": err,
                                "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                            },
                        )

                asyncio.create_task(_prep())
    except Exception:
        # Don't fail the update if background prep can't start.
        pass

    rows2 = await run_sync(st.load_scheduled_jobs, project_id=project_id)
    row2 = next((r for r in (rows2 or []) if isinstance(r, dict) and (r.get("id") or "").strip() == jid), None)
    if not row2:
        raise HTTPException(status_code=404, detail="Scheduled job not found")
    return _to_public(row2)


@router.delete("/{job_id}", status_code=200)
async def cancel_scheduled_job(project_id: str, job_id: str, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    jid = (job_id or "").strip()
    rows = await run_sync(st.load_scheduled_jobs, project_id=project_id) if hasattr(st, "load_scheduled_jobs") else []
    row = next((r for r in (rows or []) if isinstance(r, dict) and (r.get("id") or "").strip() == jid), None)
    ok = await run_sync(
        st.update_scheduled_job_fields, jid, {"state": "cancelled", "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")}
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Scheduled job not found")

    # Best-effort: clear the article's scheduled marker so Articles list matches.
    try:
        aid = ((row or {}).get("article_id") or "").strip()
        if aid and hasattr(st, "update_article_fields"):
            art = await run_sync(_find_article_for_job, st=st, project_id=project_id, article_id=aid)
            if art:
                await run_sync(st.update_article_fields, aid, {"wp_scheduled_at": "", "wp_schedule_error": ""})
    except Exception:
        pass

    return {"ok": True}


@router.delete("", status_code=200)
async def clear_scheduled_jobs(project_id: str, user: dict = Depends(get_current_user)) -> dict:
    """
    Delete all scheduled-job rows for the project.
    This is meant as a "start fresh" button for the UI.
    """
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
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

