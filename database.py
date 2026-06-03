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
_client_lock = __import__("threading").Lock()  # guards _client and _async_client


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
    # socketTimeoutMS: timeout for a socket read/write after a connection is established.
    # Default 20s — matches the original setting that worked before.  The key
    # improvement is that run_with_retry no longer calls reset_mongo_client() on
    # every retry (which destroyed warm pool connections); PyMongo's retryReads/
    # retryWrites handles the first stale-socket event transparently.
    # Override via MONGODB_SOCKET_TIMEOUT_MS env.
    _raw_sock = (os.environ.get("MONGODB_SOCKET_TIMEOUT_MS") or "").strip()
    socket_ms = int(_raw_sock) if _raw_sock else 20_000
    connect_ms = int(os.environ.get("MONGODB_CONNECT_TIMEOUT_MS") or "10000")
    # I3.6: bound the per-process connection pool so the API + worker + scheduler
    # (and any second API instance) don't collectively exhaust the Atlas connection
    # limit. Tune MONGODB_MAX_POOL_SIZE per process so the sum stays under the tier
    # cap (e.g. Atlas M10 ~= 1500). Default 50 is ample for ~50 users per process.
    max_pool = int(os.environ.get("MONGODB_MAX_POOL_SIZE") or "50")
    # minPoolSize=2 keeps a minimum of 2 warm connections in the pool so the
    # first user request after idle time doesn't hit cold-connect latency.
    min_pool = int(os.environ.get("MONGODB_MIN_POOL_SIZE") or "2")
    # maxIdleTimeMS: how long a pooled connection can sit idle before being closed.
    # Default was 30s — too short when the worker calls OpenAI (which can take
    # 1–3 min) and then tries to write back. After the OpenAI call the Mongo
    # socket had been idle > 30s → Atlas closed it → the write-back got a
    # ServerSelectionTimeoutError. 120s comfortably outlasts the longest
    # generation call while still releasing idle connections promptly.
    # Override with MONGODB_MAX_IDLE_TIME_MS in the environment if needed.
    max_idle_ms = int(os.environ.get("MONGODB_MAX_IDLE_TIME_MS") or "120000")
    kwargs: dict[str, object] = {
        "serverSelectionTimeoutMS": selection_ms,
        "connectTimeoutMS": connect_ms,
        "maxIdleTimeMS": max_idle_ms,
        "maxPoolSize": max_pool,
        "minPoolSize": min_pool,
        "read_preference": ReadPreference.PRIMARY,
        "retryReads": True,
        "retryWrites": True,
    }
    if socket_ms != 0:  # 0 disables the timeout
        kwargs["socketTimeoutMS"] = socket_ms
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

    is_production = (os.environ.get("ENVIRONMENT") or "").strip().lower() == "production"
    allow_insecure = (
        not is_production
        and (os.environ.get("MONGODB_TLS_INSECURE") or "").strip() in ("1", "true", "yes")
    )
    kwargs["tls"] = True
    if allow_insecure:
        # Dev-only escape hatch (ignored in production). If Atlas TLS fails due to local
        # toolchain/network interception, this can sometimes allow connecting for local debugging.
        kwargs["tlsInsecure"] = True
    else:
        kwargs["tlsCAFile"] = certifi.where()
    return kwargs


def get_db() -> Database:
    global _client
    with _client_lock:
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
    """Drop cached sync client so the next operation opens a fresh pool.

    Thread-safe: uses _client_lock to prevent concurrent resets from creating
    multiple MongoClients or from one thread closing a client another just created.
    The async Motor client is NOT reset here — Motor manages its own pool and
    resetting it concurrently with async tasks causes race conditions.
    """
    global _client
    with _client_lock:
        if _client is not None:
            try:
                _client.close()
            except Exception:
                pass
            _client = None


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
    """Run a synchronous Mongo read/write with short retries on transient errors.

    PyMongo's retryReads/retryWrites options handle the first stale-socket retry
    internally and do NOT destroy the pool.  This outer loop only kicks in for
    errors that PyMongo's built-in retry doesn't cover.  We deliberately do NOT
    call reset_mongo_client() here — doing so destroyed all warm connections,
    causing a cascade where every subsequent operation had to cold-start.
    """
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
            # Do NOT call reset_mongo_client() here.  PyMongo's retryReads/
            # retryWrites flags handle the first stale-socket event by creating
            # a fresh connection from the pool without destroying it.  Calling
            # reset_mongo_client() on every retry cascaded: each op after the
            # reset started with an empty pool and had to cold-connect again,
            # compounding into 60s+ for routes with multiple MongoDB calls.
            time.sleep(0.3 * (i + 1))
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
    # P4.3: persisted derived listing status for server-side $match + paginated sort.
    db.articles.create_index([("project_id", 1), ("listing_status", 1), ("created_at", -1)])
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

    # P4.5: indexes for live query shapes that previously triggered collection scans.
    # site_maps listing: find({project_id}).sort(post_modified_at desc)
    db.site_maps.create_index([("project_id", 1), ("post_modified_at", -1)])
    # content_monitors due-query: find({next_check_at: {$lte}}).sort(next_check_at) + per-project listing
    db.content_monitors.create_index("next_check_at")
    db.content_monitors.create_index([("project_id", 1), ("updated_at", -1)])
    # research_cache TTL: expire stale cached SERP/research responses (expires_at is a BSON date).
    db.research_cache.create_index("expires_at", expireAfterSeconds=0, sparse=True)


def remove_scoped_session() -> None:
    """No-op: kept for compatibility with any teardown hooks."""
    pass
