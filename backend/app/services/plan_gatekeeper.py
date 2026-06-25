"""Plan + trial gatekeeper for protected API actions."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from fastapi import Depends, HTTPException, Request

from app.core.deps import get_current_user
from app.core.request_cache import cached_subscription, has_cached_subscription
from app.legacy.storage import get_legacy_storage_module

_UNSET = object()


class PlanAction(str, Enum):
    CREATE_PROJECT = "create_project"
    GENERATE_CONTENT = "generate_content"
    REGENERATE_IMAGE = "regenerate_image"
    HUMANIZE = "humanize"
    SCHEDULE_POST = "schedule_post"
    BULK_UPLOAD = "bulk_upload"
    BULK_EXPORT = "bulk_export"
    CLUSTER_PLAN = "cluster_plan"
    CUSTOM_RESEARCH = "custom_research"


def _parse_iso_utc(raw: str) -> datetime | None:
    text = (raw or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
            try:
                dt = datetime.strptime(text[:19], fmt)
                break
            except ValueError:
                dt = None
        if dt is None:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _plan_for_user(st, user: dict) -> tuple[str, dict[str, Any]]:
    plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
    try:
        plans = st.load_plans() or {}
        plan = plans.get(plan_key) if isinstance(plans, dict) else {}
        if not isinstance(plan, dict):
            plan = {}
    except Exception:
        plan = {}
    return plan_key, plan


def is_trial_expired(*, user: dict, subscription: dict[str, Any] | None) -> bool:
    if (user.get("role") or "").strip().lower() == "admin":
        return False
    if not subscription:
        return False
    end_raw = (subscription.get("trial_end_date") or "").strip()
    if not end_raw:
        return False
    end = _parse_iso_utc(end_raw)
    if not end:
        return False
    return datetime.now(timezone.utc) > end


def assert_trial_active(*, user: dict, subscription: dict[str, Any] | None, st=None) -> None:
    # Skip expiry check when user is not on the trial plan (e.g. upgraded to unlimited)
    if st is not None:
        plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
        trial_plan_key = st.get_trial_plan_key() if hasattr(st, "get_trial_plan_key") else None
        if trial_plan_key and plan_key != trial_plan_key:
            return
    if is_trial_expired(user=user, subscription=subscription):
        raise HTTPException(
            status_code=403,
            detail={"error": "trial_expired", "message": "Your beta access has ended."},
        )


def check_plan_limits(*, st, user: dict, action: PlanAction, consume: bool = True, subscription: Any = _UNSET) -> None:
    """
    Central gatekeeper: trial expiry, feature flags, and quota consumption.

    Quota consumption delegates to existing storage counters (no pipeline changes).
    When ``subscription`` is supplied (e.g. memoized by the request-scoped cache,
    P2.1) it is used as-is instead of re-reading it from storage.
    """
    if (user.get("role") or "").strip().lower() == "admin":
        return

    uid = (user.get("id") or "").strip()
    if subscription is _UNSET:
        subscription = st.ensure_subscription_for_user(user) if hasattr(st, "ensure_subscription_for_user") else None
        if subscription is None and hasattr(st, "get_subscription_by_user_id"):
            subscription = st.get_subscription_by_user_id(uid)

    assert_trial_active(user=user, subscription=subscription, st=st)

    plan_key, plan = _plan_for_user(st, user)

    if action == PlanAction.BULK_UPLOAD:
        if not bool(plan.get("allow_bulk_upload", True)):
            raise HTTPException(
                status_code=403,
                detail={"error": "feature_disabled", "message": "Bulk upload is not included in your plan."},
            )
        return

    if action == PlanAction.BULK_EXPORT:
        if not bool(plan.get("allow_export", True)):
            raise HTTPException(
                status_code=403,
                detail={"error": "feature_disabled", "message": "Bulk export is not included in your plan."},
            )
        if consume and hasattr(st, "consume_export_usage"):
            ok, msg = st.consume_export_usage(uid, month_limit=plan.get("max_export_per_month"), amount=1)
            if not ok:
                raise HTTPException(status_code=403, detail={"error": "quota_exceeded", "message": msg or "Export limit reached."})
        return

    if action == PlanAction.SCHEDULE_POST:
        if not bool(plan.get("allow_scheduling", True)):
            raise HTTPException(
                status_code=403,
                detail={"error": "feature_disabled", "message": "Scheduling is not included in your plan."},
            )
        if consume and hasattr(st, "consume_scheduled_usage"):
            ok, msg = st.consume_scheduled_usage(uid, month_limit=plan.get("max_scheduled_per_month"), amount=1)
            if not ok:
                raise HTTPException(status_code=403, detail={"error": "quota_exceeded", "message": msg or "Schedule limit reached."})
        return

    if action == PlanAction.CREATE_PROJECT:
        max_projects = plan.get("max_projects")
        if max_projects is not None and int(max_projects or 0) > 0 and hasattr(st, "project_ids_for_owner"):
            count = len(st.project_ids_for_owner(uid) or [])
            if count >= int(max_projects):
                raise HTTPException(
                    status_code=403,
                    detail={"error": "quota_exceeded", "message": "Project limit reached for your plan."},
                )
        return

    if action in {PlanAction.GENERATE_CONTENT, PlanAction.REGENERATE_IMAGE, PlanAction.HUMANIZE}:
        if consume and action == PlanAction.GENERATE_CONTENT and hasattr(st, "consume_article_usage"):
            ok, msg = st.consume_article_usage(
                uid,
                day_limit=plan.get("max_articles_per_day"),
                month_limit=plan.get("max_articles_per_month"),
                amount=1,
            )
            if not ok:
                raise HTTPException(status_code=403, detail={"error": "quota_exceeded", "message": msg or "Article limit reached."})
        return

    if action == PlanAction.CLUSTER_PLAN and consume and hasattr(st, "consume_cluster_plan_usage"):
        ok, msg = st.consume_cluster_plan_usage(uid, month_limit=plan.get("max_cluster_plans_per_month"), amount=1)
        if not ok:
            raise HTTPException(status_code=403, detail={"error": "quota_exceeded", "message": msg or "Cluster plan limit reached."})
        return

    if action == PlanAction.CUSTOM_RESEARCH and consume and hasattr(st, "consume_custom_research_usage"):
        ok, msg = st.consume_custom_research_usage(uid, month_limit=plan.get("max_custom_research_per_month"), amount=1)
        if not ok:
            raise HTTPException(status_code=403, detail={"error": "quota_exceeded", "message": msg or "Custom research limit reached."})
        return


def require_plan_action(action: PlanAction, *, consume: bool = True):
    async def _dep(request: Request, user: dict = Depends(get_current_user)) -> dict:
        st = get_legacy_storage_module()
        # P2.1: reuse the subscription loaded by PlanLimitsMiddleware this request.
        subscription = cached_subscription(request) if has_cached_subscription(request) else _UNSET
        check_plan_limits(st=st, user=user, action=action, consume=consume, subscription=subscription)
        return user

    return _dep


def _get_effective_user_for_project(st, current_user: dict, project_id: str) -> dict:
    """
    For project-scoped actions, resolve plan limits to the project *owner*'s
    subscription when the logged-in user is a collaborator.

    Returns the owner's user dict if the current user is a collaborator,
    otherwise returns current_user unchanged.  Never raises — falls back
    to current_user on any storage error.
    """
    pid = (project_id or "").strip()
    uid = (current_user.get("id") or "").strip()
    if not pid or not uid:
        return current_user

    try:
        ctx = st.get_project_member_context(pid, uid) if hasattr(st, "get_project_member_context") else None
    except Exception:
        return current_user

    if not ctx or ctx.get("is_owner", True):
        return current_user

    owner_uid = (ctx.get("owner_user_id") or "").strip()
    if not owner_uid:
        return current_user

    try:
        owner_user = st.get_user_by_id(owner_uid) if hasattr(st, "get_user_by_id") else None
    except Exception:
        owner_user = None

    return owner_user if isinstance(owner_user, dict) and owner_user else current_user


def require_plan_action_for_project(
    action: PlanAction,
    *,
    project_id_param: str = "project_id",
    consume: bool = True,
):
    """
    Like require_plan_action but resolves the plan against the project *owner*
    when the current user is a collaborator.  This means collaborators inherit
    the owner's plan limits (and trial status) for every project-scoped action.

    Returns the logged-in user (not the owner) so route handlers can still
    read the real caller's identity.
    """
    async def _dep(request: Request, user: dict = Depends(get_current_user)) -> dict:
        st = get_legacy_storage_module()
        project_id = request.path_params.get(project_id_param, "")
        effective_user = _get_effective_user_for_project(st, user, project_id)
        # Don't use the cached subscription when we've swapped to the owner's user dict
        subscription = (
            cached_subscription(request)
            if (has_cached_subscription(request) and effective_user is user)
            else _UNSET
        )
        check_plan_limits(st=st, user=effective_user, action=action, consume=consume, subscription=subscription)
        return user

    return _dep


def build_subscription_status(*, st, user: dict) -> dict[str, Any]:
    uid = (user.get("id") or "").strip()
    plan_key, plan = _plan_for_user(st, user)
    subscription = st.ensure_subscription_for_user(user) if hasattr(st, "ensure_subscription_for_user") else None
    if subscription is None and hasattr(st, "get_subscription_by_user_id"):
        subscription = st.get_subscription_by_user_id(uid)

    trial_end_raw = (subscription or {}).get("trial_end_date") or ""
    trial_start_raw = (subscription or {}).get("trial_start_date") or ""
    trial_plan_key = st.get_trial_plan_key() if hasattr(st, "get_trial_plan_key") else None
    is_trial = bool(trial_plan_key and plan_key == trial_plan_key)
    # Only flag expired if the user is currently on the trial plan — upgraded users keep their
    # old trial_end_date in the subscription doc but should not be treated as expired.
    expired = is_trial and is_trial_expired(user=user, subscription=subscription)
    status = "trial_expired" if expired else ("active" if (trial_end_raw and is_trial) else "no_trial")

    remaining_days = remaining_hours = remaining_minutes = 0
    end = _parse_iso_utc(trial_end_raw)
    if end and not expired:
        delta = end - datetime.now(timezone.utc)
        total_minutes = max(0, int(delta.total_seconds() // 60))
        remaining_days = total_minutes // (24 * 60)
        remaining_hours = (total_minutes % (24 * 60)) // 60
        remaining_minutes = total_minutes % 60

    usage_raw = (subscription or {}).get("usage") if isinstance((subscription or {}).get("usage"), dict) else {}

    return {
        "status": status,
        "plan_key": plan_key,
        "plan_name": (plan.get("name") or plan_key),
        "trial_start_date": trial_start_raw or None,
        "trial_end_date": trial_end_raw or None,
        "remaining_days": remaining_days,
        "remaining_hours": remaining_hours,
        "remaining_minutes": remaining_minutes,
        "is_trial_plan": is_trial,
        "usage": {
            "articlesGeneratedToday": int(usage_raw.get("articlesGeneratedToday") or user.get("usage_daily_articles_count") or 0),
            "articlesGeneratedThisMonth": int(usage_raw.get("articlesGeneratedThisMonth") or user.get("usage_monthly_articles_count") or 0),
            "regenerationsThisMonth": int(usage_raw.get("regenerationsThisMonth") or 0),
            "schedulesThisMonth": int(usage_raw.get("schedulesThisMonth") or user.get("usage_monthly_scheduled_count") or 0),
            "exportsThisMonth": int(usage_raw.get("exportsThisMonth") or user.get("usage_monthly_export_count") or 0),
        },
        "features": {
            "projectsMax": plan.get("max_projects"),
            "articlesPerMonth": plan.get("max_articles_per_month"),
            "articlesPerDay": plan.get("max_articles_per_day"),
            "regenerationsPerMonth": plan.get("max_article_image_regenerations"),
            "schedulesMax": plan.get("max_scheduled_per_month"),
            "allowBulkUpload": bool(plan.get("allow_bulk_upload", True)),
            "allowBulkExport": bool(plan.get("allow_export", True)),
        },
    }
