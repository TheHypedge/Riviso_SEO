"""
InternalLinkService — Feature 3 (Automated Internal Linking Engine).

Two responsibilities:

1. **Site-map ingestion** (working in v1) — :meth:`sync_site_map_from_wp` paginates
   the WordPress REST API and persists ``{post_url, post_title, focus_keyphrase,
   post_modified_at}`` rows for the project. Yoast/RankMath SEO meta is harvested
   when ``yoast_head_json`` is exposed by the site.
2. **Link injection into generated articles** (skeleton in v1) —
   :meth:`apply_internal_links` will walk the new article's HTML and insert ``<a>``
   tags pointing at the most relevant existing posts. v1 ships the API surface so
   the frontend can already display "Internal links: N" telemetry; the matching
   logic lands in the follow-up PR.

Why pull-first: the WP plugin doesn't need any change to support v1, so every
existing customer benefits the moment they enter their app password.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime
from typing import Any

import httpx

from app.legacy.storage import get_legacy_storage_module
from app.services.wordpress_client import WordpressClient


log = logging.getLogger(__name__)


_PER_PAGE = 100  # WordPress core caps per_page at 100; loop with offset to ingest large sites.
_MAX_POSTS = 5000  # Guard rail; surface a warning when a site has more than this.
_HTML_STRIP_RE = re.compile(r"<[^>]+>")


def _strip_html(s: str) -> str:
    return _HTML_STRIP_RE.sub(" ", s or "").strip()


def _extract_focus_keyphrase(post: dict[str, Any]) -> str:
    """Best-effort extraction of a focus keyphrase from common SEO plugins."""
    yh = post.get("yoast_head_json") or {}
    if isinstance(yh, dict):
        # Yoast SEO surfaces the focus keyphrase in og_description in some configs.
        for key in ("og_description", "description", "title"):
            val = (yh.get(key) or "").strip()
            if val:
                return val[:200]
    rm = post.get("rank_math_focus_keyword") or post.get("rank_math") or {}
    if isinstance(rm, dict):
        for key in ("focus_keyword", "primary_focus_keyword"):
            val = (rm.get(key) or "").strip()
            if val:
                return val[:200]
    if isinstance(rm, str) and rm.strip():
        return rm.strip()[:200]
    # Final fallback: trimmed post title (rendered).
    title = ((post.get("title") or {}).get("rendered") if isinstance(post.get("title"), dict) else "") or ""
    return _strip_html(title)[:200]


def _build_keyword_set(post: dict[str, Any], focus: str) -> list[str]:
    """Tags + categories often double as good link anchors. Up to 10 unique strings."""
    out: list[str] = []
    if focus:
        out.append(focus)
    embedded = post.get("_embedded") or {}
    if isinstance(embedded, dict):
        terms_groups = embedded.get("wp:term") or []
        if isinstance(terms_groups, list):
            for group in terms_groups:
                if not isinstance(group, list):
                    continue
                for term in group:
                    if isinstance(term, dict):
                        n = (term.get("name") or "").strip()
                        if n and n not in out:
                            out.append(n)
    return [k[:120] for k in out[:10] if k]


class InternalLinkService:
    """Project-scoped service. Instantiate per-request."""

    def __init__(self, *, project: dict[str, Any]) -> None:
        self.project = project
        self.project_id = (project.get("id") or "").strip()

    # ---- v1: WordPress REST ingestion (working) ------------------------------

    def _wp_client(self) -> WordpressClient:
        return WordpressClient(
            site_url=self.project.get("wp_site_url") or self.project.get("website_url") or "",
            username=self.project.get("wp_username") or "",
            app_password=self.project.get("wp_app_password") or "",
        )

    async def sync_site_map_from_wp(self) -> dict[str, Any]:
        """
        Walk ``/wp/v2/posts`` (paginated) and persist a fresh site map for the project.

        Returns ``{count, truncated, fetched_at}``. ``truncated=True`` means the site has
        more posts than ``_MAX_POSTS`` and the UI should suggest plugin-push as a follow-up.
        """
        wp = self._wp_client()
        client = httpx.AsyncClient(timeout=30.0, follow_redirects=True)
        out: list[dict[str, Any]] = []
        truncated = False
        try:
            page = 1
            while len(out) < _MAX_POSTS:
                # ``status=publish`` keeps drafts out of internal-link suggestions.
                # ``_embed`` brings categories/tags into the response so we can use them as anchor candidates.
                path = (
                    f"/wp-json/wp/v2/posts?status=publish&per_page={_PER_PAGE}"
                    f"&page={page}&_embed=1&_fields=id,link,title,modified_gmt,yoast_head_json,_embedded"
                )
                try:
                    res = await client.get(wp._url(path), headers=wp._headers)
                except Exception as e:
                    raise RuntimeError(f"WordPress REST error during site-map sync: {e}") from e
                if res.status_code == 400 and page > 1:
                    # WP returns 400 once you ask for a page beyond the last one.
                    break
                if res.status_code == 401:
                    raise RuntimeError("WordPress rejected credentials during site-map sync (401).")
                if res.status_code != 200:
                    raise RuntimeError(
                        f"WordPress REST error during site-map sync ({res.status_code}): "
                        f"{(res.text or '')[:200]}"
                    )
                try:
                    posts = res.json()
                except Exception:
                    posts = []
                if not isinstance(posts, list) or not posts:
                    break
                for p in posts:
                    if not isinstance(p, dict):
                        continue
                    title_obj = p.get("title") if isinstance(p.get("title"), dict) else {}
                    title = _strip_html((title_obj or {}).get("rendered") or "")
                    focus = _extract_focus_keyphrase(p)
                    featured_image_url = ""
                    embedded = p.get("_embedded") if isinstance(p.get("_embedded"), dict) else {}
                    media = embedded.get("wp:featuredmedia") if isinstance(embedded, dict) else None
                    if isinstance(media, list) and media and isinstance(media[0], dict):
                        featured_image_url = str(media[0].get("source_url") or "").strip()
                    out.append(
                        {
                            "post_url": (p.get("link") or "").strip(),
                            "post_title": title,
                            "focus_keyphrase": focus,
                            "focus_keywords": _build_keyword_set(p, focus),
                            "post_id": str(p.get("id") or ""),
                            "post_modified_at": str(p.get("modified_gmt") or ""),
                            "featured_image_url": featured_image_url,
                        }
                    )
                if len(posts) < _PER_PAGE:
                    break
                page += 1
            if len(out) >= _MAX_POSTS:
                truncated = True
        finally:
            await client.aclose()

        # Persist (synchronous storage call — wrap in to_thread when calling from a request).
        st = get_legacy_storage_module()
        await asyncio.to_thread(st.replace_site_map_for_project, self.project_id, out)
        return {
            "count": len(out),
            "truncated": truncated,
            "fetched_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        }

    def list_site_map(self, *, limit: int = 5000) -> list[dict[str, Any]]:
        st = get_legacy_storage_module()
        return st.load_site_map_for_project(self.project_id, limit=limit)

    # ---- v1: link injection (skeleton — see module docstring) ----------------

    def apply_internal_links(
        self,
        *,
        article_html: str,
        max_links: int = 4,
    ) -> tuple[str, int]:
        """
        Insert ``<a>`` tags for the best matching existing posts. v1 stub — returns the
        HTML unchanged with ``count=0``. The next iteration plugs in scoring + injection.

        Returning the stub here lets us already wire telemetry into the article generation
        pipeline so the UI can show "Internal links: 0" today and start showing real numbers
        the moment the matching logic lands.
        """
        return article_html or "", 0
