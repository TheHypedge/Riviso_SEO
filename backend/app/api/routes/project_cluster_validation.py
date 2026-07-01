"""
Cluster validation route — Existence & Intent Validation engine.

POST /api/projects/{project_id}/validate-clusters

Used by the Cluster Planner UI right after a cluster plan finishes (and on
demand via "Re-check"). For each ``{temp_id, title, focus_keyphrase, keywords}``
in the batch we return whether it's NEW, SIMILAR (≥80% intent overlap with an
existing article or live-site URL), or a hard DUPLICATE.

The route never blocks on background work: if the project's WordPress site map
cache is older than 24h, a refresh is fired via ``asyncio.create_task`` and we
return immediately with whatever cached rows we already have. The next call
benefits from the warmer cache.
"""

from __future__ import annotations

import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.deps import get_current_user
from app.core.project_lookup import require_project_access
from app.legacy.storage import get_legacy_storage_module
from app.services.cluster_validation import ClusterValidationService


router = APIRouter(prefix="/projects/{project_id}", tags=["cluster-validation"])


def _require_project(*, st, user: dict, project_id: str) -> dict:
    # Cluster validation is part of the Cluster Planner — a content operation
    # active project collaborators must be able to use.
    return require_project_access(st=st, user=user, project_id=project_id, full=True, allow_collaborators=True)


class ValidateClusterItem(BaseModel):
    """One topic the UI wants validated."""

    temp_id: str = Field(min_length=1, max_length=128)
    title: str = Field(default="", max_length=500)
    focus_keyphrase: str = Field(default="", max_length=300)
    keywords: list[str] = Field(default_factory=list)


class ValidateClustersPayload(BaseModel):
    items: list[ValidateClusterItem] = Field(default_factory=list, max_length=64)
    similarity_threshold: float = Field(default=0.80, ge=0.50, le=0.99)


class ValidationOutcomeOut(BaseModel):
    status: Literal["new", "similar", "duplicate"]
    reason: str
    existing_url: str | None = None
    existing_article_id: str | None = None
    similarity: float | None = None


class ValidateClustersResponse(BaseModel):
    results: dict[str, ValidationOutcomeOut]
    cache_age_seconds: int | None = None
    cache_refresh_started: bool = False
    embedding_used: bool = False
    elapsed_ms: int = 0


@router.post("/validate-clusters", response_model=ValidateClustersResponse)
async def validate_clusters(
    project_id: str,
    payload: ValidateClustersPayload,
    user: dict = Depends(get_current_user),
) -> ValidateClustersResponse:
    """
    Existence & Intent Validation for a batch of cluster topic candidates.

    Designed to complete in well under 500ms on warm caches. Embedding fallback
    is best-effort: if it errors, we still return exact-match results so the UI
    can render *something* rather than spinning forever.
    """
    st = get_legacy_storage_module()
    proj = _require_project(st=st, user=user, project_id=project_id)

    started = time.perf_counter()
    svc = ClusterValidationService(project=proj)
    out = await svc.validate(
        items=[item.model_dump() for item in payload.items],
        similarity_threshold=payload.similarity_threshold,
    )
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    out["elapsed_ms"] = elapsed_ms
    return ValidateClustersResponse(**out)
