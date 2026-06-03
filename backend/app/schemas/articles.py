"""
Pydantic request/response models for article APIs.

Field constraints mirror validation enforced in route handlers (max lengths, keyword counts).
**Bulk upload:** See ``BulkUploadRequest.skip_project_duplicate_conflicts`` for the second-phase import flow.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class ArticleListItem(BaseModel):
    """Minimal fields for the paginated Articles table (no body HTML or large assets)."""

    id: str
    project_id: str
    title: str
    status: str = Field(default="pending", description="Derived listing status.")
    keywords: list[str] = Field(default_factory=list)
    focus_keyphrase: str | None = None
    gsc_status: str | None = Field(default=None, description="For indexing tooltip in the list UI.")
    wp_link: str | None = Field(default=None, description="Live URL when published; enables indexing/monitor actions.")
    monitor_status: str | None = Field(default=None, description="Rank monitor state for refresh actions.")


class ArticleListPageResponse(BaseModel):
    """Paginated article list for the project Articles tab."""

    items: list[ArticleListItem] = Field(default_factory=list)
    total: int = Field(ge=0, description="Total rows matching filters (derived status included when status filter is set).")
    page: int = Field(ge=1)
    per_page: int = Field(ge=1, le=100)


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
    wp_post_id: int | str | None = Field(
        default=None,
        description="WordPress post ID when this article has been published to the connected site.",
    )
    wp_rest_base: str | None = Field(
        default=None,
        description="WordPress REST collection used for this post (e.g. posts, pages).",
    )
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
    image_url: str | None = Field(default=None, description="Featured image URL when generated or set.")
    shopify_blog_id: int | None = Field(default=None, description="Shopify blog id when published to Shopify.")
    shopify_article_id: int | None = Field(default=None, description="Shopify article id when published to Shopify.")
    shopify_link: str | None = Field(default=None, description="Public Shopify blog article URL when available.")
    wp_last_wp_status: str | None = Field(
        default=None,
        description="Last known WordPress REST status (publish, draft, trash, etc.).",
    )
    wp_modified_at: str | None = Field(default=None, description="Last modified timestamp from WordPress.")
    wp_synced_at: str | None = Field(default=None, description="When Riviso last pulled this post from WordPress.")


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
    has_featured_image: bool = Field(
        default=False,
        description="True when a featured image exists but was omitted from this payload (load /featured-image).",
    )
    featured_image_regeneration_count: int = 0
    featured_image_regeneration_limit: int | None = None
    featured_image_regeneration_remaining: int | None = None
    featured_image_regeneration_unlimited: bool = True
    topic_cluster_id: str | None = Field(
        default=None,
        description="Topic cluster id when this article was imported from a pillar/cluster map.",
    )
    topic_slot_id: str | None = Field(default=None, description="Pillar or cluster slot id within the topic cluster.")
    topic_role: str | None = Field(default=None, description="pillar | cluster when imported from a topic cluster.")
    cluster_link_context: dict | None = Field(
        default=None,
        description="Sibling link targets with live-on-WordPress status for cluster-aware internal linking.",
    )
    integrity_ai_percentage: float | None = Field(
        default=None,
        description="Last integrity audit AI-risk percentage (0–100).",
    )
    integrity_flagged_paragraphs: list[dict] | None = Field(
        default=None,
        description="Flagged paragraph blocks from the last integrity audit.",
    )
    integrity_last_audited_at: str | None = Field(
        default=None,
        description="UTC timestamp of the last integrity audit.",
    )


class ArticleBodyResponse(BaseModel):
    """Markdown/HTML body only — loaded after editor shell for faster first paint."""

    article: str = ""


class ArticleFeaturedImageResponse(BaseModel):
    image_url: str = Field(description="HTTP(S) URL or inline data URL for the featured image.")


class ArticleGenerationStatusResponse(BaseModel):
    """Minimal fields for polling async generation / image jobs without loading body or image bytes."""

    id: str
    status: str = "pending"
    generated_at: str | None = None
    has_body: bool = False
    has_featured_image: bool = False
    featured_image_regeneration_count: int = 0
    # Non-empty when the background worker failed — frontend polls this to
    # surface the error immediately instead of waiting for a 10-minute timeout.
    generation_error: str | None = None


class ArticleUpdateRequest(BaseModel):
    """Partial update; omitted fields are left unchanged."""

    title: str | None = Field(default=None, max_length=500)
    keywords: list[str] | None = Field(default=None, max_length=10)
    focus_keyphrase: str | None = Field(default=None, max_length=500)
    article: str | None = None
    meta_title: str | None = Field(default=None, max_length=400)
    meta_description: str | None = Field(default=None, max_length=600)


class MappedShopifyProductInput(BaseModel):
    """Optional Shopify products selected in the UI for mapped generation."""

    title: str = Field(min_length=1, max_length=500)
    handle: str = Field(min_length=1, max_length=256)
    featured_image_url: str | None = Field(default=None, max_length=4000)
    image_url: str | None = Field(
        default=None,
        max_length=4000,
        description="Alias for featured_image_url when sent from the frontend.",
    )


class MappedWordPressPageInput(BaseModel):
    """Optional WordPress pages/posts selected for internal-link mapped generation.

    Both ``title`` / ``post_url`` fields are optional here so a missing or
    incomplete entry doesn't cause a hard 422. The route handler filters out
    any items where both effective title and URL are empty before use.
    """

    title: str = Field(default="", max_length=500)
    post_url: str = Field(default="", max_length=2048)
    post_title: str | None = Field(default=None, max_length=500, description="Alias for title.")
    url: str | None = Field(default=None, max_length=2048, description="Alias for post_url.")
    featured_image_url: str | None = Field(default=None, max_length=4000)
    image_url: str | None = Field(default=None, max_length=4000)
    post_id: str | None = Field(default=None, max_length=64)

    def effective_title(self) -> str:
        return (self.title or self.post_title or "").strip()

    def effective_url(self) -> str:
        return (self.post_url or self.url or "").strip()

    def is_valid(self) -> bool:
        return bool(self.effective_title() and self.effective_url())


class GenerateRequest(BaseModel):
    """Options for on-demand generation (writing + optional image)."""

    writing_prompt_id: str | None = Field(default=None, max_length=100)
    image_prompt_id: str | None = Field(default=None, max_length=100)
    focus_keyphrase: str | None = Field(default=None, max_length=500)
    generate_image: bool = True
    mapped_products: list[MappedShopifyProductInput] | None = Field(
        default=None,
        max_length=12,
        description="Shopify only: products to weave into the article and optional img2img reference.",
    )
    mapped_pages: list[MappedWordPressPageInput] | None = Field(
        default=None,
        max_length=12,
        description="WordPress only: site pages/posts to link in the article and optional img2img reference.",
    )


class ShopifyPublishRequest(BaseModel):
    """Publish an article to Shopify Blog (draft or live publish)."""

    blog_id: int | None = Field(
        default=None,
        description="Target Shopify blog id. When omitted, the first blog from the synced catalog is used.",
    )
    publish: bool = Field(default=True, description="If true, publish immediately; otherwise create as draft.")


class RegenerateImageRequest(BaseModel):
    """Options for regenerating only the article featured image."""

    image_prompt_id: str | None = Field(default=None, max_length=100)
    custom_image_prompt: str | None = Field(
        default=None,
        max_length=8000,
        description="One-off prompt text for this regeneration only (not saved to project prompts).",
    )


class ScheduleRequest(BaseModel):
    """WordPress scheduling and generation options."""

    wp_scheduled_at: str = Field(min_length=1, max_length=64, description="ISO or legacy 'YYYY-MM-DD HH:MM' string.")
    wp_status: str = Field(default="draft", max_length=16, description="draft or publish")
    post_type: str = Field(default="posts", max_length=200)
    writing_prompt_id: str | None = Field(default=None, max_length=100)
    image_prompt_id: str | None = Field(default=None, max_length=100)
    generate_image: bool = True
    # Client-supplied IANA timezone (e.g. "Asia/Kolkata"). When present, takes
    # precedence over the stored profile timezone so scheduling works correctly
    # even when the user has never explicitly saved their profile timezone.
    user_timezone: str | None = Field(default=None, max_length=64)


class BulkScheduleItem(BaseModel):
    """One article row in a bulk schedule request."""

    article_id: str = Field(min_length=1, max_length=100)
    wp_scheduled_at: str = Field(min_length=1, max_length=64)


class BulkScheduleRequest(BaseModel):
    """Schedule many articles in one request (weekly/monthly/manual bulk UI)."""

    items: list[BulkScheduleItem] = Field(min_length=1, max_length=500)
    cadence: str | None = Field(default=None, max_length=16)  # manual | weekly | monthly
    wp_status: str = Field(default="draft", max_length=16)
    post_type: str = Field(default="posts", max_length=200)
    writing_prompt_id: str | None = Field(default=None, max_length=100)
    image_prompt_id: str | None = Field(default=None, max_length=100)
    generate_image: bool = True
    user_timezone: str | None = Field(default=None, max_length=64)


class BulkScheduleFailure(BaseModel):
    article_id: str
    error: str


class BulkScheduleResponse(BaseModel):
    ok: bool = True
    scheduled: int = 0
    failed: list[BulkScheduleFailure] = Field(default_factory=list)
