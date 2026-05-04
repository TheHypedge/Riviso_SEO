"""System routes: health checks for orchestration and uptime probes."""

from __future__ import annotations

from fastapi import APIRouter

from app.core.config import settings
from app.schemas.health import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse, tags=["system"])
async def health() -> HealthResponse:
    """Cheap liveness probe; extend with DB pings only if your orchestrator needs readiness separation."""
    return HealthResponse(
        status="ok",
        service=settings.app_name,
        environment=settings.environment,
        openai_configured=bool((settings.openai_api_key or "").strip()),
    )

