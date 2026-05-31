"""Map storage/Mongo failures to consistent HTTP responses."""

from __future__ import annotations

import logging

from fastapi import HTTPException

from app.services.storage_db import is_transient_storage_error

_log = logging.getLogger(__name__)

DATABASE_UNAVAILABLE_DETAIL = {
    "code": "database_unavailable",
    "message": "Database temporarily unavailable. Check your connection and try again.",
}


def raise_storage_http(exc: BaseException) -> None:
    """Raise 503 for transient DB errors; re-raise unexpected errors for route handlers."""
    if is_transient_storage_error(exc):
        _log.warning("Storage unavailable: %s", exc)
        raise HTTPException(status_code=503, detail=DATABASE_UNAVAILABLE_DETAIL) from None
    raise exc
