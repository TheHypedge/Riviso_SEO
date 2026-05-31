from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response

from app.core.deps import require_admin
from app.legacy.storage import get_legacy_storage_module
from app.schemas.admin import (
    AdminUserDetails,
    AdminUserPublic,
    AdminUserStats,
    AdminUserUpdate,
    AdminWorkspaceArticleRow,
    AdminWorkspaceProjectRow,
    AdminWorkspaceResponse,
    PlanPublic,
    PlanUpsert,
)
from app.services.user_timezone import normalize_user_timezone
from app.services.to_thread import run_sync

router = APIRouter(prefix="/admin", tags=["admin"])

@router.get("/storage-status")
async def storage_status(_: dict = Depends(require_admin)) -> dict:
    """
    Quick runtime check to see if persistence is using MongoDB or JSON fallback.
    """
    st = get_legacy_storage_module()
    mode = None
    err = None
    if hasattr(st, "storage_mode"):
        try:
            mode = await run_sync(st.storage_mode)
        except Exception as e:
            mode = None
            err = str(e)
    if hasattr(st, "storage_init_error"):
        try:
            err2 = await run_sync(st.storage_init_error)
            if err2:
                err = err2
        except Exception:
            pass
    return {"storage_mode": mode, "storage_init_error": err}


def _user_to_public(u: dict, *, total_projects: int = 0) -> AdminUserPublic:
    tz_raw = (u.get("timezone") or "").strip()
    tz_norm = normalize_user_timezone(tz_raw) if tz_raw else None
    return AdminUserPublic(
        id=(u.get("id") or "").strip(),
        email=(u.get("email") or "").strip(),
        role=((u.get("role") or "user").strip().lower() or "user"),
        subscription_type=((u.get("subscription_type") or "").strip() or None),
        full_name=((u.get("full_name") or "").strip() or None),
        phone=((u.get("phone") or "").strip() or None),
        timezone=(tz_norm or None),
        address=((u.get("address") or "").strip() or None),
        account_status=((u.get("account_status") or "active").strip().lower() or "active"),
        is_deleted=bool(u.get("is_deleted", False)),
        is_deactivated=bool(u.get("is_deactivated", False)),
        deleted_at=((u.get("deleted_at") or "").strip() or None),
        deactivated_at=((u.get("deactivated_at") or "").strip() or None),
        deletion_requested_at=((u.get("deletion_requested_at") or "").strip() or None),
        reactivated_at=((u.get("reactivated_at") or "").strip() or None),
        retention_reason=((u.get("retention_reason") or "").strip() or None),
        retargeting_retained=bool(u.get("retargeting_retained", False)),
        created_at=((u.get("created_at") or "").strip() or None),
        last_activity_at=((u.get("last_activity_at") or "").strip() or None),
        total_projects=int(total_projects or 0),
    )


@router.get("/users", response_model=list[AdminUserPublic])
async def list_users(_: dict = Depends(require_admin)) -> list[AdminUserPublic]:
    st = get_legacy_storage_module()
    items = st.list_users() or []
    out: list[AdminUserPublic] = []
    for u in items:
        if isinstance(u, dict):
            uid = (u.get("id") or "").strip()
            nproj = 0
            if uid and hasattr(st, "project_ids_for_owner"):
                try:
                    nproj = len(st.project_ids_for_owner(uid) or [])
                except Exception:
                    nproj = 0
            out.append(_user_to_public(u, total_projects=nproj))
    out.sort(key=lambda x: (x.email.lower(), x.id))
    return out


@router.patch("/users/{user_id}", response_model=AdminUserPublic)
async def update_user(user_id: str, payload: AdminUserUpdate, _: dict = Depends(require_admin)) -> AdminUserPublic:
    st = get_legacy_storage_module()
    uid = (user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=400, detail="user_id is required")

    updates = payload.model_dump(exclude_unset=True)
    prev = st.get_user_by_id(uid) if uid else None
    if "timezone" in updates and isinstance(updates.get("timezone"), str):
        updates["timezone"] = normalize_user_timezone(updates["timezone"])
    if "account_status" in updates and isinstance(updates.get("account_status"), str):
        status = updates["account_status"].strip().lower()
        if status not in {"active", "pending", "deactivated", "deleted"}:
            raise HTTPException(status_code=400, detail="Invalid account_status")
        updates["account_status"] = status
        if status == "active":
            updates.setdefault("is_deleted", False)
            updates.setdefault("is_deactivated", False)
    ok = st.update_user_fields(uid, updates)
    if not ok:
        raise HTTPException(status_code=404, detail="User not found")
    u = st.get_user_by_id(uid)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    if (
        prev
        and "subscription_type" in updates
        and (updates.get("subscription_type") or "").strip().lower()
        != (prev.get("subscription_type") or "").strip().lower()
    ):
        from app.services.email_dispatch import dispatch_plan_notification_email

        plans = st.load_plans() or {}
        plan_key = (updates.get("subscription_type") or u.get("subscription_type") or "").strip().lower()
        plan_name = (plans.get(plan_key) or {}).get("name") if isinstance(plans.get(plan_key), dict) else plan_key
        dispatch_plan_notification_email(to=(u.get("email") or "").strip(), plan_name=str(plan_name or plan_key))
    nproj = 0
    if hasattr(st, "project_ids_for_owner"):
        try:
            nproj = len(st.project_ids_for_owner(uid) or [])
        except Exception:
            nproj = 0
    return _user_to_public(u, total_projects=nproj)


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(user_id: str, admin: dict = Depends(require_admin)) -> Response:
    st = get_legacy_storage_module()
    uid = (user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=400, detail="user_id is required")
    if uid == (admin.get("id") or "").strip():
        raise HTTPException(status_code=400, detail="Admins cannot delete their own account from the admin panel")
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
    return AdminUserDetails(user=_user_to_public(u, total_projects=len(pids)), stats=stats)


@router.get("/users/{user_id}/workspace", response_model=AdminWorkspaceResponse)
async def user_workspace(user_id: str, _: dict = Depends(require_admin)) -> AdminWorkspaceResponse:
    """
    Admin-only snapshot of another user's projects plus a recent article listing.
    Opening project/article routes in the main app still respects admin access checks.
    """
    st = get_legacy_storage_module()
    uid = (user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=400, detail="user_id is required")
    u = st.get_user_by_id(uid)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")

    projs = [p for p in (st.load_projects(uid) or []) if isinstance(p, dict)]
    by_id: dict[str, dict] = {}
    for p in projs:
        pid = (p.get("id") or "").strip()
        if pid:
            by_id[pid] = p
    pids = sorted(by_id.keys())

    counts: dict[str, int] = {}
    if hasattr(st, "article_totals_per_project"):
        try:
            counts = dict(st.article_totals_per_project(pids))
        except Exception:
            counts = {pid: 0 for pid in pids}

    listing_limit = 1500
    raw_articles: list[dict] = []
    if hasattr(st, "load_recent_article_listings_for_projects"):
        try:
            raw_articles = list(st.load_recent_article_listings_for_projects(pids, limit=listing_limit) or [])
        except Exception:
            raw_articles = []
    else:
        for pid in pids:
            if hasattr(st, "load_articles_listing_for_project"):
                try:
                    raw_articles.extend(st.load_articles_listing_for_project(pid, limit=300) or [])
                except Exception:
                    pass

    total_articles = sum(int(counts.get(pid, 0) or 0) for pid in pids)
    articles_truncated = total_articles > len(raw_articles)

    project_rows = [
        AdminWorkspaceProjectRow(
            id=pid,
            name=str((by_id[pid].get("name") or "")).strip(),
            website_url=(str(by_id[pid].get("website_url") or "").strip() or None),
            article_count=int(counts.get(pid, 0) or 0),
        )
        for pid in sorted(pids, key=lambda x: (str(by_id[x].get("name") or "").lower(), x))
    ]

    article_rows: list[AdminWorkspaceArticleRow] = []
    for a in raw_articles:
        if not isinstance(a, dict):
            continue
        aid = (a.get("id") or "").strip()
        pid = (a.get("project_id") or "").strip()
        if not aid or not pid:
            continue
        pname = str((by_id.get(pid) or {}).get("name") or "").strip() or pid
        ca = (str(a.get("created_at") or "").strip() or None)
        wpl = (str(a.get("wp_link") or "").strip() or None)
        article_rows.append(
            AdminWorkspaceArticleRow(
                id=aid,
                project_id=pid,
                project_name=pname,
                title=(str(a.get("title") or "").strip() or "(untitled)"),
                status=str(a.get("status") or "pending").strip().lower(),
                created_at=ca,
                wp_link=wpl,
            )
        )

    return AdminWorkspaceResponse(
        user_id=uid,
        email=(u.get("email") or "").strip(),
        projects=project_rows,
        articles=article_rows,
        articles_truncated=articles_truncated,
    )


def _plan_to_public(key: str, d: dict) -> PlanPublic:
    base = dict(d or {})
    base_key = (base.get("key") or key or "").strip().lower()
    known = {
        "key": base_key,
        "name": base.get("name"),
        "is_default": base.get("is_default"),
        "cost_monthly": base.get("cost_monthly"),
        "max_projects": base.get("max_projects"),
        "max_articles": base.get("max_articles"),
        "max_articles_per_day": base.get("max_articles_per_day"),
        "max_articles_per_month": base.get("max_articles_per_month"),
        "max_writing_prompts": base.get("max_writing_prompts"),
        "writing_prompt_char_limit": base.get("writing_prompt_char_limit"),
        "max_image_prompts": base.get("max_image_prompts"),
        "image_prompt_char_limit": base.get("image_prompt_char_limit"),
        "allow_scheduling": base.get("allow_scheduling"),
        "max_scheduled_per_month": base.get("max_scheduled_per_month"),
        "allow_export": base.get("allow_export"),
        "max_export_per_month": base.get("max_export_per_month"),
        "allow_bulk_upload": base.get("allow_bulk_upload"),
        "max_cluster_plans_per_month": base.get("max_cluster_plans_per_month"),
        "max_custom_research_per_month": base.get("max_custom_research_per_month"),
        "max_context_links": base.get("max_context_links"),
        "max_article_image_regenerations": base.get("max_article_image_regenerations"),
        "is_trial_plan": base.get("is_trial_plan"),
        "trial_period_days": base.get("trial_period_days"),
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

