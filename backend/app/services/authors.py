"""
Post authors: which WordPress user / Shopify author name an article is published under.

Single source of truth is the article row (``wp_author_id`` / ``wp_author_name`` /
``shopify_author``). Every flow that creates, schedules or publishes content only writes the
choice onto the article (``author_updates``); every publish path resolves it the same way:

    article choice  ->  project default  ->  the connected WordPress user (WordPress default)

WordPress only lets a user publish as someone else with ``edit_others_posts`` (Editor/Admin).
Publishing never fails because of the author: WordPress falls back to the connected user and
the applied author is recorded (``wp_author_applied_id``) so the UI can show any mismatch.
"""
from __future__ import annotations

import logging
import time
from typing import Any

from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

MAX_SHOPIFY_AUTHORS = 20
_AUTHORS_TTL_S = 600.0
_authors_cache: dict[str, tuple[float, dict[str, Any]]] = {}


class AuthorChoice(BaseModel):
    """Optional author fields accepted by every generate/schedule/publish/edit request.

    Omitted = keep the article's current choice. ``wp_author_id=0`` clears it (use the project default).
    """

    wp_author_id: int | None = Field(default=None, ge=0, le=2_147_483_647)
    wp_author_name: str | None = Field(default=None, max_length=200)
    shopify_author: str | None = Field(default=None, max_length=200)


def author_updates(choice: Any) -> dict[str, Any]:
    """Article field updates for the author fields a request actually sent."""
    out: dict[str, Any] = {}
    wid = getattr(choice, "wp_author_id", None)
    if wid is not None:
        out["wp_author_id"] = int(wid) or None
        out["wp_author_name"] = (getattr(choice, "wp_author_name", None) or "").strip()[:200] if wid else ""
    sa = getattr(choice, "shopify_author", None)
    if sa is not None:
        out["shopify_author"] = sa.strip()[:200]
    return out


def _pos_int(v: Any) -> int | None:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def resolve_wp_author(article: dict[str, Any] | None, project: dict[str, Any] | None) -> tuple[int | None, str]:
    """(user id, display name) to publish as; (None, "") = let WordPress use the connected user."""
    a, p = article or {}, project or {}
    aid = _pos_int(a.get("wp_author_id"))
    if aid:
        return aid, (a.get("wp_author_name") or "").strip()
    pid = _pos_int(p.get("default_wp_author_id"))
    if pid:
        return pid, (p.get("default_wp_author_name") or "").strip()
    return None, ""


def resolve_shopify_author(article: dict[str, Any] | None, project: dict[str, Any] | None) -> str:
    return ((article or {}).get("shopify_author") or "").strip() or ((project or {}).get("default_shopify_author") or "").strip()


def clean_shopify_authors(names: Any) -> list[str]:
    out: list[str] = []
    for n in names or []:
        s = " ".join(str(n or "").split())[:200]
        if s and s.lower() not in {x.lower() for x in out}:
            out.append(s)
    return out[:MAX_SHOPIFY_AUTHORS]


def applied_author_fields(created: Any, requested_id: int | None, requested_name: str) -> dict[str, Any]:
    """Article updates after a WordPress publish: keep the chosen author and record what WP applied."""
    applied = _pos_int(created.get("author")) if isinstance(created, dict) else None
    out: dict[str, Any] = {"wp_author_applied_id": applied}
    if requested_id:
        out["wp_author_id"] = requested_id
        out["wp_author_name"] = requested_name
    return out


async def ensure_wp_author(wp: Any, *, rest_base: str, created: Any, author_id: int | None) -> Any:
    """Connector plugins older than 0.8.0 ignore ``author`` and don't report it; set it via core REST."""
    if not author_id or not isinstance(created, dict) or "author" in created:
        return created
    post_id = _pos_int(created.get("id"))
    if not post_id:
        return created
    try:
        res = await wp.post_json(f"/wp-json/wp/v2/{rest_base}/{post_id}", {"author": author_id}, timeout=30.0)
        if isinstance(res, dict) and res.get("author") is not None:
            created = {**created, "author": res.get("author")}
    except Exception as e:  # author is best-effort; the post itself is already live
        log.warning("Could not set WordPress author %s on post %s: %s", author_id, post_id, e)
    return created


# ---------------------------------------------------------------- listing WordPress authors

def _author_row(u: dict[str, Any]) -> dict[str, Any] | None:
    uid = _pos_int(u.get("id"))
    name = str(u.get("name") or u.get("display_name") or u.get("slug") or "").strip()
    if not uid or not name:
        return None
    return {"id": uid, "name": name[:200], "slug": str(u.get("slug") or "")[:200]}


async def _fetch_wp_authors(wp: Any) -> dict[str, Any]:
    await wp.ensure_resolved_site_url()
    # 1) Connector plugin (0.8.0+): every user who can write posts + whether we may assign them.
    for ns in ("riviso/v1", "auto-articles/v1"):
        try:
            data = await wp.get_json(f"/wp-json/{ns}/authors", timeout=20.0)
        except Exception:
            continue
        if isinstance(data, dict) and isinstance(data.get("authors"), list):
            authors = [r for r in (_author_row(u) for u in data["authors"] if isinstance(u, dict)) if r]
            return {"authors": authors, "current": _author_row(data.get("current") or {}),
                    "can_assign": bool(data.get("can_assign")), "source": "plugin"}
    # 2) Core REST: the connected user (with capabilities) + users who can author posts.
    me: dict[str, Any] = {}
    try:
        me = await wp.get_json("/wp-json/wp/v2/users/me?context=edit", timeout=20.0) or {}
    except Exception:
        me = {}
    caps = me.get("capabilities") if isinstance(me, dict) else None
    can_assign = bool(isinstance(caps, dict) and caps.get("edit_others_posts"))
    authors: list[dict[str, Any]] = []
    try:
        rows = await wp.get_json("/wp-json/wp/v2/users?who=authors&per_page=100&orderby=name&_fields=id,name,slug", timeout=20.0)
        authors = [r for r in (_author_row(u) for u in rows or [] if isinstance(u, dict)) if r]
    except Exception:
        authors = []
    current = _author_row(me) if isinstance(me, dict) else None
    if current and all(a["id"] != current["id"] for a in authors):
        authors.insert(0, current)
    return {"authors": authors, "current": current, "can_assign": can_assign, "source": "core"}


async def list_wp_authors(project: dict[str, Any], *, refresh: bool = False) -> dict[str, Any]:
    """Authors for the project's WordPress site, cached 10 min per site+user (it's on every generate form)."""
    from app.services.wordpress_client import WordpressClient

    site = (project.get("wp_site_url") or project.get("website_url") or "").strip()
    user = (project.get("wp_username") or "").strip()
    pw = (project.get("wp_app_password") or "").replace(" ", "").strip()
    if not site or not user or not pw:
        return {"authors": [], "current": None, "can_assign": False, "source": "not_connected"}
    key = f"{project.get('id')}|{site}|{user}"
    hit = _authors_cache.get(key)
    if hit and not refresh and time.monotonic() - hit[0] < _AUTHORS_TTL_S:
        return {**hit[1], "cached": True}
    data = await _fetch_wp_authors(WordpressClient(site_url=site, username=user, app_password=pw))
    data["authors"].sort(key=lambda a: a["name"].lower())
    if data["authors"] or data["current"]:
        _authors_cache[key] = (time.monotonic(), data)
    return {**data, "cached": False}
