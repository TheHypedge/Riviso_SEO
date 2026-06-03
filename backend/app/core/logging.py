"""
Structured JSON logging via ``structlog`` for stdout (container-friendly).

I5.3: all logs — both ``structlog`` calls and stdlib ``logging`` (uvicorn, pymongo,
app modules using ``logging.getLogger``) — are rendered as a single JSON stream and
enriched with any context bound via ``structlog.contextvars`` (e.g. the per-request
``request_id`` set by :class:`app.middleware.request_id.RequestIdMiddleware`, or the
``job_id`` bound by the generation worker). This lets you correlate a request across
the API and the background worker by grepping one id.

Call :func:`configure_logging` once at process startup before handling requests.
"""

from __future__ import annotations

import logging
import sys

import structlog

_configured = False


def _shared_processors() -> list:
    return [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
    ]


def configure_logging(*, level: str = "INFO") -> None:
    global _configured

    log_level = getattr(logging, level.upper(), logging.INFO)
    shared = _shared_processors()

    # One stdlib handler renders EVERYTHING (stdlib + structlog) as JSON. ``foreign_pre_chain``
    # runs the shared processors for records that did not originate from structlog (uvicorn etc.).
    formatter = structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        foreign_pre_chain=shared,
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(log_level)

    # Let uvicorn's loggers propagate to root so they get the JSON formatter too.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers.clear()
        lg.propagate = True

    structlog.configure(
        processors=[
            *shared,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.make_filtering_bound_logger(log_level),
        cache_logger_on_first_use=True,
    )

    _configured = True


def get_logger(name: str | None = None):
    """Return a structlog logger (configures logging lazily if needed)."""
    if not _configured:
        configure_logging()
    return structlog.get_logger(name) if name else structlog.get_logger()
