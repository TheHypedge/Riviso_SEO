"""
Per-image disk storage for inline article media (the "Insert Media" editor
feature — URL / Upload / AI Generate). Distinct from storage.py's featured-image
cache, which is keyed one-file-per-article and cannot hold N inline images per
article — this module is keyed one-file-per-image (a random uuid), mirroring
that same disk-cache pattern (bin file + .meta.json sidecar) generalized to an
arbitrary id.

Reuses app.legacy.storage's already-correct repo-root resolution (`_data_path`)
rather than recomputing "where is the repo root" relative to this file's own
much-deeper path (backend/app/services/... vs. storage.py's repo-root location).
"""

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone

from app.legacy.storage import get_legacy_storage_module

_SAFE_ID = re.compile(r"^[a-f0-9\-]{8,64}$")


def _media_dir(*, ensure: bool = False) -> str:
    st = get_legacy_storage_module()
    path = st._data_path("article_media")  # noqa: SLF001 - reusing the repo-root helper deliberately
    if ensure:
        os.makedirs(path, exist_ok=True)
    return path


def _bin_path(image_id: str) -> str:
    return os.path.join(_media_dir(), f"{image_id}.bin")


def _meta_path(image_id: str) -> str:
    return _bin_path(image_id) + ".meta.json"


def save_article_media(*, data: bytes, content_type: str, project_id: str, article_id: str) -> str:
    """Persist image bytes to disk under a new random id. Returns the image_id
    (callers build the public URL — this module has no knowledge of routing)."""
    image_id = str(uuid.uuid4())
    _media_dir(ensure=True)
    bin_path = _bin_path(image_id)
    tmp = bin_path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, bin_path)
    with open(_meta_path(image_id), "w", encoding="utf-8") as f:
        json.dump(
            {
                "content_type": content_type or "image/png",
                "project_id": project_id,
                "article_id": article_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
            },
            f,
        )
    return image_id


def load_article_media(image_id: str) -> tuple[bytes, str] | None:
    """Return (data, content_type) for a known image id, or None."""
    iid = (image_id or "").strip()
    if not iid or not _SAFE_ID.match(iid):
        return None
    bin_path = _bin_path(iid)
    if not os.path.isfile(bin_path):
        return None
    try:
        with open(bin_path, "rb") as f:
            data = f.read()
    except OSError:
        return None
    content_type = "image/png"
    meta_path = _meta_path(iid)
    if os.path.isfile(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            if isinstance(meta, dict) and meta.get("content_type"):
                content_type = str(meta["content_type"])
        except Exception:
            pass
    return data, content_type
