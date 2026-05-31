"""
Resolve Riviso article featured images for Shopify blog article create/update.

OpenAI often returns data URLs; Shopify REST accepts base64 via image.attachment.
"""
from __future__ import annotations

import base64
import binascii
import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

_MAX_IMAGE_BYTES = 15 * 1024 * 1024


def _extension_for_content_type(content_type: str) -> str:
    ct = (content_type or "").lower()
    if "jpeg" in ct or "jpg" in ct:
        return "jpg"
    if "webp" in ct:
        return "webp"
    if "gif" in ct:
        return "gif"
    return "png"


def featured_image_bytes_from_data_url(image_url: str) -> tuple[bytes, str, str] | None:
    """Decode ``data:image/...;base64,...`` stored on article rows."""
    raw = (image_url or "").strip()
    if not raw.startswith("data:image/") or ";base64," not in raw:
        return None
    try:
        header, b64 = raw.split(";base64,", 1)
        content_type = header.replace("data:", "", 1).strip() or "image/png"
        data = base64.b64decode(b64, validate=False)
    except (ValueError, IndexError, binascii.Error):
        return None
    if not data or len(data) > _MAX_IMAGE_BYTES:
        return None
    return data, content_type, f"featured.{_extension_for_content_type(content_type)}"


async def featured_image_bytes_from_http_url(image_url: str) -> tuple[bytes, str, str] | None:
    """Download a public image URL (e.g. temporary OpenAI CDN URL) for Shopify attachment."""
    url = (image_url or "").strip()
    if not url.startswith("http://") and not url.startswith("https://"):
        return None
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, read=90.0), follow_redirects=True) as client:
            res = await client.get(url)
            res.raise_for_status()
            content_type = (res.headers.get("content-type") or "image/png").split(";")[0].strip()
            if content_type and not content_type.startswith("image/"):
                content_type = "image/png"
            data = res.content
    except Exception:
        log.debug("Could not download featured image for Shopify %s", url[:120], exc_info=True)
        return None
    if not data or len(data) > _MAX_IMAGE_BYTES:
        return None
    return data, content_type or "image/png", f"featured.{_extension_for_content_type(content_type)}"


async def resolve_featured_image_bytes(article: dict) -> tuple[bytes, str, str] | None:
    """Load featured image bytes from the article row (data URL or HTTP URL)."""
    raw = (article.get("image_url") or "").strip()
    if not raw:
        return None
    if raw.startswith("data:image/"):
        return featured_image_bytes_from_data_url(raw)
    if raw.startswith("http://") or raw.startswith("https://"):
        return featured_image_bytes_from_data_url(raw) or await featured_image_bytes_from_http_url(raw)
    return None


async def build_shopify_article_image_payload(
    article: dict,
    *,
    alt: str = "",
) -> dict[str, Any] | None:
    """Build Shopify REST ``article.image`` using base64 attachment (Riviso data URLs)."""
    parsed = await resolve_featured_image_bytes(article)
    if not parsed:
        return None
    data, _content_type, filename = parsed
    attachment = base64.b64encode(data).decode("ascii")
    payload: dict[str, Any] = {"attachment": attachment}
    if filename:
        payload["filename"] = filename
    alt_text = (alt or article.get("title") or "").strip()[:512]
    if alt_text:
        payload["alt"] = alt_text
    return payload


def shopify_article_has_featured_image(art: dict | None) -> bool:
    if not isinstance(art, dict):
        return False
    image = art.get("image")
    if not isinstance(image, dict):
        return False
    return bool((image.get("src") or "").strip() or image.get("attachment"))
