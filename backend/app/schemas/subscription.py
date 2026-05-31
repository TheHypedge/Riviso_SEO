from __future__ import annotations

from pydantic import BaseModel, Field


class SubscriptionUsagePublic(BaseModel):
    articlesGeneratedToday: int = 0
    articlesGeneratedThisMonth: int = 0
    regenerationsThisMonth: int = 0
    schedulesThisMonth: int = 0
    exportsThisMonth: int = 0


class PlanFeaturesPublic(BaseModel):
    projectsMax: int | None = None
    articlesPerMonth: int | None = None
    articlesPerDay: int | None = None
    regenerationsPerMonth: int | None = None
    schedulesMax: int | None = None
    allowBulkUpload: bool = True
    allowBulkExport: bool = True


class SubscriptionStatusPublic(BaseModel):
    status: str = Field(description="active | trial_expired | no_trial")
    plan_key: str
    plan_name: str | None = None
    trial_start_date: str | None = None
    trial_end_date: str | None = None
    remaining_days: int = 0
    remaining_hours: int = 0
    remaining_minutes: int = 0
    is_trial_plan: bool = False
    usage: SubscriptionUsagePublic = Field(default_factory=SubscriptionUsagePublic)
    features: PlanFeaturesPublic = Field(default_factory=PlanFeaturesPublic)
