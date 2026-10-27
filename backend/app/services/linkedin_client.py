"""LinkedIn Posts API + Images API client -- mirrors ShopifyClient's shape (thin httpx
wrapper, no SDK)."""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any
from urllib.parse import quote

import httpx

from app.services.linkedin_oauth import LINKEDIN_API_VERSION

log = logging.getLogger(__name__)

POSTS_URL = "https://api.linkedin.com/rest/posts"
IMAGES_URL = "https://api.linkedin.com/rest/images"
IMAGES_INIT_URL = f"{IMAGES_URL}?action=initializeUpload"

# The Images API accepts only JPG, PNG and GIF (by magic bytes, not file name).
_LINKEDIN_IMAGE_SIGNATURES = (b"\x89PNG", b"\xff\xd8\xff", b"GIF8")
# A post that references a still-PROCESSING image publishes without it, so wait for AVAILABLE.
_IMAGE_READY_POLLS = 15
_IMAGE_READY_INTERVAL_S = 1.0

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


async def _wait_until_available(client: httpx.AsyncClient, access_token: str, image_urn: str) -> bool:
    url = f"{IMAGES_URL}/{quote(image_urn, safe='')}"
    for _ in range(_IMAGE_READY_POLLS):
        res = await client.get(url, headers=_headers(access_token))
        status = ((res.json() if res.content else {}) or {}).get("status") if res.status_code == 200 else None
        if status == "AVAILABLE":
            return True
        if status == "PROCESSING_FAILED":
            log.warning("LinkedIn image processing failed for %s", image_urn)
            return False
        await asyncio.sleep(_IMAGE_READY_INTERVAL_S)
    log.warning("LinkedIn image %s not AVAILABLE after %ss", image_urn, _IMAGE_READY_POLLS * _IMAGE_READY_INTERVAL_S)
    return False


async def upload_image(*, access_token: str, owner_urn: str, image_bytes: bytes) -> str | None:
    """Uploads image bytes and waits until LinkedIn has processed them. Returns the image
    URN (`urn:li:image:...`), or None on any failure -- the caller then posts without it."""
    if not image_bytes:
        return None
    if not image_bytes.startswith(_LINKEDIN_IMAGE_SIGNATURES):
        log.warning("LinkedIn image skipped: only JPG/PNG/GIF are accepted")
        return None
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            init_res = await client.post(
                IMAGES_INIT_URL,
                json={"initializeUploadRequest": {"owner": owner_urn}},
                headers=_headers(access_token),
            )
            if init_res.status_code not in (200, 201):
                log.warning("LinkedIn image init failed (%s): %s", init_res.status_code, init_res.text[:300])
                return None
            value = ((init_res.json() if init_res.content else {}) or {}).get("value") or {}
            upload_url = (value.get("uploadUrl") or "").strip()
            image_urn = (value.get("image") or "").strip()
            if not upload_url or not image_urn:
                log.warning("LinkedIn image init returned no upload URL or image URN")
                return None

            upload_res = await client.put(upload_url, content=image_bytes, headers={"Authorization": f"Bearer {access_token}"})
            if upload_res.status_code not in (200, 201):
                log.warning("LinkedIn image upload failed (%s): %s", upload_res.status_code, upload_res.text[:300])
                return None
            if not await _wait_until_available(client, access_token, image_urn):
                return None
        return image_urn
    except Exception:
        log.warning("LinkedIn image upload errored", exc_info=True)
        return None


def _linkedin_ready_url(url: str) -> str:
    """Cloudinary converts by extension: ask for a JPG when the stored image is a format
    LinkedIn rejects (e.g. WebP)."""
    if "res.cloudinary.com" in url:
        return re.sub(r"\.(webp|avif|svg)(\?|$)", r".jpg\2", url, flags=re.IGNORECASE)
    return url


async def upload_article_image(*, st, project_id: str, article_id: str, access_token: str, owner_urn: str) -> str | None:
    """Resolves the article's real featured image and uploads it to LinkedIn.

    Article rows store the featured image as file/DB-backed data (base64 ``data:image/...``)
    or a hosted URL, not always in ``article["image_url"]``; ``_featured_image_url_loader``
    is the storage-agnostic resolver the WordPress/Shopify publish paths already use.
    Returns None on any failure -- a missing image never fails the whole post.
    """
    try:
        from app.api.routes.articles import _featured_image_url_loader
        from app.services.shopify_article_image import featured_image_bytes_from_data_url, featured_image_bytes_from_http_url
        from app.services.to_thread import run_sync

        raw = (await run_sync(_featured_image_url_loader(st, project_id, article_id)) or "").strip()
        if not raw:
            log.info("LinkedIn: article %s has no featured image", article_id)
            return None
        if raw.startswith("data:image/"):
            parsed = featured_image_bytes_from_data_url(raw)
        elif raw.startswith(("http://", "https://")):
            parsed = await featured_image_bytes_from_http_url(_linkedin_ready_url(raw))
        else:
            parsed = None
        if not parsed:
            log.warning("LinkedIn: could not load featured image for article %s", article_id)
            return None
        return await upload_image(access_token=access_token, owner_urn=owner_urn, image_bytes=parsed[0])
    except Exception:
        log.warning("LinkedIn: featured image failed for article %s", article_id, exc_info=True)
        return None


def _post_url_from_urn(post_urn: str) -> str:
    return f"https://www.linkedin.com/feed/update/{post_urn}/"


async def create_post(
    *,
    access_token: str,
    author_urn: str,
    commentary: str,
    article_url: str | None = None,
    image_urn: str | None = None,
    title: str | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    """Creates a LinkedIn Post. With `image_urn`: an image post (full-size featured image).
    Else with `article_url`: a link card. Else plain text. Returns {"post_urn", "post_url"}.

    The commentary is published exactly as the user saw and edited it in the share
    preview -- nothing is appended (the generated caption already carries the article
    link; if the user removed it, that was their choice)."""
    text = commentary or ""
    body: dict[str, Any] = {
        "author": author_urn,
        "commentary": _escape_little_text(text),
        "visibility": "PUBLIC",
        "distribution": {
            "feedDistribution": "MAIN_FEED",
            "targetEntities": [],
            "thirdPartyDistributionChannels": [],
        },
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": False,
    }
    if image_urn:
        media: dict[str, Any] = {"id": image_urn}
        if title:
            media["title"] = title[:200]
        body["content"] = {"media": media}
    elif article_url:
        article: dict[str, Any] = {"source": article_url}
        if title:
            article["title"] = title[:200]
        if description:
            article["description"] = description[:500]
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


async def share_article(
    *, st, project_id: str, article: dict, access_token: str, author_urn: str, commentary: str
) -> dict[str, Any]:
    """The one path for sharing an article (Share button and scheduled posts): attach the
    featured image when it uploads, and never lose the post over the image -- if LinkedIn
    rejects the post with the image, retry once without it.
    Returns {"post_urn", "post_url", "image_attached"}."""
    article_id = (article.get("id") or "").strip()
    post_args = dict(
        access_token=access_token,
        author_urn=author_urn,
        commentary=commentary,
        article_url=(article.get("wp_link") or article.get("shopify_link") or "").strip() or None,
        title=(article.get("title") or "").strip() or None,
        description=(article.get("meta_description") or "").strip() or None,
    )
    image_urn = await upload_article_image(
        st=st, project_id=project_id, article_id=article_id, access_token=access_token, owner_urn=author_urn
    )
    if image_urn:
        try:
            return {**await create_post(**post_args, image_urn=image_urn), "image_attached": True}
        except Exception:
            log.warning("LinkedIn post with image failed for article %s; retrying without it", article_id, exc_info=True)
    return {**await create_post(**post_args), "image_attached": False}
