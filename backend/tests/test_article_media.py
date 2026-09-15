import asyncio
import os

from app.services import article_media_storage
from app.services.article_media_storage import save_article_media, load_article_media
from app.services.wordpress_client import rewrite_inline_media_for_wordpress


def _cleanup(image_id: str) -> None:
    for path in (article_media_storage._bin_path(image_id), article_media_storage._meta_path(image_id)):
        try:
            os.remove(path)
        except OSError:
            pass


def test_save_and_load_article_media_round_trip():
    image_id = save_article_media(
        data=b"fake-png-bytes",
        content_type="image/png",
        project_id="proj-1",
        article_id="art-1",
    )
    try:
        loaded = load_article_media(image_id)
        assert loaded == (b"fake-png-bytes", "image/png")
    finally:
        _cleanup(image_id)


def test_load_article_media_unknown_id_returns_none():
    assert load_article_media("00000000-0000-0000-0000-000000000000") is None


def test_load_article_media_rejects_unsafe_id():
    assert load_article_media("../../etc/passwd") is None
    assert load_article_media("") is None


class _FakeWordpressClient:
    def __init__(self):
        self.calls = []

    async def upload_media(self, *, filename, content_type, data, timeout=90.0):
        self.calls.append((filename, content_type, data))
        return {"id": 99, "source_url": "https://example.com/wp-content/uploads/pic.png"}


def test_rewrite_inline_media_for_wordpress_rewrites_own_images_only():
    image_id = save_article_media(
        data=b"fake-bytes",
        content_type="image/png",
        project_id="proj-1",
        article_id="art-1",
    )
    try:
        html = (
            f'<p>Hello</p>'
            f'<img src="http://localhost:8000/api/public/article-media/{image_id}" class="alignleft" style="width:300px">'
            f'<p>External:</p>'
            f'<img src="https://other.com/pic.jpg">'
        )
        wp = _FakeWordpressClient()
        out = asyncio.run(rewrite_inline_media_for_wordpress(html, wp=wp))

        assert "https://example.com/wp-content/uploads/pic.png" in out
        assert "wp-image-99" in out
        assert "alignleft" in out
        assert "https://other.com/pic.jpg" in out
        assert len(wp.calls) == 1
    finally:
        _cleanup(image_id)


def test_rewrite_inline_media_for_wordpress_noop_without_own_images():
    html = "<p>Hello</p><img src=\"https://other.com/pic.jpg\">"
    wp = _FakeWordpressClient()
    out = asyncio.run(rewrite_inline_media_for_wordpress(html, wp=wp))
    assert out == html
    assert wp.calls == []
