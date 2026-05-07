from __future__ import annotations

from pydantic import AnyUrl, BaseModel, Field


class ProjectPublic(BaseModel):
    id: str
    owner_user_id: str
    name: str
    website_url: str | None = None
    brand_identity: str | None = None
    niche_identifier: str | None = None


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    website_url: str | None = Field(default=None, max_length=2048)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    website_url: str | None = Field(default=None, max_length=2048)
    brand_identity: str | None = Field(default=None, max_length=20000)
    niche_identifier: str | None = Field(default=None, max_length=20000)
