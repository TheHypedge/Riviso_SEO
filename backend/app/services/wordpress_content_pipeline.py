"""
WordPress-only internal page mapping, prompt context, post-generation link injection,
and optional featured-image reference for img2img.

Shopify flows must not import this module unless guarded by ``is_wordpress_project``.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

log = logging.getLogger(__name__)

@dataclass(frozen=True)
class WordPressMappedPage:
    title: str
    post_url: str
    featured_image_url: str
    post_id: str

    def as_dict(self) -> dict[str, str]:
        return {
            "title": self.title,
            "post_url": self.post_url,
            "featured_image_url": self.featured_image_url,
            "post_id": self.post_id,
        }


@dataclass(frozen=True)
class WordPressGenerationContext:
    """Resolved WordPress internal-link targets for a single generation run."""

    product_context: str | None
    mapped_pages: list[WordPressMappedPage]
    reference_image_url: str | None


def is_wordpress_project(proj: dict[str, Any]) -> bool:
    plat = (proj.get("platform") or "wordpress").strip().lower()
    return plat not in ("shopify",) and plat != ""


def wp_internal_link_aware_enabled(proj: dict[str, Any]) -> bool:
    return bool(proj.get("wp_internal_link_aware_enabled", False))


def is_valid_page_image_url(raw: str) -> bool:
    s = (raw or "").strip()
    if not s:
        return False
    try:
        u = urlparse(s)
    except Exception:
        return False
    return u.scheme in ("http", "https") and bool(u.netloc)


def _normalize_post_url(raw: str, *, site_base: str) -> str:
    u = (raw or "").strip()
    if not u:
        return ""
    if u.startswith("/"):
        base = (site_base or "").rstrip("/")
        return f"{base}{u}" if base else u
    return u


def normalize_mapped_pages(
    raw: Any,
    *,
    site_base: str = "",
    max_items: int = 5,
) -> list[WordPressMappedPage]:
    """Parse UI / queue payload page objects. Drops malformed rows silently."""
    if not isinstance(raw, list):
        return []
    out: list[WordPressMappedPage] = []
    for item in raw[: max(0, int(max_items))]:
        if not isinstance(item, dict):
            continue
        try:
            title = str(item.get("title") or item.get("post_title") or "").strip()[:500]
            post_url = _normalize_post_url(
                str(item.get("post_url") or item.get("url") or item.get("link") or "").strip(),
                site_base=site_base,
            )
            if not title or not post_url:
                continue
            parsed = urlparse(post_url)
            if parsed.scheme not in ("http", "https") or not parsed.netloc:
                continue
            image = (
                str(
                    item.get("featured_image_url")
                    or item.get("image_url")
                    or item.get("image")
                    or ""
                )
                .strip()[:4000]
            )
            post_id = str(item.get("post_id") or item.get("id") or "").strip()[:64]
            out.append(
                WordPressMappedPage(
                    title=title,
                    post_url=post_url[:2048],
                    featured_image_url=image if is_valid_page_image_url(image) else "",
                    post_id=post_id,
                )
            )
        except Exception:
            log.debug("Skipping malformed mapped WordPress page row", exc_info=True)
            continue
    return out


def _site_base(proj: dict[str, Any]) -> str:
    return (proj.get("wp_site_url") or proj.get("website_url") or "").strip().rstrip("/")


def _norm_words(text: str) -> set[str]:
    return {w.lower() for w in re.split(r"[^\w']+", text or "") if len(w) > 2}


def _catalog_fallback_pages(
    *,
    proj: dict[str, Any],
    title: str,
    keywords: list[str],
    focus_keyphrase: str,
    max_pages: int,
) -> list[WordPressMappedPage]:
    """Score synced site-map rows by keyword overlap (same pattern as Shopify catalog)."""
    try:
        from app.legacy.storage import get_legacy_storage_module

        st = get_legacy_storage_module()
        pid = (proj.get("id") or "").strip()
        if not pid:
            return []
        rows = st.load_site_map_for_project(pid, limit=5000)
    except Exception:
        log.debug("WordPress site-map load failed", exc_info=True)
        return []

    query = _norm_words(title) | _norm_words(focus_keyphrase)
    for k in keywords or []:
        query |= _norm_words(str(k))

    if not query:
        return []

    scored: list[tuple[int, dict[str, Any]]] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        post_url = (row.get("post_url") or "").strip()
        post_title = (row.get("post_title") or "").strip()
        if not post_url or not post_title:
            continue
        hay = f"{post_title} {row.get('focus_keyphrase') or ''}"
        words = _norm_words(hay)
        score = len(query & words)
        if score <= 0:
            continue
        scored.append((score, row))

    scored.sort(key=lambda x: x[0], reverse=True)
    out: list[WordPressMappedPage] = []
    for _score, row in scored[: max(0, int(max_pages))]:
        image = str(row.get("featured_image_url") or "").strip()
        out.append(
            WordPressMappedPage(
                title=str(row.get("post_title") or "").strip(),
                post_url=str(row.get("post_url") or "").strip(),
                featured_image_url=image if is_valid_page_image_url(image) else "",
                post_id=str(row.get("post_id") or "").strip(),
            )
        )
    return out


def format_wordpress_page_context(pages: list[WordPressMappedPage]) -> str:
    if not pages:
        return ""
    lines = [
        "WordPress internal page context (use naturally; do not invent URLs):",
        "Link to these existing posts using markdown with the exact URLs given.",
        "Include at least one natural inline link in the article body.",
    ]
    for p in pages:
        lines.append(f"- {p.title} — URL: {p.post_url}")
        if p.featured_image_url:
            lines.append(f"  Featured image (reference only): {p.featured_image_url}")
    return "\n".join(lines).strip()


def resolve_wordpress_generation_context(
    *,
    proj: dict[str, Any],
    title: str,
    keywords: list[str],
    focus_keyphrase: str,
    mapped_pages_raw: Any | None = None,
    max_pages: int = 3,
) -> WordPressGenerationContext:
    """
    Build prompt context and optional reference image for WordPress projects only.

    Explicit ``mapped_pages_raw`` (including ``[]``) skips site-map auto-select.
    """
    empty = WordPressGenerationContext(product_context=None, mapped_pages=[], reference_image_url=None)
    if not is_wordpress_project(proj):
        return empty

    site_base = _site_base(proj)
    explicit_request = mapped_pages_raw is not None
    pages = (
        normalize_mapped_pages(mapped_pages_raw, site_base=site_base, max_items=max_pages)
        if explicit_request
        else []
    )

    if not pages:
        if explicit_request:
            log.debug(
                "WordPress explicit page mapping empty; skipping site-map fallback (title=%r)",
                (title or "")[:80],
            )
            return empty
        if not wp_internal_link_aware_enabled(proj):
            return empty
        try:
            pages = _catalog_fallback_pages(
                proj=proj,
                title=title,
                keywords=keywords,
                focus_keyphrase=focus_keyphrase,
                max_pages=max_pages,
            )
        except Exception:
            log.debug("WordPress site-map fallback failed", exc_info=True)
            pages = []

    if not pages:
        return empty

    try:
        ctx = format_wordpress_page_context(pages)
    except Exception:
        log.exception("WordPress page context formatting failed")
        ctx = ""

    reference: str | None = None
    for p in pages:
        if is_valid_page_image_url(p.featured_image_url):
            reference = p.featured_image_url
            break

    return WordPressGenerationContext(
        product_context=ctx or None,
        mapped_pages=pages,
        reference_image_url=reference,
    )


def _body_contains_page_reference(body: str, page: WordPressMappedPage) -> bool:
    text = body or ""
    if not text.strip():
        return False
    url = (page.post_url or "").strip()
    path = urlparse(url).path if url else ""
    patterns = (url, path, page.title)
    lower = text.lower()
    return any((p or "").lower() in lower for p in patterns if p)


def build_page_showcase_html(page: WordPressMappedPage) -> str:
    img = (
        f'<img src="{page.featured_image_url}" alt="{_html_escape(page.title)}" '
        f'style="max-width:100%;height:auto;border-radius:8px;display:block;margin:0 auto 12px;" loading="lazy" />'
        if is_valid_page_image_url(page.featured_image_url)
        else ""
    )
    return (
        '\n\n<div class="riviso-wp-page-showcase" style="margin:2rem 0;padding:1.25rem;'
        'border:1px solid #e5e5e5;border-radius:12px;background:#fafafa;text-align:center;">\n'
        f"{img}"
        f'<p style="margin:0 0 0.75rem;font-size:1.05rem;font-weight:600;">{_html_escape(page.title)}</p>\n'
        f'<p style="margin:0;"><a href="{_html_escape(page.post_url)}" '
        f'style="display:inline-block;padding:0.6rem 1.25rem;background:#111;color:#fff;'
        f'text-decoration:none;border-radius:6px;font-weight:600;">Read more</a></p>\n'
        "</div>\n"
    )


def _html_escape(s: str) -> str:
    return (
        (s or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def ensure_wordpress_page_injection(
    article_body: str,
    pages: list[WordPressMappedPage],
) -> str:
    """Ensure at least one internal link exists; append HTML showcase card if missing."""
    body = (article_body or "").strip()
    if not pages:
        return body
    primary = pages[0]
    try:
        if _body_contains_page_reference(body, primary):
            return body
        for p in pages[1:]:
            if _body_contains_page_reference(body, p):
                return body
        return f"{body}{build_page_showcase_html(primary)}"
    except Exception:
        log.exception("WordPress page injection failed; returning original body")
        return body


def serialize_mapped_pages_for_storage(pages: list[WordPressMappedPage]) -> list[dict[str, str]]:
    return [p.as_dict() for p in pages if p.title and p.post_url]
