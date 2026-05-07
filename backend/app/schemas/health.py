"""Response model for the public ``/api/health`` probe (load balancers & monitoring)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    """Liveness metadata; does not perform deep dependency checks (keeps the endpoint fast)."""

    status: str = Field(description="Always 'ok' when the process responds.")
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
