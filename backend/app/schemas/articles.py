"""
Pydantic request/response models for article APIs.

Field constraints mirror validation enforced in route handlers (max lengths, keyword counts).
**Bulk upload:** See ``BulkUploadRequest.skip_project_duplicate_conflicts`` for the second-phase import flow.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class ArticleListPageResponse(BaseModel):
    """Paginated article list for the project Articles tab."""

    items: list["ArticlePublic"] = Field(default_factory=list)
    total: int = Field(ge=0, description="Total rows matching filters (derived status included when status filter is set).")
    page: int = Field(ge=1)
    per_page: int = Field(ge=1, le=5000)


class ArticleTitleRef(BaseModel):
    """Lightweight id/title pair for scheduled jobs and research reconciliation."""

    id: str
    title: str


class ArticlePublic(BaseModel):
    """Article fields exposed in list views and lightweight responses."""

    id: str
    project_id: str
    title: str
    status: str = Field(default="pending", description="Derived listing status (pending/draft/scheduled/published).")
    created_at: str | None = None
    updated_at: str | None = None
    posted_at: str | None = None
    keywords: list[str] = Field(default_factory=list)
    focus_keyphrase: str | None = None
    wp_scheduled_at: str | None = None
    wp_schedule_error: str | None = None
    wp_link: str | None = None
    gsc_status: str | None = None
    gsc_inspection_requested_at: str | None = None
    gsc_inspection_last_attempt_at: str | None = None
    gsc_inspection_error: str | None = None
    gsc_inspection_url: str | None = None
    # Feature 4 — Rank Monitor / Smart Refresh.
    monitor_status: str | None = Field(default=None, description="fresh | stale | unknown | empty when not registered yet.")
    monitor_last_checked_at: str | None = None
    # Feature 3 — Internal Linking telemetry; 0 in v1 until the matcher lands.
    internal_links_count: int | None = None
    hasBody: bool | None = Field(default=None, description="Optional hint that body HTML exists without loading full text.")


class ArticleCreate(BaseModel):
    """Payload for ``POST .../articles`` (single create)."""

    title: str = Field(min_length=1, max_length=500, description="Must be unique per project when normalized (NFKC + casefold).")
    keywords: list[str] = Field(default_factory=list, max_length=10)
    focus_keyphrase: str | None = Field(default=None, max_length=500)


class BulkActionRequest(BaseModel):
    """Bulk delete or bulk status change within one project."""

    action: str = Field(pattern="^(delete|change_status)$")
    article_ids: list[str] = Field(min_length=1, max_length=500)
    new_status: str | None = Field(default=None, max_length=32)


class BulkUploadRow(BaseModel):
    """One parsed spreadsheet row prior to insert."""

    title: str = Field(min_length=1, max_length=500)
    focus_keyphrase: str | None = Field(default=None, max_length=500)
    keywords: list[str] = Field(default_factory=list, max_length=10)


class BulkUploadRequest(BaseModel):
    """
    Parsed Excel rows for ``POST .../articles/bulk-upload``.

    After in-sheet deduplication, remaining titles are checked against the project. If any conflict
    exists and ``skip_project_duplicate_conflicts`` is false, the API responds with **409** and no rows
    are written. The client may retry with ``skip_project_duplicate_conflicts=true`` to insert only
    non-conflicting rows.
    """

    rows: list[BulkUploadRow] = Field(min_length=1, max_length=500)
    skip_project_duplicate_conflicts: bool = Field(
        default=False,
        description="If true, skip rows whose normalized title already exists in the project; insert the rest.",
    )


class BulkUploadResponse(BaseModel):
    """Summary counters returned after a bulk import attempt."""

    ok: bool = True
    created: int = Field(description="Number of new article documents inserted.")
    skipped: int = Field(default=0, description="Rows not imported (blank titles, in-sheet duplicates, or project conflicts when skipping).")
    articles: list[ArticlePublic] = Field(default_factory=list)
    duplicate_titles: list[str] = Field(
        default_factory=list,
        description="Display titles that appeared more than once in the upload; only the first row per title was kept.",
    )
    duplicate_rows_dropped: int = Field(default=0, description="Count of extra rows dropped due to in-sheet duplicate titles.")
    project_skipped_as_duplicates: int = Field(
        default=0,
        description="Rows skipped because the title matched an existing article (only when skip flag was used).",
    )


class ArticleDetailResponse(ArticlePublic):
    """Full editor payload including HTML body and meta."""

    article: str = ""
    meta_title: str | None = None
    meta_description: str | None = None
    image_url: str | None = None
    featured_image_regeneration_count: int = 0
    featured_image_regeneration_limit: int | None = None
    featured_image_regeneration_remaining: int | None = None
    featured_image_regeneration_unlimited: bool = True


class ArticleUpdateRequest(BaseModel):
    """Partial update; omitted fields are left unchanged."""

    title: str | None = Field(default=None, max_length=500)
    keywords: list[str] | None = Field(default=None, max_length=10)
    focus_keyphrase: str | None = Field(default=None, max_length=500)
    article: str | None = None
    meta_title: str | None = Field(default=None, max_length=400)
    meta_description: str | None = Field(default=None, max_length=600)


class GenerateRequest(BaseModel):
    """Options for on-demand generation (writing + optional image)."""

    writing_prompt_id: str | None = Field(default=None, max_length=100)
    image_prompt_id: str | None = Field(default=None, max_length=100)
    focus_keyphrase: str | None = Field(default=None, max_length=500)
    generate_image: bool = True


class RegenerateImageRequest(BaseModel):
    """Options for regenerating only the article featured image."""

    image_prompt_id: str | None = Field(default=None, max_length=100)


class ScheduleRequest(BaseModel):
    """WordPress scheduling and generation options."""

    wp_scheduled_at: str = Field(min_length=1, max_length=64, description="ISO or legacy 'YYYY-MM-DD HH:MM' string.")
    wp_status: str = Field(default="draft", max_length=16, description="draft or publish")
    post_type: str = Field(default="posts", max_length=200)
    writing_prompt_id: str | None = Field(default=None, max_length=100)
    image_prompt_id: str | None = Field(default=None, max_length=100)
    generate_image: bool = True


class BulkScheduleItem(BaseModel):
    """One article row in a bulk schedule request."""

    article_id: str = Field(min_length=1, max_length=100)
    wp_scheduled_at: str = Field(min_length=1, max_length=64)


class BulkScheduleRequest(BaseModel):
    """Schedule many articles in one request (weekly/monthly/manual bulk UI)."""

    items: list[BulkScheduleItem] = Field(min_length=1, max_length=500)
    wp_status: str = Field(default="draft", max_length=16)
    post_type: str = Field(default="posts", max_length=200)
    writing_prompt_id: str | None = Field(default=None, max_length=100)
    image_prompt_id: str | None = Field(default=None, max_length=100)
    generate_image: bool = True


class BulkScheduleFailure(BaseModel):
    article_id: str
    error: str


class BulkScheduleResponse(BaseModel):
    ok: bool = True
    scheduled: int = 0
    failed: list[BulkScheduleFailure] = Field(default_factory=list)
