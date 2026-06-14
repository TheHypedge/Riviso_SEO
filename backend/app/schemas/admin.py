from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class AdminUserPublic(BaseModel):
    id: str
    email: str
    role: str
    subscription_type: str | None = None
    full_name: str | None = None
    phone: str | None = None
    timezone: str | None = None
    address: str | None = None
    account_status: str | None = None
    is_deleted: bool = False
    is_deactivated: bool = False
    deleted_at: str | None = None
    deactivated_at: str | None = None
    deletion_requested_at: str | None = None
    reactivated_at: str | None = None
    retention_reason: str | None = None
    retargeting_retained: bool = False
    created_at: str | None = None
    last_activity_at: str | None = None
    total_projects: int = 0


class AdminUserUpdate(BaseModel):
    role: str | None = None
    subscription_type: str | None = None
    full_name: str | None = None
    phone: str | None = None
    timezone: str | None = None
    address: str | None = None
    account_status: str | None = None
    is_deleted: bool | None = None
    is_deactivated: bool | None = None


class AdminUserStats(BaseModel):
    total_projects: int = 0
    total_articles: int = 0
    total_pending_articles: int = 0
    total_active_articles: int = 0
    total_draft_articles: int = 0
    total_published_articles: int = 0


class AdminUserDetails(BaseModel):
    user: AdminUserPublic
    stats: AdminUserStats


class AdminWorkspaceProjectRow(BaseModel):
    """One project owned by the target user (admin browse)."""

    id: str
    name: str
    website_url: str | None = None
    article_count: int = 0


class AdminWorkspaceArticleRow(BaseModel):
    """Minimal article row for admin tables (truncated listing)."""

    id: str
    project_id: str
    project_name: str
    title: str
    status: str
    created_at: str | None = None
    wp_link: str | None = None


class AdminWorkspaceResponse(BaseModel):
    user_id: str
    email: str
    projects: list[AdminWorkspaceProjectRow]
    articles: list[AdminWorkspaceArticleRow]
    articles_truncated: bool = False


class PlanPublic(BaseModel):
    key: str = Field(..., description="Plan key (e.g. beta, pro)")
    name: str | None = None
    is_default: bool | None = None
    cost_monthly: float | None = None
    max_projects: int | None = None
    max_articles: int | None = None
    max_articles_per_day: int | None = None
    max_articles_per_month: int | None = None
    max_writing_prompts: int | None = None
    writing_prompt_char_limit: int | None = None
    max_image_prompts: int | None = None
    image_prompt_char_limit: int | None = None
    allow_scheduling: bool | None = None
    max_scheduled_per_month: int | None = None
    allow_export: bool | None = None
    max_export_per_month: int | None = None
    allow_bulk_upload: bool | None = None
    max_cluster_plans_per_month: int | None = None
    max_custom_research_per_month: int | None = None
    max_context_links: int | None = None
    max_article_image_regenerations: int | None = None
    is_trial_plan: bool | None = None
    trial_period_days: int | None = Field(default=None, description="Trial validity in days when is_trial_plan is true.")
    extra: dict[str, Any] | None = None


class AdminBulkUserUpdateItem(BaseModel):
    user_id: str
    role: str | None = None
    subscription_type: str | None = None
    full_name: str | None = None


class AdminBulkUserUpdateResult(BaseModel):
    updated: list[AdminUserPublic]
    errors: list[dict[str, str]]


class PlanUpsert(BaseModel):
    name: str | None = None
    is_default: bool | None = None
    cost_monthly: float | None = None
    max_projects: int | None = None
    max_articles: int | None = None
    max_articles_per_day: int | None = None
    max_articles_per_month: int | None = None
    max_writing_prompts: int | None = None
    writing_prompt_char_limit: int | None = None
    max_image_prompts: int | None = None
    image_prompt_char_limit: int | None = None
    allow_scheduling: bool | None = None
    max_scheduled_per_month: int | None = None
    allow_export: bool | None = None
    max_export_per_month: int | None = None
    allow_bulk_upload: bool | None = None
    max_cluster_plans_per_month: int | None = None
    max_custom_research_per_month: int | None = None
    max_context_links: int | None = None
    max_article_image_regenerations: int | None = None
    is_trial_plan: bool | None = None
    trial_period_days: int | None = None
    extra: dict[str, Any] | None = None

