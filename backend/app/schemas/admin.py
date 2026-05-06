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
    created_at: str | None = None
    last_activity_at: str | None = None


class AdminUserUpdate(BaseModel):
    role: str | None = None
    subscription_type: str | None = None
    full_name: str | None = None
    phone: str | None = None
    timezone: str | None = None
    address: str | None = None


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
    extra: dict[str, Any] | None = None


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
    extra: dict[str, Any] | None = None

