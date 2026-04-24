from __future__ import annotations

import os
import sys
from functools import lru_cache


@lru_cache(maxsize=1)
def _repo_root() -> str:
    # backend/app/legacy/storage.py -> backend/app/legacy -> backend/app -> backend -> repo
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "..", ".."))


def _ensure_repo_root_on_path() -> None:
    root = _repo_root()
    if root not in sys.path:
        sys.path.insert(0, root)


def get_legacy_storage_module():
    _ensure_repo_root_on_path()
    import storage  # type: ignore

    # Ensure storage is initialized (Mongo if configured, JSON fallback otherwise).
    # Without this, modules that call into storage (e.g. scheduler) may crash on startup
    # when MONGODB_URI is not provided on a fresh VPS deployment.
    try:
        if hasattr(storage, "init_storage"):
            storage.init_storage()
    except Exception:
        # Fail-open: storage will behave as JSON fallback for most reads/writes.
        pass

    return storage

