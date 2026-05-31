from __future__ import annotations

from pydantic import BaseModel, Field


class ProjectPublic(BaseModel):
    id: str
    owner_user_id: str
    name: str
    website_url: str | None = None
    platform: str = "wordpress"
    shopify_connected: bool = False
    shopify_sync_status: str | None = None
    # Legacy free-text representation. Always present (auto-derived from the
    # structured fields below when they are set) so the article generation
    # pipeline keeps working without changes.
    brand_identity: str | None = None
    niche_identifier: str | None = None
    # Structured Brand identity inputs surfaced to Project Settings.
    brand_voice: str | None = None
    brand_tones: list[str] = Field(default_factory=list)
    brand_rules: str | None = None
    # Structured Niche identifier inputs.
    niche_topic: str | None = None
    audience: list[str] = Field(default_factory=list)
    target_countries: list[str] = Field(default_factory=list)
    target_cities: list[str] = Field(default_factory=list)
    # ``True`` means "target every country" (global). When set, the
    # ``target_countries`` list is ignored by downstream consumers and the
    # derived niche text reads "Target countries: all countries (global
    # targeting)". Stored as a flag so we don't have to enumerate ~250
    # ISO codes on every project document.
    target_countries_all: bool = False
    # ``True`` means "target every city of the selected countries", in which
    # case ``target_cities`` is ignored by downstream consumers.
    target_cities_all: bool = False


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    website_url: str | None = Field(default=None, max_length=2048)
    platform: str = Field(default="wordpress", max_length=32)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    website_url: str | None = Field(default=None, max_length=2048)
    platform: str | None = Field(default=None, max_length=32)
    # Legacy fields — accepted for back-compat, but the new clients should
    # send the structured fields below and let the backend rebuild the
    # plain-text representation.
    brand_identity: str | None = Field(default=None, max_length=20000)
    niche_identifier: str | None = Field(default=None, max_length=20000)
    # Structured Brand identity inputs.
    brand_voice: str | None = Field(default=None, max_length=64)
    brand_tones: list[str] | None = Field(default=None, max_length=10)
    brand_rules: str | None = Field(default=None, max_length=4000)
    # Structured Niche identifier inputs.
    niche_topic: str | None = Field(default=None, max_length=500)
    audience: list[str] | None = Field(default=None, max_length=30)
    # ``target_countries`` accepts up to ~270 codes (ISO-3166 has ~250
    # countries + territories; the buffer covers historical / disputed
    # codes). The ``target_countries_all`` flag below is the canonical way
    # to mean "all countries" — that representation only writes a single
    # boolean instead of enumerating the world list.
    target_countries: list[str] | None = Field(default=None, max_length=270)
    target_countries_all: bool | None = None
    target_cities: list[str] | None = Field(default=None, max_length=500)
    target_cities_all: bool | None = None
