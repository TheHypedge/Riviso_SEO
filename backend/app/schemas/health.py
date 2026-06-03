"""Response model for the public ``/api/health`` probe (load balancers & monitoring)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class LivenessResponse(BaseModel):
    """Public liveness probe payload — no internal details (see S1.11)."""

    status: str = Field(default="ok", description="Always 'ok' when the process is serving.")
    service: str = Field(description="Application name from settings.")


class HealthResponse(BaseModel):
    """Liveness metadata; does not perform deep dependency checks (keeps the endpoint fast)."""

    status: str = Field(description="'ok' when healthy; 'degraded' when Mongo is configured but unreachable.")
    service: str = Field(description="Application name from settings.")
    environment: str = Field(description="ENVIRONMENT value, e.g. development or production.")
    openai_configured: bool = Field(default=False, description="True when OPENAI_API_KEY is non-empty.")
    gsc_oauth_configured: bool = Field(
        default=False,
        description=(
            "True when both GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are loaded "
            "by the running process. Use this from the VPS to verify env loading without "
            "exposing secrets."
        ),
    )
    gsc_oauth_client_id_fingerprint: str = Field(
        default="",
        description=(
            "Non-secret hint of the loaded client id (first 12 chars + length). Empty when not configured."
        ),
    )
    generation_revision: str = Field(
        default="",
        description=(
            "Code revision for article generation/token estimation. After deploying scheduled-job "
            "fixes, production should show ``2026-05-15-image-prompt-param`` (not an older value or empty)."
        ),
    )

    storage_mode: str = Field(
        default="",
        description="Current storage backend: 'mongo' for live data, 'json' for local fallback.",
    )
    storage_init_error: str = Field(
        default="",
        description="Non-secret storage init error string when storage_mode != 'mongo'.",
    )
    database_ok: bool = Field(
        default=False,
        description="True when a live Mongo ping succeeded (readiness). False for json fallback or unreachable DB.",
    )
    database_error: str = Field(
        default="",
        description="Truncated ping error when database_ok is false and storage_mode is mongo.",
    )
