"""Persist Shopify sync results: products in ``shopify_products``, metadata on the project."""
from __future__ import annotations

from datetime import datetime
from typing import Any


def shopify_catalog_metadata_only(catalog: dict[str, Any]) -> dict[str, Any]:
    """Catalog snapshot without the embedded products array (stored in ``shopify_products``)."""
    if not isinstance(catalog, dict):
        return {}
    meta = dict(catalog)
    meta.pop("products", None)
    return meta


def persist_shopify_catalog_sync(
    st: Any,
    *,
    project_id: str,
    catalog: dict[str, Any],
    extra_project_fields: dict[str, Any] | None = None,
) -> None:
    """
    Write synced products to ``shopify_products`` and lightweight catalog metadata on the project.
    """
    pid = (project_id or "").strip()
    if not pid or not hasattr(st, "update_project_fields"):
        return

    products = catalog.get("products") if isinstance(catalog.get("products"), list) else []
    if hasattr(st, "upsert_shopify_products_bulk"):
        st.upsert_shopify_products_bulk(pid, products)

    fields: dict[str, Any] = {
        "shopify_catalog": shopify_catalog_metadata_only(catalog),
        "shopify_sync_at": (catalog.get("synced_at") or datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")),
        "shopify_sync_status": (catalog.get("sync_status") or "ok")[:32],
        "shopify_sync_message": (catalog.get("sync_message") or "")[:500],
    }
    if extra_project_fields:
        fields.update(extra_project_fields)
    st.update_project_fields(pid, fields)
