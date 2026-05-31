"""Plan + trial gatekeeper for protected API actions."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from fastapi import Depends, HTTPException

from app.core.deps import get_current_user
from app.legacy.storage import get_legacy_storage_module


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


def assert_trial_active(*, user: dict, subscription: dict[str, Any] | None) -> None:
    if is_trial_expired(user=user, subscription=subscription):
        raise HTTPException(
            status_code=403,
            detail={"error": "trial_expired", "message": "Your beta access has ended."},
        )


def check_plan_limits(*, st, user: dict, action: PlanAction, consume: bool = True) -> None:
    """
    Central gatekeeper: trial expiry, feature flags, and quota consumption.

    Quota consumption delegates to existing storage counters (no pipeline changes).
    """
    if (user.get("role") or "").strip().lower() == "admin":
        return

    uid = (user.get("id") or "").strip()
    subscription = st.ensure_subscription_for_user(user) if hasattr(st, "ensure_subscription_for_user") else None
    if subscription is None and hasattr(st, "get_subscription_by_user_id"):
        subscription = st.get_subscription_by_user_id(uid)

    assert_trial_active(user=user, subscription=subscription)

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
    async def _dep(user: dict = Depends(get_current_user)) -> dict:
        st = get_legacy_storage_module()
        check_plan_limits(st=st, user=user, action=action, consume=consume)
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
    expired = is_trial_expired(user=user, subscription=subscription)
    status = "trial_expired" if expired else ("active" if trial_end_raw else "no_trial")

    remaining_days = remaining_hours = remaining_minutes = 0
    end = _parse_iso_utc(trial_end_raw)
    if end and not expired:
        delta = end - datetime.now(timezone.utc)
        total_minutes = max(0, int(delta.total_seconds() // 60))
        remaining_days = total_minutes // (24 * 60)
        remaining_hours = (total_minutes % (24 * 60)) // 60
        remaining_minutes = total_minutes % 60

    usage_raw = (subscription or {}).get("usage") if isinstance((subscription or {}).get("usage"), dict) else {}
    trial_plan_key = st.get_trial_plan_key() if hasattr(st, "get_trial_plan_key") else None

    return {
        "status": status,
        "plan_key": plan_key,
        "plan_name": (plan.get("name") or plan_key),
        "trial_start_date": trial_start_raw or None,
        "trial_end_date": trial_end_raw or None,
        "remaining_days": remaining_days,
        "remaining_hours": remaining_hours,
        "remaining_minutes": remaining_minutes,
        "is_trial_plan": bool(trial_plan_key and plan_key == trial_plan_key),
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
