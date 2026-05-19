from __future__ import annotations

import base64
import binascii
import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)


class WordpressClient:
    def __init__(self, *, site_url: str, username: str, app_password: str) -> None:
        self.site_url = (site_url or "").strip().rstrip("/")
        self.username = (username or "").strip()
        self.app_password = (app_password or "").replace(" ", "").strip()
        if not self.site_url:
            raise RuntimeError("Missing WordPress site URL")
        if not self.username or not self.app_password:
            raise RuntimeError("Missing WordPress credentials")

        basic = base64.b64encode(f"{self.username}:{self.app_password}".encode("utf-8")).decode("ascii")
        self._headers = {"authorization": f"Basic {basic}"}

    def _url(self, path: str) -> str:
        p = (path or "").strip()
        if not p.startswith("/"):
            p = "/" + p
        return f"{self.site_url}{p}"

    async def get_json(self, path: str, *, timeout: float = 20.0) -> Any:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            res = await client.get(self._url(path), headers=self._headers)
        res.raise_for_status()
        return res.json()

    async def post_json(self, path: str, payload: dict[str, Any], *, timeout: float = 30.0) -> Any:
        headers = {**self._headers, "content-type": "application/json"}
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            res = await client.post(self._url(path), headers=headers, json=payload)
        res.raise_for_status()
        return res.json()

    async def put_json(self, path: str, payload: dict[str, Any], *, timeout: float = 30.0) -> Any:
        headers = {**self._headers, "content-type": "application/json"}
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            res = await client.put(self._url(path), headers=headers, json=payload)
        res.raise_for_status()
        return res.json()

    async def upload_media(self, *, filename: str, content_type: str, data: bytes, timeout: float = 60.0) -> Any:
        headers = {
            **self._headers,
            "content-type": content_type or "application/octet-stream",
            "content-disposition": f'attachment; filename="{filename or "image.png"}"',
        }
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            res = await client.post(self._url("/wp-json/wp/v2/media"), headers=headers, content=data)
        res.raise_for_status()
        return res.json()

    async def upload_media_optional(
        self,
        *,
        filename: str,
        content_type: str,
        data: bytes,
        timeout: float = 60.0,
    ) -> int | None:
        """
        Upload media when possible; return ``None`` instead of failing the publish flow.

        WordPress often returns 403 when the Application Password user lacks ``upload_files``
        or a security plugin blocks REST media uploads — the article should still publish.
        """
        if not data:
            return None
        try:
            up = await self.upload_media(
                filename=filename,
                content_type=content_type,
                data=data,
                timeout=timeout,
            )
            if isinstance(up, dict) and isinstance(up.get("id"), int):
                return int(up["id"])
        except httpx.HTTPStatusError as e:
            log.warning(
                "WordPress media upload failed (HTTP %s) — publishing without featured image: %s",
                e.response.status_code,
                e.request.url,
            )
        except Exception:
            log.warning("WordPress media upload failed — publishing without featured image", exc_info=True)
        return None


def featured_image_upload_from_article(article: dict) -> tuple[bytes, str, str] | None:
    """Decode a stored ``data:image/...;base64,...`` featured image for WP upload."""
    img_url = (article.get("image_url") or "").strip()
    if not img_url.startswith("data:image/") or ";base64," not in img_url:
        return None
    try:
        header, b64 = img_url.split(";base64,", 1)
        content_type = header.replace("data:", "", 1).strip() or "image/png"
        data = base64.b64decode(b64, validate=False)
    except (ValueError, IndexError, binascii.Error):
        return None
    if not data:
        return None
    ext = "png"
    if "jpeg" in content_type or "jpg" in content_type:
        ext = "jpg"
    elif "webp" in content_type:
        ext = "webp"
    return data, content_type, f"featured.{ext}"


async def resolve_featured_media_id(wp: WordpressClient, article: dict, *, timeout: float = 90.0) -> int | None:
    """Best-effort featured media id from the article's generated image (never raises)."""
    parsed = featured_image_upload_from_article(article)
    if not parsed:
        return None
    data, content_type, filename = parsed
    return await wp.upload_media_optional(
        filename=filename,
        content_type=content_type,
        data=data,
        timeout=timeout,
    )

    async def ensure_tag_ids(self, names: list[str], *, timeout: float = 20.0) -> list[int]:
        """
        Ensure WP tags exist for provided names, returning tag IDs.
        Best-effort: if tag creation fails, skip it.
        """
        out: list[int] = []
        seen: set[int] = set()
        for raw in names or []:
            name = (raw or "").strip()
            if not name:
                continue
            # Search existing tags
            try:
                # Name is safe enough for this simple query param; httpx will handle encoding on its side only when building URLs,
                # but we pass a string here, so keep it conservative.
                q = name.replace("&", " ").replace("?", " ").strip()
                data = await self.get_json(f"/wp-json/wp/v2/tags?per_page=100&search={q}", timeout=timeout)
            except Exception:
                data = None
            found_id: int | None = None
            if isinstance(data, list):
                for t in data:
                    if not isinstance(t, dict):
                        continue
                    tname = str(t.get("name") or "").strip()
                    if tname.lower() == name.lower() and isinstance(t.get("id"), int):
                        found_id = int(t["id"])
                        break
            if found_id is None:
                try:
                    created = await self.post_json("/wp-json/wp/v2/tags", {"name": name[:200]}, timeout=timeout)
                    if isinstance(created, dict) and isinstance(created.get("id"), int):
                        found_id = int(created["id"])
                except Exception:
                    found_id = None
            if found_id is not None and found_id not in seen:
                seen.add(found_id)
                out.append(found_id)
        return out

