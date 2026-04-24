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

    return storage

