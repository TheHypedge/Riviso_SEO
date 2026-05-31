"""Shopify Admin API error parsing and operator-facing messages."""
from __future__ import annotations

from typing import Any

import httpx

# Primary scope shown in UI per REST resource (Shopify Dev Dashboard → Admin API).
SCOPE_FOR_RESOURCE: dict[str, str] = {
    "shop": "",
    "products": "read_products",
    "collections": "read_products",
    "blogs": "read_content",
    "pages": "read_content",
}

# Any one scope in the tuple satisfies access for that resource (Shopify allows alternates).
RESOURCE_SCOPE_ALTERNATIVES: dict[str, tuple[str, ...]] = {
    "products": ("read_products",),
    "collections": ("read_products",),
    "blogs": ("read_content",),
    "pages": ("read_content", "read_online_store_pages"),
}

# Minimum scopes Riviso needs to sync catalog + publish blogs.
REQUIRED_SYNC_SCOPES = (
    "read_products",
    "read_content",
)

REQUIRED_PUBLISH_SCOPES = (
    "read_content",
    "write_content",
)

RECOMMENDED_SCOPES = (
    *REQUIRED_SYNC_SCOPES,
    *REQUIRED_PUBLISH_SCOPES,
    "write_products",
    "read_online_store_pages",
    "write_online_store_pages",
)

# Human-readable reference for product-aware generation (API docs / catalog sync metadata).
PRODUCT_MAPPING_SCOPE_REFERENCE: tuple[dict[str, str], ...] = (
    {
        "scope": "read_products",
        "required": "true",
        "purpose": "Product titles, handles (/products/{handle}), and featured image URLs for content + img2img.",
    },
    {
        "scope": "read_content",
        "required": "true",
        "purpose": "Sync blogs and publish articles to Shopify.",
    },
    {
        "scope": "write_content",
        "required": "false",
        "purpose": "Create or update blog posts when publishing from Riviso.",
    },
    {
        "scope": "write_products",
        "required": "false",
        "purpose": "Optional product updates from Riviso (not required for mapping).",
    },
    {
        "scope": "read_content",
        "required": "true",
        "purpose": "List Shopify blogs before posting.",
    },
    {
        "scope": "write_content",
        "required": "true",
        "purpose": "Create blog articles as draft or published.",
    },
)

# Dev Dashboard scope picker labels (matches Shopify UI groupings).
SHOPIFY_DASHBOARD_SCOPE_GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "Products (Admin API)",
        ("read_products", "write_products"),
    ),
    (
        "Product feeds / listings (not catalog)",
        ("read_product_feeds", "write_product_feeds", "read_product_listings", "write_product_listings"),
    ),
    (
        "Store content (Admin API)",
        ("read_content", "write_content"),
    ),
)

# Scopes that sound product-related but do NOT grant Admin API /products.json access.
CONFUSABLE_PRODUCT_SCOPES: dict[str, str] = {
    "read_product_listings": "Sales channel listings only — not the store catalog.",
    "write_product_listings": "Sales channel listings only — not the store catalog.",
    "read_product_feeds": "Product feeds only — not individual products.",
    "write_product_feeds": "Product feeds only — not individual products.",
}

SCOPE_SETUP_MESSAGE = (
    "In Shopify Developer Dashboard → your app → Versions → Admin API access scopes, enable the "
    "missing scopes below, click Release on the new version, then click Connect store again in Riviso."
)

SCOPE_STALE_TOKEN_MESSAGE = (
    "If you already added scopes, ensure the version is Released (not only saved as draft), then "
    "Connect store or Sync from Shopify — Riviso refreshes the API token on each sync."
)


class ShopifyApiError(Exception):
  def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        resource: str = "",
        required_scope: str = "",
        response_body: str = "",
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.resource = resource
        self.required_scope = required_scope
        self.response_body = (response_body or "")[:500]


def parse_granted_scopes(scope_str: str) -> set[str]:
    raw = (scope_str or "").replace(",", " ").split()
    return {s.strip() for s in raw if s.strip()}


def resource_scope_satisfied(granted: set[str], resource: str) -> bool:
    alts = RESOURCE_SCOPE_ALTERNATIVES.get(resource, ())
    if not alts:
        return True
    return any(s in granted for s in alts)


def scopes_missing_for_publish(granted: set[str]) -> list[str]:
    """Scopes required to sync blogs and create/publish blog articles."""
    missing: list[str] = []
    for scope in REQUIRED_PUBLISH_SCOPES:
        if scope == "read_content" and resource_scope_satisfied(granted, "blogs"):
            continue
        if scope not in granted:
            missing.append(scope)
    return missing


def scopes_missing_for_sync(granted: set[str]) -> list[str]:
    """Return required scope names not present on the live token."""
    missing: list[str] = []
    for scope in REQUIRED_SYNC_SCOPES:
        if scope == "read_products" and resource_scope_satisfied(granted, "products"):
            continue
        if scope == "read_content" and (
            resource_scope_satisfied(granted, "blogs") or resource_scope_satisfied(granted, "pages")
        ):
            continue
        if scope not in granted:
            missing.append(scope)
    return missing


def build_scope_setup_hint(*, missing_sync: list[str], missing_publish: list[str], granted: set[str]) -> str:
    """Operator-facing hint based on what the live token is missing."""
    if not missing_sync and not missing_publish:
        return ""
    parts: list[str] = []
    if missing_sync:
        need = ", ".join(f"`{s}`" for s in missing_sync)
        parts.append(f"Catalog sync needs {need} on the store token.")
    if missing_publish:
        need = ", ".join(f"`{s}`" for s in missing_publish)
        parts.append(f"Posting to Shopify blogs needs {need}.")
    have = format_token_scopes_list(granted)
    parts.append(
        "Enable scopes on your released app version, click Update app permissions in Riviso, then Sync from Shopify."
    )
    parts.append(f"Token scopes now: {have}.")
    return " ".join(parts)


def format_token_scopes_list(granted: set[str], *, limit: int = 16) -> str:
    if not granted:
        return "(none — reconnect after Release + Install app)"
    items = sorted(granted)[:limit]
    tail = "" if len(granted) <= limit else f" (+{len(granted) - limit} more)"
    return ", ".join(f"`{s}`" for s in items) + tail


def access_denied_diagnosis(*, resource: str, granted: set[str], status_code: int | None) -> str:
    """Operator-facing line when Shopify returns 403 for a resource."""
    if status_code != 403:
        return ""
    primary = SCOPE_FOR_RESOURCE.get(resource, "")
    alts = RESOURCE_SCOPE_ALTERNATIVES.get(resource, (primary,) if primary else ())
    if resource_scope_satisfied(granted, resource):
        have = ", ".join(f"`{s}`" for s in alts if s in granted)
        return (
            f"Shopify returned HTTP 403 for {resource} even though this token lists {have}. "
            "Open Dev Dashboard → Overview → Install app on this store (or reinstall), confirm Riviso "
            "uses the Client ID from that same app, then click Refresh connection."
        )
    token_line = format_token_scopes_list(granted)
    confusion = scope_confusion_note(granted)
    need = primary or (alts[0] if alts else "the required scope")
    return (
        f"Token is missing `{need}` for {resource}. Scopes Shopify reports on this token: {token_line}."
        f"{confusion} {SCOPE_SETUP_MESSAGE} {SCOPE_STALE_TOKEN_MESSAGE}"
    )


def scope_confusion_note(granted: set[str]) -> str:
    """
    Explain when the token has product-adjacent scopes but not read_products
    (common misconfiguration in Dev Dashboard).
    """
    if "read_products" in granted:
        return ""
    present = [s for s in CONFUSABLE_PRODUCT_SCOPES if s in granted]
    if not present:
        return ""
    labels = ", ".join(f"`{s}`" for s in present)
    return (
        f" Your token includes {labels}, but those are not the same as `read_products`. "
        "In Versions → Admin API access scopes, search for and enable **Products** → "
        "`read_products`, then release and reconnect."
    )


def http_error_to_shopify_api_error(
    exc: httpx.HTTPStatusError,
    *,
    resource: str,
    granted: set[str] | None = None,
) -> ShopifyApiError:
    required = SCOPE_FOR_RESOURCE.get(resource, "")
    status = exc.response.status_code if exc.response is not None else None
    body = ""
    try:
        if exc.response is not None:
            body = (exc.response.text or "").strip()
    except Exception:
        body = ""

    granted_set = granted or set()

    if status == 403 and required:
        diagnosis = access_denied_diagnosis(resource=resource, granted=granted_set, status_code=status)
        message = f"Shopify denied access to {resource} (HTTP 403). {diagnosis}"
        return ShopifyApiError(
            message,
            status_code=status,
            resource=resource,
            required_scope=required,
            response_body=body,
        )

    if status in (401, 403):
        message = (
            "Authentication failed or access was denied. "
            "Reconnect in Project Settings with a valid Client ID and Secret, and confirm the app is installed on this store."
        )
        if status == 403:
            diagnosis = access_denied_diagnosis(resource=resource, granted=granted_set, status_code=status)
            message = f"Shopify denied access to {resource} (HTTP 403). {diagnosis or SCOPE_SETUP_MESSAGE}"
        return ShopifyApiError(message, status_code=status, resource=resource, response_body=body)

    return ShopifyApiError(
        f"Shopify API error for {resource}: HTTP {status}. {body[:200]}".strip(),
        status_code=status,
        resource=resource,
        response_body=body,
    )


def warning_dict(*, resource: str, exc: ShopifyApiError | Exception) -> dict[str, str]:
    if isinstance(exc, ShopifyApiError):
        return {
            "resource": resource,
            "code": "scope_denied" if exc.status_code == 403 else "api_error",
            "required_scope": exc.required_scope or SCOPE_FOR_RESOURCE.get(resource, ""),
            "message": str(exc),
        }
    return {
        "resource": resource,
        "code": "api_error",
        "required_scope": SCOPE_FOR_RESOURCE.get(resource, ""),
        "message": str(exc)[:500],
    }
