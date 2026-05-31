"""System routes: health checks for orchestration and uptime probes."""

from __future__ import annotations

from fastapi import APIRouter

from app.core.config import settings
from app.legacy.storage import get_legacy_storage_module
from app.schemas.health import HealthResponse
from app.services.article_generation import GENERATION_REVISION
from app.services.storage_db import ping_storage

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
    st = get_legacy_storage_module()
    mode = ""
    init_err = ""
    try:
        if hasattr(st, "storage_mode"):
            mode = str(st.storage_mode() or "")
        if hasattr(st, "storage_init_error"):
            init_err = str(st.storage_init_error() or "")
    except Exception:
        # Keep endpoint cheap; if storage is broken, mode/error can be blank.
        pass

    database_ok = False
    database_error = ""
    if (mode or "").strip().lower() == "mongo":
        try:
            ping_storage()
            database_ok = True
        except Exception as e:
            database_error = str(e)[:240]

    overall = "ok" if database_ok or (mode or "").strip().lower() != "mongo" else "degraded"

    return HealthResponse(
        status=overall,
        service=settings.app_name,
        environment=settings.environment,
        openai_configured=bool((settings.openai_api_key or "").strip()),
        gsc_oauth_configured=settings.google_oauth_configured,
        gsc_oauth_client_id_fingerprint=settings.google_oauth_client_id_fingerprint,
        generation_revision=GENERATION_REVISION,
        storage_mode=mode,
        storage_init_error=init_err,
        database_ok=database_ok,
        database_error=database_error,
    )

