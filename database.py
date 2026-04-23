"""MongoDB client, database handle, and index setup for Auto Articles."""

from __future__ import annotations

import os

import certifi
from dotenv import load_dotenv
from pymongo import MongoClient
from pymongo.database import Database
from pymongo.read_preferences import ReadPreference

# So `MONGODB_*` works when this module is used from CLI (e.g. `python -c "from database import init_db"`)
# without going through app.py, which loads .env first.
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

_client: MongoClient | None = None


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
    kwargs: dict[str, object] = {
        "serverSelectionTimeoutMS": 8000,
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


def remove_scoped_session() -> None:
    """No-op: kept for compatibility with any teardown hooks."""
    pass
