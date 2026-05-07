from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


ResearchIntent = Literal["informational", "commercial", "transactional", "navigational"]
ResearchTone = Literal[
    "professional",
    "friendly",
    "authoritative",
    "conversational",
    "technical",
    "casual",
    "formal",
    "witty",
    "humorous",
    "empathetic",
    "persuasive",
    "inspirational",
    "confident",
    "educational",
    "storytelling",
    "neutral",
    "enthusiastic",
    "analytical",
]


class ResearchIdeasRequest(BaseModel):
    """
    Inputs for the Research module.

    The frontend sends curation fields plus seed keywords/topics. The backend may augment these with
    SERP scraping and historical snapshots to improve quality.
    """

    brand_niche: str | None = None
    intent: ResearchIntent = "informational"
    tone: ResearchTone = "professional"
    seed_keywords: list[str] = Field(default_factory=list, description="Seed keywords/topics (1 per line).")
    country: str | None = Field(default="US", description="Market country code (gl).")
    language: str | None = Field(default="en", description="Language code (hl).")
    max_ideas: int | None = Field(default=30, ge=5, le=80)


class ResearchIdeaRow(BaseModel):
    id: str
    title: str
    focus_keyphrase: str
    keywords: list[str] = Field(default_factory=list, description="Supporting keywords (max 10 used on import).")
    score: float | None = None
    rationale: str | None = None


class ResearchIdeasResponse(BaseModel):
    ok: bool = True
    ideas: list[ResearchIdeaRow] = Field(default_factory=list)
    keyword_analysis: dict | None = None
    scraped_queries: list[str] = Field(default_factory=list)
    used_history_count: int = 0
