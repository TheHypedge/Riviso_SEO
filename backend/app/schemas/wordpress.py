from __future__ import annotations

from pydantic import BaseModel, Field


class WordpressPostType(BaseModel):
    rest_base: str = Field(min_length=1, max_length=200)
    name: str = Field(default="", max_length=200)
    taxonomies: list[str] = Field(default_factory=list)


class WordpressCategory(BaseModel):
    id: int
    name: str = Field(default="", max_length=200)

