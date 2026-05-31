from __future__ import annotations

from pydantic import BaseModel, Field


class ShopifyConnectUrlRequest(BaseModel):
    shop: str | None = Field(
        default=None,
        max_length=2048,
        description="Store website (https://example.com) or Shopify admin (store.myshopify.com)",
    )
    return_origin: str | None = Field(
        default=None,
        max_length=2048,
        description="Browser origin to return to after OAuth (e.g. http://127.0.0.1:3000)",
    )


class ShopifyResolveShopRequest(BaseModel):
    shop: str = Field(min_length=1, max_length=2048)


class ShopifyResolveShopResponse(BaseModel):
    ok: bool
    myshopify_domain: str | None = None
    public_url: str | None = None
    message: str | None = None


class ShopifyVerifyRequest(BaseModel):
    shop: str | None = Field(default=None, max_length=2048)
    client_id: str | None = Field(default=None, max_length=256)
    client_secret: str | None = Field(default=None, max_length=5000)
    access_token: str | None = Field(default=None, max_length=5000)


class ShopifyVerifyResponse(BaseModel):
    ok: bool
    status: str
    message: str
    needs_oauth: bool = False
    needs_reauthorize: bool = False
    reauthorize_url: str | None = None
    granted_scopes: list[str] = Field(default_factory=list)
    missing_scopes: list[str] = Field(default_factory=list)
    shop: str | None = None


class ShopifyConnectRequest(BaseModel):
    """Connect via Shopify Developer Dashboard client credentials (client ID + secret)."""

    shop: str = Field(min_length=1, max_length=2048, description="brandname.myshopify.com or store URL")
    client_id: str = Field(min_length=8, max_length=256)
    client_secret: str = Field(min_length=8, max_length=5000, description="App Client secret (shpss_…)")


class ShopifyConnectResponse(BaseModel):
    ok: bool
    status: str
    message: str
    shop: str | None = None
    needs_reauthorize: bool = False
    reauthorize_url: str | None = None
    granted_scopes: list[str] = Field(default_factory=list)
    missing_scopes: list[str] = Field(default_factory=list)


class ShopifyReauthorizeUrlRequest(BaseModel):
    shop: str | None = Field(default=None, max_length=2048)
    return_origin: str | None = Field(default=None, max_length=2048)


class ShopifyReauthorizeUrlResponse(BaseModel):
    ok: bool
    url: str | None = None
    shop: str | None = None
    message: str | None = None


class ShopifyManualConnectRequest(BaseModel):
    """Legacy: direct Admin API access token paste."""

    shop: str = Field(min_length=1, max_length=2048, description="store.myshopify.com or https://store domain")
    access_token: str = Field(min_length=10, max_length=5000, description="Admin API access token from a Shopify custom app")


class ShopifyManualConnectResponse(BaseModel):
    ok: bool
    status: str
    message: str
    shop: str | None = None


class ShopifySyncWarning(BaseModel):
    resource: str = ""
    code: str = ""
    required_scope: str = ""
    message: str = ""


class ShopifyStatus(BaseModel):
    configured: bool
    connect_ready: bool = False
    connected: bool
    shop: str | None = None
    connected_at: str | None = None
    sync_at: str | None = None
    sync_status: str | None = None
    sync_message: str | None = None
    counts: dict[str, int] = Field(default_factory=dict)
    setup_hint: str | None = None
    warnings: list[ShopifySyncWarning] = Field(default_factory=list)
    granted_scopes: list[str] = Field(default_factory=list)
    required_scopes: list[str] = Field(default_factory=list)
    recommended_scopes: list[str] = Field(default_factory=list)
    needs_reauthorize: bool = False
    can_publish: bool = False
    missing_publish_scopes: list[str] = Field(default_factory=list)
    has_product_catalog_scope: bool = False


class ShopifyCatalog(BaseModel):
    synced_at: str | None = None
    sync_status: str | None = None
    sync_message: str | None = None
    counts: dict[str, int] = Field(default_factory=dict)
    shop: dict[str, str] = Field(default_factory=dict)
    products: list[dict] = Field(default_factory=list)
    collections: list[dict] = Field(default_factory=list)
    blogs: list[dict] = Field(default_factory=list)
    pages: list[dict] = Field(default_factory=list)
    warnings: list[ShopifySyncWarning] = Field(default_factory=list)
    granted_scopes: list[str] = Field(default_factory=list)
    required_scopes: list[str] = Field(default_factory=list)
    recommended_scopes: list[str] = Field(default_factory=list)
    product_mapping_scopes: list[dict[str, str]] = Field(default_factory=list)
