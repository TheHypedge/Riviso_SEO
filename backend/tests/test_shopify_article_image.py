import asyncio
import base64

from app.services.shopify_article_image import (
    build_shopify_article_image_payload,
    featured_image_bytes_from_data_url,
    shopify_article_has_featured_image,
)


def test_featured_image_bytes_from_data_url_png():
    data = b"\x89PNG\r\n\x1a\n"
    b64 = base64.b64encode(data).decode("ascii")
    url = f"data:image/png;base64,{b64}"
    parsed = featured_image_bytes_from_data_url(url)
    assert parsed is not None
    out_bytes, content_type, filename = parsed
    assert out_bytes == data
    assert content_type == "image/png"
    assert filename == "featured.png"


def test_build_shopify_article_image_payload_from_data_url():
    data = b"fake-image-bytes"
    b64 = base64.b64encode(data).decode("ascii")
    article = {
        "title": "Floral Suits",
        "image_url": f"data:image/jpeg;base64,{b64}",
    }
    payload = asyncio.run(build_shopify_article_image_payload(article))
    assert payload is not None
    assert payload["attachment"] == b64
    assert payload["filename"] == "featured.jpg"
    assert payload["alt"] == "Floral Suits"


def test_shopify_article_has_featured_image():
    assert shopify_article_has_featured_image({"image": {"src": "https://cdn.shopify.com/x.png"}})
    assert not shopify_article_has_featured_image({"image": {}})
    assert not shopify_article_has_featured_image(None)
