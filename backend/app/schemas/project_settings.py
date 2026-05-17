from __future__ import annotations

from pydantic import BaseModel, Field


class ProjectSettingsPublic(BaseModel):
    id: str
    name: str
    website_url: str | None = None
    wp_site_url: str | None = None
    wp_username: str | None = None
    wp_app_password_set: bool = False
    wp_app_password: str | None = Field(
        default=None,
        description="Application password for this project (returned to authorized project members for editing).",
    )
    # Last-known verification snapshot. ``wp_verified_at`` is the UTC ISO
    # timestamp of the last successful ``POST /wordpress/verify`` for this
    # project; cleared whenever the credentials change. ``wp_verified_status``
    # mirrors the latest verify-route status string (``connected``,
    # ``auth_failed``, ``failed``, ``error``) so the UI can colour the pill
    # appropriately without re-running the verify call on every page load.
    wp_verified_at: str | None = None
    wp_verified_status: str | None = None
    wp_verified_message: str | None = None
    # Connector plugin verification snapshot. ``wp_plugin_status`` is one of
    # ``active``, ``upgrade_required``, ``installed``, ``capability``, ``missing``, ``unknown``;
    # ``wp_plugin_message`` is the short user-facing line for the status
    # pill. Both are populated by ``POST /wordpress/verify`` and cleared
    # whenever credentials change.
    wp_plugin_status: str | None = None
    wp_plugin_message: str | None = None
    plugin_download_url: str
    default_wp_rest_base: str | None = None
    default_wp_status: str | None = None
    default_wp_category_ids: list[int] = Field(default_factory=list)
    gsc_property_url: str | None = None
    gsc_index_on_publish: bool = True


class ProjectSettingsUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    website_url: str | None = Field(default=None, max_length=2048)
    wp_site_url: str | None = Field(default=None, max_length=2048)
    wp_username: str | None = Field(default=None, max_length=200)
    wp_app_password: str | None = Field(default=None, max_length=500)
    default_wp_rest_base: str | None = Field(default=None, max_length=200)
    default_wp_status: str | None = Field(default=None, max_length=16)
    default_wp_category_ids: list[int] | None = None
    gsc_property_url: str | None = Field(default=None, max_length=2048)
    gsc_index_on_publish: bool | None = None


class WordpressVerifyRequest(BaseModel):
    wp_site_url: str | None = Field(default=None, max_length=2048)
    wp_username: str | None = Field(default=None, max_length=200)
    wp_app_password: str | None = Field(default=None, max_length=500)


class WordpressVerifyResponse(BaseModel):
    ok: bool
    status: str
    message: str
