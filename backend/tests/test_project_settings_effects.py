"""Every Project Settings switch must change what the backend does (not just what the form shows)."""
import asyncio

from app.services import platform_generation as pg
from app.services import shopify_product_pipeline as spp
from app.services import wordpress_content_pipeline as wcp
from app.services.gsc_actions import maybe_request_url_inspection
from app.services.schema_markup import build_schema_meta
from app.services.shopify_product_pipeline import ShopifyMappedProduct
from app.services.wordpress_content_pipeline import WordPressMappedPage

WP = {"id": "p1", "platform": "wordpress", "wp_site_url": "https://site.com"}
SHOP = {"id": "p1", "platform": "shopify", "shopify_shop": "demo.myshopify.com"}
PAGE = WordPressMappedPage(title="Bail guide", post_url="https://site.com/bail-guide/", featured_image_url="", post_id="7")


def _wp(monkeypatch, proj, mapped_pages=None):
    monkeypatch.setattr(wcp, "_catalog_fallback_pages", lambda **kw: [PAGE])
    return pg.resolve_platform_generation_extras(proj=proj, title="Default bail", keywords=["bail"], focus="default bail",
                                                 mapped_pages=mapped_pages)


def test_internal_link_aware_switch_controls_automatic_page_selection(monkeypatch):
    assert _wp(monkeypatch, {**WP, "wp_internal_link_aware_enabled": False}) == {}
    on = _wp(monkeypatch, {**WP, "wp_internal_link_aware_enabled": True})
    assert on["wp_mapped_pages"][0]["post_url"] == PAGE.post_url and "bail-guide" in on["product_context"]
    # Explicit choices always win: [] = "no pages", picked pages honoured even with the switch off.
    assert _wp(monkeypatch, {**WP, "wp_internal_link_aware_enabled": True}, mapped_pages=[]) == {}
    picked = _wp(monkeypatch, {**WP, "wp_internal_link_aware_enabled": False},
                 mapped_pages=[{"title": "Other", "post_url": "https://site.com/other/"}])
    assert picked["wp_mapped_pages"][0]["post_url"] == "https://site.com/other/"


def test_product_aware_switch_controls_automatic_product_selection(monkeypatch):
    prod = ShopifyMappedProduct(title="Linen kurta", handle="linen-kurta", featured_image_url="", product_path="/products/linen-kurta")
    monkeypatch.setattr(spp, "_catalog_fallback_products", lambda **kw: [prod])

    def run(proj, mapped=None):
        return pg.resolve_platform_generation_extras(proj=proj, title="Kurta guide", keywords=[], focus="kurta", mapped_products=mapped)

    assert run({**SHOP, "shopify_product_aware_enabled": False}) == {}
    on = run({**SHOP, "shopify_product_aware_enabled": True})
    assert on["shopify_mapped_products"][0]["handle"] == "linen-kurta"
    assert run({**SHOP, "shopify_product_aware_enabled": True}, mapped=[]) == {}


def test_schema_markup_switch():
    art = {"title": "T", "wp_link": "https://site.com/t/", "article": "## Frequently Asked Questions\n\n### Is it automatic?\nYes. It is.\n"}
    assert build_schema_meta(art, {"schema_markup_enabled": False}, None) == {}
    assert "_riviso_schema_faq" in build_schema_meta(art, {"schema_markup_enabled": True}, None)
    assert "_riviso_schema_faq" in build_schema_meta(art, {}, None)  # default on


def test_gsc_index_on_publish_switch(monkeypatch):
    calls = []

    async def fake_now(**kw):
        calls.append(kw["live_url"])
        return {"indexing_api": {"ok": True}}

    monkeypatch.setattr("app.services.gsc_actions.request_url_inspection_now", fake_now)
    proj = {"gsc_property_url": "sc-domain:site.com"}
    run = lambda p: asyncio.run(maybe_request_url_inspection(st=None, proj=p, live_url="https://site.com/t/", wp_status="publish", article_id="a"))
    run({**proj, "gsc_index_on_publish": False})
    assert calls == []
    run({**proj, "gsc_index_on_publish": True})
    assert calls == ["https://site.com/t/"]
