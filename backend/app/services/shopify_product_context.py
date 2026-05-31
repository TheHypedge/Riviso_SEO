from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse


def _norm_words(s: str) -> set[str]:
    text = (s or "").strip().lower()
    # Keep alphanumerics; split on everything else.
    parts = re.split(r"[^a-z0-9]+", text)
    return {p for p in parts if len(p) >= 3}


def _canonical_store_base(website_url: str | None) -> str:
    raw = (website_url or "").strip()
    if not raw:
        return ""
    s = raw if "://" in raw else f"https://{raw}"
    try:
        u = urlparse(s)
    except Exception:
        return ""
    if not u.scheme or not u.netloc:
        return ""
    return f"{u.scheme}://{u.netloc}".rstrip("/")


def _product_url(store_base: str, handle: str) -> str:
    h = (handle or "").strip().lstrip("/").split("?")[0].split("#")[0]
    if not store_base or not h:
        return ""
    return f"{store_base}/products/{h}"


def _load_shopify_catalog_products(proj: dict[str, Any]) -> list[dict[str, Any]]:
    """Products from ``shopify_products`` collection, with legacy embedded-catalog fallback."""
    catalog = proj.get("shopify_catalog") if isinstance(proj.get("shopify_catalog"), dict) else {}
    embedded = catalog.get("products") if isinstance(catalog.get("products"), list) else []
    if embedded:
        return [p for p in embedded if isinstance(p, dict)]
    pid = (proj.get("id") or "").strip()
    if not pid:
        return []
    try:
        from app.legacy.storage import get_legacy_storage_module

        st = get_legacy_storage_module()
        if hasattr(st, "list_shopify_products"):
            return st.list_shopify_products(pid)
    except Exception:
        pass
    return []


def select_relevant_shopify_products(
    *,
    proj: dict[str, Any],
    title: str,
    keywords: list[str],
    focus_keyphrase: str,
    max_products: int = 3,
    products: list[dict[str, Any]] | None = None,
) -> list[dict[str, str]]:
    """
    Select top N relevant Shopify products from the synced catalog snapshot.

    Returns a list of dicts with: name, url, price.
    """
    store_base = _canonical_store_base(proj.get("website_url") or "")
    if products is None:
        products = _load_shopify_catalog_products(proj)

    query_words = set()
    query_words |= _norm_words(title)
    query_words |= _norm_words(focus_keyphrase)
    for k in keywords or []:
        query_words |= _norm_words(str(k))
    if not query_words:
        return []

    scored: list[tuple[int, dict[str, Any]]] = []
    for p in products:
        if not isinstance(p, dict):
            continue
        status = str(p.get("status") or "").strip().lower()
        # Default to active products; archived/draft should not be recommended.
        if status and status != "active":
            continue
        name = str(p.get("title") or "").strip()
        handle = str(p.get("handle") or "").strip()
        if not name or not handle:
            continue
        tags = str(p.get("tags") or "")
        hay = f"{name} {tags}"
        words = _norm_words(hay)
        # Simple overlap score; weigh title hits a bit more than tags.
        title_words = _norm_words(name)
        score = len(query_words & words) + len(query_words & title_words)
        if score <= 0:
            continue
        scored.append((score, p))

    scored.sort(key=lambda x: x[0], reverse=True)
    out: list[dict[str, str]] = []
    for _score, p in scored[: max(0, int(max_products))]:
        name = str(p.get("title") or "").strip()
        handle = str(p.get("handle") or "").strip()
        price = str(p.get("price") or "").strip()
        url = _product_url(store_base, handle)
        if not url:
            continue
        out.append({"name": name, "url": url, "price": price})
    return out


def format_product_context(products: list[dict[str, str]]) -> str:
    if not products:
        return ""
    lines = ["Shopify product context (use naturally; do not invent products or URLs):"]
    for p in products:
        name = (p.get("name") or "").strip()
        url = (p.get("url") or "").strip()
        price = (p.get("price") or "").strip()
        if not name or not url:
            continue
        if price:
            lines.append(f"- {name} — Price: {price} — URL: {url}")
        else:
            lines.append(f"- {name} — URL: {url}")
    return "\n".join(lines).strip()

