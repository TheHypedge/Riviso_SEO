"""Pydantic models for the WordPress Sync & Self-Healing module."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ArticleSyncResult(BaseModel):
    """Sync result for a single article."""

    article_id: str
    article_title: str
    wp_post_id: int | None = None
    wp_link: str | None = None
    sync_status: str = "unknown"
    issues: list[str] = Field(default_factory=list)
    wp_live_status: str | None = None
    wp_live_slug: str | None = None
    wp_live_link: str | None = None
    last_synced_at: str | None = None
    last_successful_sync: str | None = None
    last_fix_at: str | None = None
    repair_count: int = 0
    ignored_sync_issue: bool = False
    sync_history: list[dict] = Field(default_factory=list)


class ProjectSyncResponse(BaseModel):
    """Summary returned after syncing all published articles in a project."""

    project_id: str
    total: int
    healthy: int
    needs_attention: int
    by_status: dict[str, int] = Field(default_factory=dict)
    results: list[ArticleSyncResult] = Field(default_factory=list)
    synced_at: str


class RepairResult(BaseModel):
    """Outcome of a single article repair."""

    article_id: str
    ok: bool
    operation: str
    error: str | None = None
    new_wp_post_id: int | None = None
    new_wp_link: str | None = None


class BulkRepairResponse(BaseModel):
    """Summary returned after bulk repair."""

    repaired: int = 0
    failed: int = 0
    skipped: int = 0
    results: list[RepairResult] = Field(default_factory=list)


class SyncIgnoreRequest(BaseModel):
    ignored: bool = True
