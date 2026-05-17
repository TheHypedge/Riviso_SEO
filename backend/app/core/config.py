"""
Central configuration loaded from environment variables and optional ``.env`` files.

**Resolution order:** variables set in the process environment override values in
``backend/.env``, then repo-root ``.env``. Use ``ENVIRONMENT=production`` for
live deployments; see ``backend/.env.example`` for a production checklist.
"""

from __future__ import annotations

from typing import Any

from pydantic import AnyUrl, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _clean_env_str(v: Any) -> Any:
    """
    Strip whitespace and a single layer of surrounding ASCII quotes from string envs.

    Common VPS / docker-compose ``.env`` mistake: ``GOOGLE_OAUTH_CLIENT_SECRET="abc"`` —
    pydantic-settings keeps the literal quotes, so the OAuth call later fails. We strip
    them once here so every read site sees a clean value.
    """
    if not isinstance(v, str):
        return v
    s = v.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        s = s[1:-1].strip()
    return s


class Settings(BaseSettings):
    """Application settings (12-factor style: configure via env, not code)."""

    # Load env from backend/.env first, then repo-root .env (common in this repo).
    model_config = SettingsConfigDict(env_file=(".env", "../.env"), env_file_encoding="utf-8", extra="ignore")

    app_name: str = Field(default="auto-articles", description="Service name for logs and health responses.")
    environment: str = Field(
        default="development",
        description="One of development, staging, production. Controls docs exposure and startup checks.",
    )
    api_prefix: str = Field(default="/api", description="Mount path for the REST API router.")

    # Security
    secret_key: str = Field(
        default="dev-insecure-change-me",
        description="JWT signing secret; must be a long random string in production.",
    )
    access_token_ttl_seconds: int = 60 * 60  # 1 hour
    refresh_token_ttl_seconds: int = 60 * 60 * 24 * 30  # 30 days
    cookie_secure: bool = False
    cookie_domain: str | None = None
    cookie_samesite: str = "lax"  # lax|strict|none

    # CORS (comma-separated)
    # Include local dev + common production domains as safe defaults.
    # Override via env `CORS_ORIGINS` on deployments that need stricter allowlists.
    cors_origins: str = ",".join(
        [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "https://riviso.com",
            "https://www.riviso.com",
            "https://riviso.cloud",
            "https://www.riviso.cloud",
        ]
    )

    # Datastores
    postgres_dsn: str = "postgresql+asyncpg://app:app@localhost:5432/auto_articles"
    redis_url: str = "redis://localhost:6379/0"

    # External (placeholders; keep secrets only in env)
    public_base_url: AnyUrl | None = None
    frontend_base_url: AnyUrl | None = None

    # Google OAuth (Search Console). Use explicit ``validation_alias`` so case-sensitive
    # pydantic-settings forks or proxied envs still resolve the canonical UPPER_SNAKE name.
    google_oauth_client_id: str = Field(default="", validation_alias="GOOGLE_OAUTH_CLIENT_ID")
    google_oauth_client_secret: str = Field(default="", validation_alias="GOOGLE_OAUTH_CLIENT_SECRET")

    # Google Indexing API (service account JSON; raw JSON or base64 JSON)
    google_indexing_service_account_json: str = Field(default="", validation_alias="GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON")

    # Generation queue (Redis-backed; falls back to in-process queue when Redis is down)
    max_concurrent_generations: int = Field(
        default=3,
        validation_alias="MAX_CONCURRENT_GENERATIONS",
        description="Max simultaneous OpenAI article/image generations per API process.",
    )
    generation_queue_enabled: bool = Field(
        default=True,
        validation_alias="GENERATION_QUEUE_ENABLED",
        description="When true, background prep uses the generation queue instead of raw asyncio tasks.",
    )
    generation_worker_poll_seconds: float = Field(
        default=0.5,
        validation_alias="GENERATION_WORKER_POLL_SECONDS",
        description="Queue poll interval for the in-process generation worker.",
    )
    scheduler_due_jobs_limit: int = Field(
        default=200,
        validation_alias="SCHEDULER_DUE_JOBS_LIMIT",
        description="Max due scheduled jobs loaded per scheduler tick.",
    )

    # OpenAI (generation)
    openai_api_key: str = Field(default="", validation_alias="OPENAI_API_KEY")
    openai_text_model: str = "gpt-4.1-mini"
    openai_image_model: str = "gpt-image-1"
    # 1536-dim, fastest + cheapest tier; used by the cluster-validation engine
    # to detect "intent overlap" between proposed topics and existing content.
    openai_embedding_model: str = "text-embedding-3-small"

    # Comma-separated phrases forbidden in generated article bodies/headings (merged with built-in defaults).
    generation_banned_phrases: str = Field(
        default="",
        validation_alias="GENERATION_BANNED_PHRASES",
        description=(
            "Extra banned labels for AI generation (e.g. 'AEO-Optimized,For GEO'). "
            "Built-in defaults always apply; this env extends the list."
        ),
    )

    @field_validator(
        "secret_key",
        "google_oauth_client_id",
        "google_oauth_client_secret",
        "openai_api_key",
        mode="before",
    )
    @classmethod
    def _strip_secret_envs(cls, v: Any) -> Any:
        """
        Remove a single surrounding pair of ASCII quotes and whitespace from secret-like envs.

        Operators frequently quote secrets in ``.env`` (e.g. ``GOOGLE_OAUTH_CLIENT_SECRET="GOCSPX-..."``).
        Without this normalisation, every downstream comparison would have to be quote-aware.
        """
        return _clean_env_str(v)

    @property
    def is_production(self) -> bool:
        """True when ``ENVIRONMENT`` is set to production (case-insensitive)."""
        return (self.environment or "").strip().lower() == "production"

    @property
    def google_oauth_configured(self) -> bool:
        """True when both Google OAuth client envs are present (post-strip)."""
        return bool((self.google_oauth_client_id or "").strip() and (self.google_oauth_client_secret or "").strip())

    @property
    def google_oauth_client_id_fingerprint(self) -> str:
        """
        Safe, non-secret hint of the loaded client id (first 12 chars + length).

        Surfaced via ``/api/health`` so operators can verify the running process actually
        loaded the expected env value without exposing the secret half of the credential.
        """
        cid = (self.google_oauth_client_id or "").strip()
        if not cid:
            return ""
        head = cid[:12]
        return f"{head}…(len={len(cid)})"


settings = Settings()

