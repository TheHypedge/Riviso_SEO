from __future__ import annotations

from pydantic import AnyUrl, BaseModel, Field


class ProjectPublic(BaseModel):
    id: str
    owner_user_id: str
    name: str
    website_url: str | None = None


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    website_url: str | None = Field(default=None, max_length=2048)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    website_url: str | None = Field(default=None, max_length=2048)
