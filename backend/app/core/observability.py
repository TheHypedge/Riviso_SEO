"""Sentry error tracking (I5.1) — dependency- and config-safe.

No-ops unless ``SENTRY_DSN`` is set *and* ``sentry-sdk`` is installed, so the app
runs identically in environments without Sentry. PII is scrubbed by default
(``send_default_pii=False`` plus a ``before_send`` that strips auth/cookie headers
and obvious secret-bearing fields) to keep user data out of the error backend.

Call :func:`init_sentry` once per process (API, worker, scheduler) at startup.
"""

from __future__ import annotations

import logging
import os
from typing import Any

_log = logging.getLogger("riviso.observability")

_SENSITIVE_HEADER_KEYS = {"authorization", "cookie", "set-cookie", "x-api-key", "x-requested-with"}
_SENSITIVE_FIELD_HINTS = ("password", "token", "secret", "api_key", "authorization", "cookie", "dsn")


def _scrub(event: dict, _hint: dict) -> dict | None:
    try:
        req = event.get("request")
        if isinstance(req, dict):
            headers = req.get("headers")
            if isinstance(headers, dict):
                for k in list(headers.keys()):
                    if k.lower() in _SENSITIVE_HEADER_KEYS:
                        headers[k] = "[scrubbed]"
            # Never ship raw request bodies / cookies.
            req.pop("cookies", None)
            req.pop("data", None)
        for section in ("extra", "tags"):
            bag = event.get(section)
            if isinstance(bag, dict):
                for k in list(bag.keys()):
                    if any(h in k.lower() for h in _SENSITIVE_FIELD_HINTS):
                        bag[k] = "[scrubbed]"
    except Exception:
        # Scrubbing must never break delivery; drop nothing silently.
        pass
    return event


def _flag(name: str, default: str = "") -> str:
    return (os.environ.get(name, default) or default).strip()


def init_sentry(component: str) -> bool:
    """Initialise Sentry for ``component`` ("api" | "worker" | ...). Returns True if enabled."""
    dsn = _flag("SENTRY_DSN")
    if not dsn:
        return False
    try:
        import sentry_sdk
        from sentry_sdk.integrations.logging import LoggingIntegration
    except Exception:
        _log.warning("SENTRY_DSN is set but sentry-sdk is not installed; error tracking disabled")
        return False

    try:
        traces = float(_flag("SENTRY_TRACES_SAMPLE_RATE", "0") or "0")
    except ValueError:
        traces = 0.0

    integrations: list[Any] = [
        LoggingIntegration(level=logging.INFO, event_level=logging.ERROR),
    ]

    sentry_sdk.init(
        dsn=dsn,
        environment=_flag("ENVIRONMENT", "development") or "development",
        release=_flag("RELEASE") or _flag("GIT_SHA") or None,
        traces_sample_rate=traces,
        send_default_pii=False,
        max_request_body_size="never",
        integrations=integrations,
        before_send=_scrub,
    )
    sentry_sdk.set_tag("component", component)
    _log.info("Sentry initialised for component=%s", component)
    return True
