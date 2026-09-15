"""Canonical live website URL for a project — shared by Technical Audit and (later) SEO Audit."""

from __future__ import annotations

from typing import Any


def resolve_project_website_url(proj: dict[str, Any]) -> str | None:
    """
    Best-known live URL for this project's website, or None if nothing is configured.

    WordPress projects: wp_site_url (the verified/connected site), falling back to the
    generic website_url field. Shopify projects: built from shopify_shop (the shop
    domain), falling back to website_url (project_shopify.py already writes the public
    URL there after verification, e.g. project_shopify.py:333).
    """
    platform = (proj.get("platform") or "").strip().lower()
    if platform == "shopify":
        shop = (proj.get("shopify_shop") or "").strip()
        if shop:
            return f"https://{shop}"
        return (proj.get("website_url") or "").strip() or None
    return (proj.get("wp_site_url") or "").strip() or (proj.get("website_url") or "").strip() or None
