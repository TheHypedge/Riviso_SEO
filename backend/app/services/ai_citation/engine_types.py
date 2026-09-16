"""Shared result shape every ai_citation engine adapter returns."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class EngineResult:
    response_text: str = ""
    citation_urls: list[str] = field(default_factory=list)
    error: str | None = None
