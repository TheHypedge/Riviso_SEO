from __future__ import annotations

from pydantic import BaseModel, Field


class ProjectSettingsPublic(BaseModel):
    id: str
    name: str
    website_url: str | None = None
    wp_site_url: str | None = None
    wp_username: str | None = None
    wp_app_password_set: bool = False
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
