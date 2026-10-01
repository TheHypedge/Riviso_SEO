"""
Per-image storage for inline article media (the "Insert Media" editor feature —
URL / Upload / AI Generate). Distinct from storage.py's featured-image cache, which is
keyed one-file-per-article and cannot hold N inline images per article — this module is
keyed one-file-per-image (a random uuid), mirroring that same disk-cache pattern (bin
file + .meta.json sidecar) generalized to an arbitrary id.

When Cloudinary is configured (app.services.cloudinary_storage), images upload there
instead: no .bin file is written, only a metadata-only .meta.json sidecar recording the
Cloudinary public_id/url alongside project_id/article_id -- the same sidecar shape as the
disk case, so a single directory scan (see storage.py's _cleanup_article_media) can find
and clean up every inline image linked to an article regardless of which backend it
landed on. Falls back to local disk when Cloudinary isn't configured or an upload fails.

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


def _write_meta(image_id: str, meta: dict) -> None:
    _media_dir(ensure=True)
    with open(_meta_path(image_id), "w", encoding="utf-8") as f:
        json.dump(meta, f)


def save_article_media(*, data: bytes, content_type: str, project_id: str, article_id: str) -> tuple[str, str | None]:
    """Persist image bytes under a new random id. Returns (image_id, cloudinary_url) --
    cloudinary_url is None when Cloudinary isn't configured or the upload failed, in
    which case the caller builds the existing same-origin proxy URL from image_id as
    before. image_id is always returned (and always has a .meta.json sidecar written)
    so _cleanup_article_media can find and remove this image later regardless of which
    backend actually holds the bytes."""
    image_id = str(uuid.uuid4())
    base_meta = {
        "content_type": content_type or "image/png",
        "project_id": project_id,
        "article_id": article_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    from app.services.cloudinary_storage import cloudinary_configured, upload_image_bytes

    if cloudinary_configured():
        uploaded = upload_image_bytes(data, folder=f"riviso/articles/{article_id}/media", public_id=image_id)
        if uploaded:
            _write_meta(image_id, {
                **base_meta,
                "cloudinary_public_id": uploaded["public_id"],
                "cloudinary_url": uploaded["secure_url"],
            })
            return image_id, uploaded["secure_url"]
        # Upload failed -- fall through to disk so the image isn't lost.

    bin_path = _bin_path(image_id)
    _media_dir(ensure=True)
    tmp = bin_path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, bin_path)
    _write_meta(image_id, base_meta)
    return image_id, None


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


def delete_media_for_articles(article_ids: list[str]) -> None:
    """Best-effort cleanup of every inline image linked to any of the given article ids
    -- deletes the Cloudinary asset (if recorded) and any local .bin/.meta.json files.
    Never raises: called right before the real article-row deletion in storage.py, and a
    failed media cleanup must never block that.

    No index of "which image ids belong to which article" exists beyond the sidecar
    files themselves, so this scans the media directory once per call. Fine at this
    app's scale (a handful of inline images per article, not millions of files); revisit
    if that ever changes.
    """
    ids = {str(a).strip() for a in (article_ids or []) if str(a).strip()}
    if not ids:
        return
    try:
        media_dir = _media_dir()
        if not os.path.isdir(media_dir):
            return
        entries = os.listdir(media_dir)
    except OSError:
        return

    from app.services.cloudinary_storage import delete_by_public_id

    for name in entries:
        if not name.endswith(".meta.json"):
            continue
        meta_path = os.path.join(media_dir, name)
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            continue
        if not isinstance(meta, dict) or str(meta.get("article_id") or "").strip() not in ids:
            continue

        public_id = (meta.get("cloudinary_public_id") or "").strip()
        if public_id:
            delete_by_public_id(public_id)

        image_id = name[: -len(".meta.json")]
        bin_path = _bin_path(image_id)
        for path in (bin_path, meta_path):
            try:
                if os.path.isfile(path):
                    os.remove(path)
            except OSError:
                pass
