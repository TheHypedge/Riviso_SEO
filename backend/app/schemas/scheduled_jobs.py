from __future__ import annotations

from pydantic import BaseModel, Field


class ScheduledJobPublic(BaseModel):
    id: str
    project_id: str
    article_id: str
    run_at: str
    post_type: str = "posts"
    wp_status: str = "draft"
    category_ids: list[int] = Field(default_factory=list)
    writing_prompt_id: str | None = None
    image_prompt_id: str | None = None
    generate_image: bool = True
    state: str = "scheduled"  # scheduled|posting|posted|failed|cancelled
    last_error: str | None = None
    attempts: int = 0
    last_attempt_at: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    wp_post_id: str | None = None
    wp_link: str | None = None


class ScheduledJobUpdate(BaseModel):
    run_at: str | None = Field(default=None, max_length=64)
    post_type: str | None = Field(default=None, max_length=200)
    wp_status: str | None = Field(default=None, max_length=16)
    category_ids: list[int] | None = None
    writing_prompt_id: str | None = Field(default=None, max_length=100)
    image_prompt_id: str | None = Field(default=None, max_length=100)
    generate_image: bool | None = None
    user_timezone: str | None = Field(default=None, max_length=64)


class ScheduledJobPostNow(BaseModel):
    writing_prompt_id: str | None = Field(default=None, max_length=100)
    image_prompt_id: str | None = Field(default=None, max_length=100)
    generate_image: bool | None = None

