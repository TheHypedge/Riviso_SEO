from __future__ import annotations

from pydantic import BaseModel, Field


class PromptItem(BaseModel):
    id: str
    name: str
    text: str


class PromptListResponse(BaseModel):
    items: list[PromptItem]
    default_id: str | None = None


class PromptCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=100_000)


class PromptUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    text: str | None = Field(default=None, max_length=100_000)


class SetDefaultRequest(BaseModel):
    id: str = Field(min_length=1, max_length=100)

