"""
Runtime checks and logging for production deployments.

Call :func:`run_startup_checks` once during application startup. It does not
replace infrastructure checks (TLS, WAF, secrets stores) but surfaces common
misconfigurations early in logs.
"""

from __future__ import annotations

import logging

from app.core.config import Settings
from app.services import shopify_oauth

log = logging.getLogger("app.production")

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

    key = (settings.secret_key or "").strip()
    if key in _INSECURE_SECRET_PLACEHOLDERS or len(key) < 32:
        log.error(
            "PRODUCTION: SECRET_KEY is missing, too short (<32 chars), or still a dev placeholder. "
            "JWT signing is weak — set a long random SECRET_KEY in the environment."
        )

    if not settings.cookie_secure:
        log.warning(
            "PRODUCTION: COOKIE_SECURE is false. Set COOKIE_SECURE=true when serving the API over HTTPS."
        )

    if not (settings.openai_api_key or "").strip():
        log.warning(
            "PRODUCTION: OPENAI_API_KEY is empty; article generation and related features will fail."
        )
