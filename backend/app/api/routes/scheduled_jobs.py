from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException

from app.core.deps import get_current_user
from app.legacy.storage import get_legacy_storage_module
from app.schemas.scheduled_jobs import ScheduledJobPublic, ScheduledJobUpdate


router = APIRouter(prefix="/projects/{project_id}/scheduled-jobs", tags=["scheduled"])


def _require_project_access(*, st, user: dict, project_id: str) -> dict:
    pid = (project_id or "").strip()
    proj = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role != "admin" and (proj.get("owner_user_id") or "").strip() != uid:
        raise HTTPException(status_code=404, detail="Project not found")
    return proj


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


@router.get("", response_model=list[ScheduledJobPublic])
async def list_scheduled(project_id: str, user: dict = Depends(get_current_user)) -> list[ScheduledJobPublic]:
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    rows = st.load_scheduled_jobs(project_id=project_id) if hasattr(st, "load_scheduled_jobs") else []
    out = [_to_public(r) for r in (rows or []) if isinstance(r, dict)]
    out.sort(key=lambda x: x.run_at)
    return out


@router.patch("/{job_id}", response_model=ScheduledJobPublic)
async def update_scheduled_job(
    project_id: str,
    job_id: str,
    payload: ScheduledJobUpdate,
    user: dict = Depends(get_current_user),
) -> ScheduledJobPublic:
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    jid = (job_id or "").strip()
    rows = st.load_scheduled_jobs(project_id=project_id) if hasattr(st, "load_scheduled_jobs") else []
    row = next((r for r in (rows or []) if isinstance(r, dict) and (r.get("id") or "").strip() == jid), None)
    if not row:
        raise HTTPException(status_code=404, detail="Scheduled job not found")
    if (row.get("state") or "") in {"posted", "cancelled"}:
        raise HTTPException(status_code=400, detail="Cannot edit a completed/cancelled job")

    updates: dict = {"updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")}
    if payload.run_at is not None:
        updates["run_at"] = payload.run_at.strip()[:64]
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

    st.update_scheduled_job_fields(jid, updates)
    rows2 = st.load_scheduled_jobs(project_id=project_id)
    row2 = next((r for r in (rows2 or []) if isinstance(r, dict) and (r.get("id") or "").strip() == jid), None)
    if not row2:
        raise HTTPException(status_code=404, detail="Scheduled job not found")
    return _to_public(row2)


@router.delete("/{job_id}", status_code=200)
async def cancel_scheduled_job(project_id: str, job_id: str, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    jid = (job_id or "").strip()
    ok = st.update_scheduled_job_fields(jid, {"state": "cancelled", "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")})
    if not ok:
        raise HTTPException(status_code=404, detail="Scheduled job not found")
    return {"ok": True}

