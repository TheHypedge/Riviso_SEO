"""MongoDB client, database handle, and index setup for Auto Articles."""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Callable
from typing import TypeVar

import certifi
from dotenv import load_dotenv
from pymongo import MongoClient
from pymongo.database import Database
from pymongo.errors import (
    AutoReconnect,
    ConnectionFailure,
    NetworkTimeout,
    PyMongoError,
    ServerSelectionTimeoutError,
)
from pymongo.read_preferences import ReadPreference

try:
    from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
except ImportError:  # pragma: no cover - optional until motor is installed
    AsyncIOMotorClient = None  # type: ignore[misc, assignment]
    AsyncIOMotorDatabase = None  # type: ignore[misc, assignment]

_log = logging.getLogger(__name__)
T = TypeVar("T")

# So `MONGODB_*` works when this module is used from CLI (e.g. `python -c "from database import init_db"`)
# without going through app.py, which loads .env first.
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

_client: MongoClient | None = None
_async_client: AsyncIOMotorClient | None = None


def _strip_optional_quotes(raw: str) -> str:
    """`.env` lines like MONGODB_URI='mongodb://...' sometimes retain quotes depending on tooling."""
    s = (raw or "").strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        return s[1:-1].strip()
    return s


def get_mongodb_uri() -> str:
    u = _strip_optional_quotes(os.environ.get("MONGODB_URI") or "")
    if not u:
        raise RuntimeError(
            "MONGODB_URI is not set. Add it to .env, e.g. mongodb://127.0.0.1:27017/"
        )
    return u


def get_database_name() -> str:
    name = _strip_optional_quotes(os.environ.get("MONGODB_DB_NAME") or "auto_articles")
    return name or "auto_articles"


def _mongo_client_kwargs(uri: str) -> dict[str, object]:
    """Build pymongo kwargs. Do not force TLS on plain mongodb:// (e.g. local VPS)."""
    # Always read from the primary so UI/API see writes immediately (no stale secondaries).
    selection_ms = int(os.environ.get("MONGODB_SERVER_SELECTION_TIMEOUT_MS") or "5000")
    socket_ms = int(os.environ.get("MONGODB_SOCKET_TIMEOUT_MS") or "20000")
    connect_ms = int(os.environ.get("MONGODB_CONNECT_TIMEOUT_MS") or "20000")
    kwargs: dict[str, object] = {
        "serverSelectionTimeoutMS": selection_ms,
        "socketTimeoutMS": socket_ms,
        "connectTimeoutMS": connect_ms,
        "maxIdleTimeMS": 30_000,
        "read_preference": ReadPreference.PRIMARY,
    }
    env_tls = (os.environ.get("MONGODB_TLS") or "").strip().lower()
    if env_tls in ("0", "false", "no"):
        use_tls = False
    elif env_tls in ("1", "true", "yes"):
        use_tls = True
    else:
        # mongodb+srv (Atlas etc.) requires TLS; mongodb:// to localhost usually does not.
        use_tls = uri.strip().startswith("mongodb+srv://")

    if not use_tls:
        return kwargs

    allow_insecure = (os.environ.get("MONGODB_TLS_INSECURE") or "").strip() in ("1", "true", "yes")
    kwargs["tls"] = True
    if allow_insecure:
        # Dev-only escape hatch. If Atlas TLS fails due to local toolchain/network
        # interception, this can sometimes allow connecting for local debugging.
        kwargs["tlsInsecure"] = True
    else:
        kwargs["tlsCAFile"] = certifi.where()
    return kwargs


def get_db() -> Database:
    global _client
    if _client is None:
        uri = get_mongodb_uri()
        _client = MongoClient(uri, **_mongo_client_kwargs(uri))
    return _client[get_database_name()]


def get_async_db() -> AsyncIOMotorDatabase:
    """Async Motor database handle for non-blocking reads (listing / dashboard routes)."""
    global _async_client
    if AsyncIOMotorClient is None:
        raise RuntimeError("motor is not installed — add motor to requirements and pip install")
    if _async_client is None:
        uri = get_mongodb_uri()
        _async_client = AsyncIOMotorClient(uri, **_mongo_client_kwargs(uri))
    return _async_client[get_database_name()]


def reset_mongo_client() -> None:
    """Drop cached sync + async clients so the next operation opens a fresh pool."""
    global _client, _async_client
    if _client is not None:
        try:
            _client.close()
        except Exception:
            pass
        _client = None
    if _async_client is not None:
        try:
            _async_client.close()
        except Exception:
            pass
        _async_client = None


def is_transient_mongo_error(exc: BaseException) -> bool:
    """True when a retry or client reset may succeed (network blip, no primary, cancelled op)."""
    if isinstance(exc, (AutoReconnect, ConnectionFailure, NetworkTimeout, ServerSelectionTimeoutError)):
        return True
    if exc.__class__.__name__ == "_OperationCancelled":
        return True
    if isinstance(exc, OSError):
        return True
    if isinstance(exc, PyMongoError):
        msg = str(exc).lower()
        return any(
            token in msg
            for token in (
                "timed out",
                "timeout",
                "not known",
                "nodename",
                "connection refused",
                "network",
                "cancelled",
                "replicasetnoprimary",
                "autoreconnect",
                "serverselection",
            )
        )
    return False


def run_with_retry(fn: Callable[[], T], *, attempts: int = 3) -> T:
    """Run a synchronous Mongo read/write with short retries and client reset on transient errors."""
    last: BaseException | None = None
    tries = max(1, attempts)
    for i in range(tries):
        try:
            return fn()
        except Exception as e:
            last = e
            if not is_transient_mongo_error(e) or i >= tries - 1:
                raise
            _log.warning("Transient Mongo error (attempt %s/%s): %s", i + 1, tries, e)
            reset_mongo_client()
            time.sleep(0.2 * (i + 1))
    assert last is not None
    raise last


def ping_db(timeout_ms: int = 3000) -> None:
    """Lightweight readiness probe; raises on failure."""
    db = get_db()

    def _ping() -> None:
        db.client.admin.command("ping", maxTimeMS=timeout_ms)

    run_with_retry(_ping, attempts=2)


def init_db() -> None:
    """Ensure indexes exist (collections are created implicitly on first write)."""
    db = get_db()
    db.client.admin.command("ping")
    db.projects.create_index("id", unique=True)
    db.projects.create_index("owner_user_id")
    db.articles.create_index("id", unique=True)
    db.articles.create_index("project_id")
    db.articles.create_index([("project_id", 1), ("created_at", -1)])
    db.articles.create_index([("project_id", 1), ("status", 1), ("created_at", -1)])
    db.articles.create_index([("project_id", 1), ("wp_scheduled_at", 1)])
    db.articles.create_index([("project_id", 1), ("created_at", -1), ("status", 1)])
    db.users.create_index("id", unique=True)
    db.users.create_index("email", unique=True)

    # Scheduled jobs queue
    # `_id` is already indexed/unique by MongoDB; we also index fields used by list/sort.
    db.scheduled_jobs.create_index("project_id")
    db.scheduled_jobs.create_index([("project_id", 1), ("run_at", 1)])
    db.scheduled_jobs.create_index([("state", 1), ("run_at", 1)])
    db.scheduled_jobs.create_index([("project_id", 1), ("state", 1), ("article_id", 1)])
    db.research_serp.create_index([("project_id", 1), ("fetched_at", -1)])
    db.research_ideas_runs.create_index([("project_id", 1), ("created_at", -1)])
    db.research_cache.create_index("saved_at")
    db.topic_clusters.create_index([("project_id", 1), ("created_at", -1)])
    db.topic_clusters.create_index([("project_id", 1), ("status", 1)])
    db.subscriptions.create_index("user_id", unique=True)
    db.subscriptions.create_index("trial_end_date")
    db.plans.create_index("is_trial_plan")
    db.users.create_index("email_verification_expires_at", expireAfterSeconds=0, sparse=True)
    db.users.create_index("password_reset_expires_at", expireAfterSeconds=0, sparse=True)
    db.projects.create_index([("owner_user_id", 1), ("created_at", 1)])

    # Shopify product catalog (one document per product; not embedded on projects)
    db.shopify_products.create_index(
        [("project_id", 1), ("shopify_product_id", 1)],
        unique=True,
    )
    db.shopify_products.create_index([("project_id", 1), ("status", 1)])


def remove_scoped_session() -> None:
    """No-op: kept for compatibility with any teardown hooks."""
    pass
