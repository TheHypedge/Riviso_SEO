"""Response model for the public ``/api/health`` probe (load balancers & monitoring)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    """Liveness metadata; does not perform deep dependency checks (keeps the endpoint fast)."""

    status: str = Field(description="Always 'ok' when the process responds.")
    service: str = Field(description="Application name from settings.")
    environment: str = Field(description="ENVIRONMENT value, e.g. development or production.")
    openai_configured: bool = Field(default=False, description="True when OPENAI_API_KEY is non-empty.")
