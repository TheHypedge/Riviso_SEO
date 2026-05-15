"""System routes: health checks for orchestration and uptime probes."""

from __future__ import annotations

from fastapi import APIRouter

from app.core.config import settings
from app.schemas.health import HealthResponse
from app.services.article_generation import GENERATION_REVISION

router = APIRouter()


@router.get("/health", response_model=HealthResponse, tags=["system"])
async def health() -> HealthResponse:
    """
    Cheap liveness probe; extend with DB pings only if your orchestrator needs readiness separation.

    ``gsc_oauth_configured`` and ``gsc_oauth_client_id_fingerprint`` are surfaced to make
    VPS misconfiguration diagnosable with a single curl: if the fingerprint is empty after
    you set ``GOOGLE_OAUTH_CLIENT_ID``/``SECRET``, the FastAPI process never picked the
    values up — almost always a missed restart of the backend service.
    """
    return HealthResponse(
        status="ok",
        service=settings.app_name,
        environment=settings.environment,
        openai_configured=bool((settings.openai_api_key or "").strip()),
        gsc_oauth_configured=settings.google_oauth_configured,
        gsc_oauth_client_id_fingerprint=settings.google_oauth_client_id_fingerprint,
        generation_revision=GENERATION_REVISION,
    )

