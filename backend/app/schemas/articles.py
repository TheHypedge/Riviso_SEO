from __future__ import annotations

from pydantic import BaseModel, Field


class ArticlePublic(BaseModel):
    id: str
    project_id: str
    title: str
    status: str = "pending"
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
    hasBody: bool | None = None


class ArticleCreate(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    keywords: list[str] = Field(default_factory=list, max_length=10)
    focus_keyphrase: str | None = Field(default=None, max_length=500)


class BulkActionRequest(BaseModel):
    action: str = Field(pattern="^(delete|change_status)$")
    article_ids: list[str] = Field(min_length=1, max_length=500)
    new_status: str | None = Field(default=None, max_length=32)


class BulkUploadRow(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    focus_keyphrase: str | None = Field(default=None, max_length=500)
    keywords: list[str] = Field(default_factory=list, max_length=10)


class BulkUploadRequest(BaseModel):
    rows: list[BulkUploadRow] = Field(min_length=1, max_length=500)


class BulkUploadResponse(BaseModel):
    ok: bool = True
    created: int
    skipped: int = 0
    articles: list[ArticlePublic] = Field(default_factory=list)


class ArticleDetailResponse(ArticlePublic):
    article: str = ""
    meta_title: str | None = None
    meta_description: str | None = None
    image_url: str | None = None


class ArticleUpdateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=500)
    keywords: list[str] | None = Field(default=None, max_length=10)
    focus_keyphrase: str | None = Field(default=None, max_length=500)
    article: str | None = None
    meta_title: str | None = Field(default=None, max_length=400)
    meta_description: str | None = Field(default=None, max_length=600)


class GenerateRequest(BaseModel):
    writing_prompt_id: str | None = Field(default=None, max_length=100)
    image_prompt_id: str | None = Field(default=None, max_length=100)
    focus_keyphrase: str | None = Field(default=None, max_length=500)
    generate_image: bool = True


class ScheduleRequest(BaseModel):
    wp_scheduled_at: str = Field(min_length=1, max_length=64)  # accepts ISO or "YYYY-MM-DD HH:MM"
    wp_status: str = Field(default="draft", max_length=16)  # draft|publish
    post_type: str = Field(default="posts", max_length=200)
    writing_prompt_id: str | None = Field(default=None, max_length=100)
    image_prompt_id: str | None = Field(default=None, max_length=100)
    generate_image: bool = True

