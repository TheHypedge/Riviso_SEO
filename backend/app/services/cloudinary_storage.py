"""
Cloudinary-backed media storage -- optional. Every function here is safe to call whether
or not Cloudinary is configured: uploads return ``None`` on any failure (including "not
configured"), and deletes are always best-effort. Callers fall back to this app's existing
local-disk storage (``storage.py``'s featured-image cache, ``article_media_storage.py``'s
inline-media cache) whenever this module doesn't hand back a real result -- Cloudinary is
additive, not a hard dependency.
"""

from __future__ import annotations

import logging
from typing import Any

from app.core.config import settings

log = logging.getLogger(__name__)

_configured = False
_config_attempted = False


def cloudinary_configured() -> bool:
    return bool(
        (settings.cloudinary_cloud_name or "").strip()
        and (settings.cloudinary_api_key or "").strip()
        and (settings.cloudinary_api_secret or "").strip()
    )


def _ensure_configured() -> bool:
    """Lazily call cloudinary.config() exactly once, only if credentials are present."""
    global _configured, _config_attempted
    if _configured:
        return True
    if _config_attempted:
        return False
    _config_attempted = True
    if not cloudinary_configured():
        return False
    try:
        import cloudinary

        cloudinary.config(
            cloud_name=settings.cloudinary_cloud_name.strip(),
            api_key=settings.cloudinary_api_key.strip(),
            api_secret=settings.cloudinary_api_secret.strip(),
            secure=True,
        )
        _configured = True
        return True
    except Exception:
        log.exception("cloudinary: config() failed")
        return False


def upload_image_bytes(data: bytes, *, folder: str, public_id: str | None = None) -> dict[str, Any] | None:
    """Uploads image bytes to Cloudinary. Returns {"secure_url", "public_id"} on success,
    None on any failure (bad credentials, network error, not configured) -- callers treat
    None exactly like "Cloudinary isn't available right now" and fall back to disk."""
    if not data or not _ensure_configured():
        return None
    try:
        import cloudinary.uploader

        kwargs: dict[str, Any] = {"folder": folder, "resource_type": "image", "overwrite": True}
        if public_id:
            kwargs["public_id"] = public_id
        result = cloudinary.uploader.upload(data, **kwargs)
        secure_url = (result or {}).get("secure_url")
        returned_public_id = (result or {}).get("public_id")
        if not secure_url or not returned_public_id:
            return None
        return {"secure_url": secure_url, "public_id": returned_public_id}
    except Exception:
        log.warning("cloudinary: upload failed", exc_info=True)
        return None


def delete_by_public_id(public_id: str) -> None:
    """Best-effort remote delete -- never raises. A failed remote delete must never block
    the actual article/project/account data deletion that triggered it."""
    pid = (public_id or "").strip()
    if not pid or not _ensure_configured():
        return
    try:
        import cloudinary.uploader

        cloudinary.uploader.destroy(pid, resource_type="image")
    except Exception:
        log.warning("cloudinary: delete failed for public_id=%s", pid, exc_info=True)
