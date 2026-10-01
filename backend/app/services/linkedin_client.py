"""LinkedIn Posts API + Images API client -- mirrors ShopifyClient's shape (thin httpx
wrapper, no SDK)."""

from __future__ import annotations

import re
from typing import Any

import httpx

from app.services.linkedin_oauth import LINKEDIN_API_VERSION

POSTS_URL = "https://api.linkedin.com/rest/posts"
IMAGES_INIT_URL = "https://api.linkedin.com/rest/images?action=initializeUpload"

# LinkedIn's Posts API `commentary` field is parsed as "little text format", not plain
# text: a fixed set of characters is reserved for mentions/hashtags/templates and MUST
# be backslash-escaped to be treated as literal punctuation, or the parser mis-renders
# (commonly collapsing everything after the first unescaped reserved char down to a
# single line) -- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format
# `#` is deliberately excluded: a bare `#word` is the documented, intentional way to
# get a real clickable hashtag, which is exactly what our generated captions rely on.
_LITTLE_TEXT_RESERVED_RE = re.compile(r"[\\|{}@\[\]()<>*_~]")


def _escape_little_text(text: str) -> str:
    # Single left-to-right pass over the ORIGINAL text -- re.sub never rescans its own
    # replacements, so a literal backslash in the input is escaped to `\\` exactly
    # once and never double-escaped by the other branches in the same pass.
    return _LITTLE_TEXT_RESERVED_RE.sub(lambda m: "\\" + m.group(0), text or "")


def _headers(access_token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {access_token}",
        "Linkedin-Version": LINKEDIN_API_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
        "Content-Type": "application/json",
    }


async def upload_image(*, access_token: str, owner_urn: str, image_bytes: bytes) -> str | None:
    """Uploads image bytes as the featured-image thumbnail for a link post. Returns the
    image URN (`urn:li:image:...`), or None on any failure -- a thumbnail is a nice-to-
    have, never worth failing the whole post over."""
    if not image_bytes:
        return None
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            init_res = await client.post(
                IMAGES_INIT_URL,
                json={"initializeUploadRequest": {"owner": owner_urn}},
                headers=_headers(access_token),
            )
            if init_res.status_code not in (200, 201):
                return None
            init_data = init_res.json() if init_res.content else {}
            value = (init_data or {}).get("value") or {}
            upload_url = (value.get("uploadUrl") or "").strip()
            image_urn = (value.get("image") or "").strip()
            if not upload_url or not image_urn:
                return None

            upload_res = await client.put(
                upload_url,
                content=image_bytes,
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if upload_res.status_code not in (200, 201):
                return None
        return image_urn
    except Exception:
        return None


async def upload_article_thumbnail(*, st, project_id: str, article_id: str, access_token: str, owner_urn: str) -> str | None:
    """Resolves the article's real featured image and uploads it as the post thumbnail.

    Bug this fixes: article rows generated in-app store the image as file/DB-backed
    data (base64 ``data:image/...`` or a temporary provider URL), never in the plain
    ``article["image_url"]`` field directly -- that field stays empty for exactly the
    common case of an AI-generated featured image. Reading it directly (as this
    function's callers used to) silently skipped every thumbnail upload. The correct,
    storage-agnostic resolver is ``_featured_image_url_loader``, already used by the
    WordPress/Shopify publish paths for this identical problem -- reused here rather
    than duplicated.

    Returns None on any failure (no image, decode error, upload rejected) -- a missing
    thumbnail is never worth failing the whole post over, same contract as upload_image.
    """
    try:
        from app.api.routes.articles import _featured_image_url_loader
        from app.services.shopify_article_image import featured_image_bytes_from_data_url, featured_image_bytes_from_http_url
        from app.services.to_thread import run_sync

        raw = await run_sync(_featured_image_url_loader(st, project_id, article_id))
        if not raw:
            return None
        if raw.startswith("data:image/"):
            parsed = featured_image_bytes_from_data_url(raw)
        elif raw.startswith("http://") or raw.startswith("https://"):
            parsed = await featured_image_bytes_from_http_url(raw)
        else:
            parsed = None
        if not parsed:
            return None
        image_bytes, _content_type, _filename = parsed
        return await upload_image(access_token=access_token, owner_urn=owner_urn, image_bytes=image_bytes)
    except Exception:
        return None


def _post_url_from_urn(post_urn: str) -> str:
    return f"https://www.linkedin.com/feed/update/{post_urn}/"


async def create_post(
    *,
    access_token: str,
    author_urn: str,
    commentary: str,
    article_url: str | None = None,
    thumbnail_urn: str | None = None,
    title: str | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    """Creates a LinkedIn Post. If `article_url` is given, posts a rich link card
    (content.article) -- otherwise a plain text post. Returns {"post_urn", "post_url"}."""
    body: dict[str, Any] = {
        "author": author_urn,
        "commentary": _escape_little_text(commentary),
        "visibility": "PUBLIC",
        "distribution": {
            "feedDistribution": "MAIN_FEED",
            "targetEntities": [],
            "thirdPartyDistributionChannels": [],
        },
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": False,
    }
    if article_url:
        article: dict[str, Any] = {"source": article_url}
        if title:
            article["title"] = title[:200]
        if description:
            article["description"] = description[:500]
        if thumbnail_urn:
            article["thumbnail"] = thumbnail_urn
        body["content"] = {"article": article}

    async with httpx.AsyncClient(timeout=20.0) as client:
        res = await client.post(POSTS_URL, json=body, headers=_headers(access_token))
    if res.status_code != 201:
        data = res.json() if res.content else {}
        raise RuntimeError(f"LinkedIn post creation failed ({res.status_code}): {data}")
    post_urn = (res.headers.get("x-restli-id") or "").strip()
    if not post_urn:
        raise RuntimeError("LinkedIn post creation returned no post id")
    return {"post_urn": post_urn, "post_url": _post_url_from_urn(post_urn)}
