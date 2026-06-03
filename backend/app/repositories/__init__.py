"""Typed repositories + light domain models (P4.6)."""

from __future__ import annotations

from app.repositories.base import (
    ArticleRepository,
    ProjectRepository,
    ScheduledJobRepository,
    UserRepository,
)
from app.repositories.models import ArticleRef, ProjectRef

__all__ = [
    "ArticleRepository",
    "ProjectRepository",
    "ScheduledJobRepository",
    "UserRepository",
    "ArticleRef",
    "ProjectRef",
]
