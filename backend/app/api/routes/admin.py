from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response

from app.core.deps import require_admin
from app.legacy.storage import get_legacy_storage_module
from app.schemas.admin import AdminUserDetails, AdminUserPublic, AdminUserStats, AdminUserUpdate, PlanPublic, PlanUpsert

router = APIRouter(prefix="/admin", tags=["admin"])


def _user_to_public(u: dict) -> AdminUserPublic:
    return AdminUserPublic(
        id=(u.get("id") or "").strip(),
        email=(u.get("email") or "").strip(),
        role=((u.get("role") or "user").strip().lower() or "user"),
        subscription_type=((u.get("subscription_type") or "").strip() or None),
        full_name=((u.get("full_name") or "").strip() or None),
        phone=((u.get("phone") or "").strip() or None),
        timezone=((u.get("timezone") or "").strip() or None),
        address=((u.get("address") or "").strip() or None),
        created_at=((u.get("created_at") or "").strip() or None),
        last_activity_at=((u.get("last_activity_at") or "").strip() or None),
    )


@router.get("/users", response_model=list[AdminUserPublic])
async def list_users(_: dict = Depends(require_admin)) -> list[AdminUserPublic]:
    st = get_legacy_storage_module()
    items = st.list_users() or []
    out: list[AdminUserPublic] = []
    for u in items:
        if isinstance(u, dict):
            out.append(_user_to_public(u))
    out.sort(key=lambda x: (x.email.lower(), x.id))
    return out


@router.patch("/users/{user_id}", response_model=AdminUserPublic)
async def update_user(user_id: str, payload: AdminUserUpdate, _: dict = Depends(require_admin)) -> AdminUserPublic:
    st = get_legacy_storage_module()
    uid = (user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=400, detail="user_id is required")

    updates = payload.model_dump(exclude_unset=True)
    ok = st.update_user_fields(uid, updates)
    if not ok:
        raise HTTPException(status_code=404, detail="User not found")
    u = st.get_user_by_id(uid)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    return _user_to_public(u)


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(user_id: str, _: dict = Depends(require_admin)) -> Response:
    st = get_legacy_storage_module()
    uid = (user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=400, detail="user_id is required")
    ok = st.delete_user(uid)
    if not ok:
        raise HTTPException(status_code=404, detail="User not found")
    return Response(status_code=204)


@router.get("/users/{user_id}/details", response_model=AdminUserDetails)
async def user_details(user_id: str, _: dict = Depends(require_admin)) -> AdminUserDetails:
    st = get_legacy_storage_module()
    uid = (user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=400, detail="user_id is required")
    u = st.get_user_by_id(uid)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    pids = st.project_ids_for_owner(uid) if hasattr(st, "project_ids_for_owner") else []
    counts = st.count_articles_by_project_ids(pids) if hasattr(st, "count_articles_by_project_ids") else {"total": 0, "pending": 0, "draft": 0, "published": 0, "active": 0}
    stats = AdminUserStats(
        total_projects=len(pids),
        total_articles=int(counts.get("total") or 0),
        total_pending_articles=int(counts.get("pending") or 0),
        total_active_articles=int(counts.get("active") or 0),
        total_draft_articles=int(counts.get("draft") or 0),
        total_published_articles=int(counts.get("published") or 0),
    )
    return AdminUserDetails(user=_user_to_public(u), stats=stats)


def _plan_to_public(key: str, d: dict) -> PlanPublic:
    base = dict(d or {})
    base_key = (base.get("key") or key or "").strip().lower()
    known = {
        "key": base_key,
        "name": base.get("name"),
        "max_projects": base.get("max_projects"),
        "max_articles": base.get("max_articles"),
        "max_articles_per_day": base.get("max_articles_per_day"),
        "max_articles_per_month": base.get("max_articles_per_month"),
        "max_writing_prompts": base.get("max_writing_prompts"),
        "writing_prompt_char_limit": base.get("writing_prompt_char_limit"),
        "max_image_prompts": base.get("max_image_prompts"),
        "image_prompt_char_limit": base.get("image_prompt_char_limit"),
        "allow_scheduling": base.get("allow_scheduling"),
        "allow_export": base.get("allow_export"),
        "allow_bulk_upload": base.get("allow_bulk_upload"),
    }
    extra = {k: v for k, v in base.items() if k not in known}
    return PlanPublic(**known, extra=extra or None)


@router.get("/plans", response_model=list[PlanPublic])
async def list_plans(_: dict = Depends(require_admin)) -> list[PlanPublic]:
    st = get_legacy_storage_module()
    plans = st.load_plans() or {}
    out: list[PlanPublic] = []
    for k, v in plans.items():
        if isinstance(v, dict):
            out.append(_plan_to_public(str(k), v))
    out.sort(key=lambda x: x.key)
    return out


@router.put("/plans/{plan_key}", response_model=PlanPublic)
async def upsert_plan(plan_key: str, payload: PlanUpsert, _: dict = Depends(require_admin)) -> PlanPublic:
    st = get_legacy_storage_module()
    key = (plan_key or "").strip().lower()
    if not key:
        raise HTTPException(status_code=400, detail="plan_key is required")
    try:
        st.upsert_plan(key, payload.model_dump(exclude_unset=True))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    plans = st.load_plans() or {}
    d = plans.get(key) or {"key": key}
    return _plan_to_public(key, d if isinstance(d, dict) else {"key": key})

