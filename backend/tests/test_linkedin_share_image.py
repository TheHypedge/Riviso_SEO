"""LinkedIn shares must carry the article's featured image.

Regressions covered: the image was only attached inside a link card (so articles without
a live URL went out text-only), was attached before LinkedIn finished processing it, and
every failure was swallowed silently. All HTTP goes to an in-memory mock transport --
nothing reaches LinkedIn.
"""

from __future__ import annotations

import asyncio
import base64
import json

import httpx
import pytest

from app.services import linkedin_client

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 64
IMAGE_URN = "urn:li:image:C4E10AQF"
LIVE_URL = "https://example.test/my-article/"


class _Storage:
    def __init__(self, image: bytes | None):
        self._image = image

    def get_article_image_url(self, *, project_id, article_id):
        return f"data:image/png;base64,{base64.b64encode(self._image).decode()}" if self._image else None


def _article(**kw):
    return {"id": "a1", "title": "My Article", "meta_description": "desc", **kw}


@pytest.fixture()
def linkedin(monkeypatch):
    """Mock LinkedIn: records every request; `state` tunes the responses."""
    state = {"processing_polls": 0, "reject_image_post": False, "requests": [], "posts": []}

    def handler(req: httpx.Request) -> httpx.Response:
        state["requests"].append((req.method, str(req.url)))
        url = str(req.url)
        if "action=initializeUpload" in url:
            return httpx.Response(200, json={"value": {"uploadUrl": "https://upload.test/put", "image": IMAGE_URN}})
        if url.startswith("https://upload.test/"):
            return httpx.Response(201)
        if req.method == "GET" and "/rest/images/" in url:
            if state["processing_polls"] > 0:
                state["processing_polls"] -= 1
                return httpx.Response(200, json={"status": "PROCESSING"})
            return httpx.Response(200, json={"status": "AVAILABLE"})
        if url == linkedin_client.POSTS_URL:
            body = json.loads(req.content)
            state["posts"].append(body)
            if state["reject_image_post"] and "media" in (body.get("content") or {}):
                return httpx.Response(422, json={"message": "image rejected"})
            return httpx.Response(201, headers={"x-restli-id": "urn:li:share:1"})
        return httpx.Response(404)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(linkedin_client.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(linkedin_client, "_IMAGE_READY_INTERVAL_S", 0)
    return state


def _share(image: bytes | None, **article_kw):
    return asyncio.run(
        linkedin_client.share_article(
            st=_Storage(image), project_id="p1", article=_article(**article_kw),
            access_token="tok", author_urn="urn:li:person:x", commentary="Read this (now)",
        )
    )


def test_published_article_posts_featured_image_with_link_in_text(linkedin):
    res = _share(PNG, wp_link=LIVE_URL)
    assert res["image_attached"] is True
    post = linkedin["posts"][-1]
    assert post["content"]["media"]["id"] == IMAGE_URN
    assert LIVE_URL in post["commentary"]


def test_unpublished_article_still_gets_the_image(linkedin):
    res = _share(PNG)
    assert res["image_attached"] is True
    assert linkedin["posts"][-1]["content"]["media"]["id"] == IMAGE_URN


def test_waits_until_image_is_available_before_posting(linkedin):
    linkedin["processing_polls"] = 3
    assert _share(PNG)["image_attached"] is True
    gets = [r for r in linkedin["requests"] if r[0] == "GET"]
    assert len(gets) == 4


def test_unsupported_format_falls_back_to_link_card(linkedin):
    res = _share(WEBP, wp_link=LIVE_URL)
    assert res["image_attached"] is False
    assert not any("initializeUpload" in u for _, u in linkedin["requests"])
    assert linkedin["posts"][-1]["content"] == {"article": {"source": LIVE_URL, "title": "My Article", "description": "desc"}}


def test_rejected_image_post_is_retried_without_image(linkedin):
    linkedin["reject_image_post"] = True
    res = _share(PNG, wp_link=LIVE_URL)
    assert res == {"post_urn": "urn:li:share:1", "post_url": "https://www.linkedin.com/feed/update/urn:li:share:1/", "image_attached": False}
    assert [("media" in (p.get("content") or {})) for p in linkedin["posts"]] == [True, False]


def test_no_featured_image_and_no_url_is_plain_text(linkedin):
    res = _share(None)
    assert res["image_attached"] is False
    assert "content" not in linkedin["posts"][-1]


def test_cloudinary_webp_is_requested_as_jpg():
    assert linkedin_client._linkedin_ready_url("https://res.cloudinary.com/x/image/upload/v1/a.webp") == "https://res.cloudinary.com/x/image/upload/v1/a.jpg"
    assert linkedin_client._linkedin_ready_url("https://cdn.example.test/a.webp") == "https://cdn.example.test/a.webp"
