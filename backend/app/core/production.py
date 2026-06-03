"""
Runtime checks and logging for production deployments.

Call :func:`run_startup_checks` once during application startup. It does not
replace infrastructure checks (TLS, WAF, secrets stores) but surfaces common
misconfigurations early in logs.
"""

from __future__ import annotations

import logging
import os

from app.core.config import Settings
from app.services import shopify_oauth

log = logging.getLogger("app.production")


def _env_flag_enabled(name: str) -> bool:
    """True when an env var is set to a truthy string (1/true/yes/on)."""
    return (os.environ.get(name) or "").strip().lower() in ("1", "true", "yes", "on")

# Values that must never be used when ``ENVIRONMENT=production``.
_INSECURE_SECRET_PLACEHOLDERS = frozenset(
    {
        "",
        "dev-insecure-change-me",
        "change-me",
        "secret",
        "your-secret-key",
    }
)


def run_startup_checks(settings: Settings) -> None:
    """
    Log environment summary and warn on unsafe production settings.

    Warnings are non-fatal so misconfigured dev boxes still start; fix issues
    before accepting real traffic.
    """
    env = (settings.environment or "development").strip().lower()
    log.info(
        "Application starting: service=%r environment=%r",
        settings.app_name,
        env,
    )

    # Always emit GSC OAuth state so operators can confirm env loading from logs alone.
    if settings.google_oauth_configured:
        log.info(
            "GSC OAuth configured: client_id=%s",
            settings.google_oauth_client_id_fingerprint or "(set)",
        )
    else:
        log.warning(
            "GSC OAuth not configured: GOOGLE_OAUTH_CLIENT_ID/SECRET missing from this process. "
            "Search Console connect will return 400 until both env vars are set and the backend "
            "service is restarted."
        )

    shopify_issue = shopify_oauth.oauth_misconfiguration_reason()
    if shopify_issue:
        log.warning("Shopify OAuth misconfigured: %s", shopify_issue)
    elif shopify_oauth.oauth_configured():
        log.info("Shopify OAuth credentials present (Client ID and Client secret)")

    if env != "production":
        return

    # Fatal: a weak/placeholder JWT signing key in production lets anyone forge
    # access tokens. Refuse to boot rather than silently accepting it.
    key = (settings.secret_key or "").strip()
    if key in _INSECURE_SECRET_PLACEHOLDERS or len(key) < 32:
        raise RuntimeError(
            "PRODUCTION: SECRET_KEY is missing, too short (<32 chars), or still a dev placeholder. "
            "Set a long random SECRET_KEY in the environment before starting in production."
        )

    # Fatal: insecure transport escape hatches must never be enabled in production.
    if _env_flag_enabled("MONGODB_TLS_INSECURE"):
        raise RuntimeError(
            "PRODUCTION: MONGODB_TLS_INSECURE is enabled. This disables MongoDB TLS certificate "
            "verification and must not be used in production. Unset it before starting."
        )
    if _env_flag_enabled("OAUTHLIB_INSECURE_TRANSPORT"):
        raise RuntimeError(
            "PRODUCTION: OAUTHLIB_INSECURE_TRANSPORT is enabled. This allows OAuth over plain HTTP "
            "and must not be used in production. Unset it before starting."
        )

    if not settings.cookie_secure:
        log.warning(
            "PRODUCTION: COOKIE_SECURE is false. Set COOKIE_SECURE=true when serving the API over HTTPS."
        )

    if not (settings.openai_api_key or "").strip():
        log.warning(
            "PRODUCTION: OPENAI_API_KEY is empty; article generation and related features will fail."
        )
