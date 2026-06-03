"""Resilient calls into legacy repo-root ``storage`` / ``database`` modules."""

from __future__ import annotations

import sys
from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

T = TypeVar("T")


def _repo_root() -> Path:
    # backend/app/services/storage_db.py -> repo root
    return Path(__file__).resolve().parents[3]


def _database_module():
    root = str(_repo_root())
    if root not in sys.path:
        sys.path.insert(0, root)
    import database  # type: ignore

    return database


def call_storage(fn: Callable[..., T], /, *args, **kwargs) -> T:
    """Run a blocking storage function with Mongo retries and client reset on transient errors."""
    import os

    db = _database_module()
    # 2 attempts: PyMongo's retryReads/retryWrites handles the first transient
    # error transparently.  Our outer retry adds one reset-and-reconnect for the
    # edge cases PyMongo doesn't handle (e.g. pool fully exhausted).
    attempts = int(os.environ.get("MONGODB_API_RETRY_ATTEMPTS") or "2")
    return db.run_with_retry(lambda: fn(*args, **kwargs), attempts=max(1, attempts))


def ping_storage() -> None:
    """Raise if Mongo is not reachable (used by health/readiness)."""
    _database_module().ping_db()


def is_transient_storage_error(exc: BaseException) -> bool:
    return bool(_database_module().is_transient_mongo_error(exc))
