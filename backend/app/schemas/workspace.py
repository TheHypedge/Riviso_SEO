from __future__ import annotations

from pydantic import BaseModel, Field


class WorkspaceOverviewStats(BaseModel):
    project_count: int = 0
    total_articles: int = 0
    published: int = 0
    pending: int = 0
    draft: int = 0
    scheduled: int = 0
    upcoming_scheduled: int = 0


class WorkspaceFeedItem(BaseModel):
    id: str
    article_id: str
    project_id: str
    project_name: str
    title: str
    status_tag: str = Field(description="published | pending | draft | scheduled")
    sort_at: str | None = None
    image_url: str | None = None


class WorkspaceActivityDay(BaseModel):
    date: str
    published: int = 0
    pending: int = 0
    scheduled: int = 0


class ProjectSummary(BaseModel):
    project_id: str
    name: str
    website_url: str | None = None
    platform: str | None = None
    published: int = 0
    pending: int = 0
    draft: int = 0
    upcoming_scheduled: int = 0
    total_articles: int = 0
    last_activity_at: str | None = None


class WorkspaceOverviewResponse(BaseModel):
    stats: WorkspaceOverviewStats
    activity_series: list[WorkspaceActivityDay] = Field(default_factory=list)
    upcoming_scheduled: list[WorkspaceFeedItem] = Field(default_factory=list)
    recently_published: list[WorkspaceFeedItem] = Field(default_factory=list)
    pending: list[WorkspaceFeedItem] = Field(default_factory=list)
    drafts: list[WorkspaceFeedItem] = Field(default_factory=list)
    project_summaries: list[ProjectSummary] = Field(default_factory=list)
