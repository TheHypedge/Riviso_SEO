from __future__ import annotations

from pydantic import AnyUrl, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Load env from backend/.env first, then repo-root .env (common in this repo).
    model_config = SettingsConfigDict(env_file=(".env", "../.env"), env_file_encoding="utf-8", extra="ignore")

    app_name: str = "auto-articles"
    environment: str = "development"  # development|staging|production
    api_prefix: str = "/api"

    # Security
    secret_key: str = "dev-insecure-change-me"
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

    # Google OAuth (Search Console)
    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""

    # Google Indexing API (service account JSON; raw JSON or base64 JSON)
    google_indexing_service_account_json: str = Field(default="", validation_alias="GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON")

    # OpenAI (generation)
    openai_api_key: str = ""
    openai_text_model: str = "gpt-4.1-mini"
    openai_image_model: str = "gpt-image-1"


settings = Settings()

