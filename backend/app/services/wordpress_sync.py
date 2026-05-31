"""Pull WordPress post state into Riviso article rows (URL, title, body, SEO meta)."""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any
from urllib.parse import parse_qs, urlparse

from bs4 import BeautifulSoup

from app.services.wordpress_client import WordpressClient

log = logging.getLogger(__name__)

_WP_POST_FIELDS = "id,link,status,title,content,modified,meta,yoast_head_json,slug"


def normalize_rest_base(rest_base: str | None) -> str:
    base = (rest_base or "posts").strip().lower() or "posts"
    return "posts" if base in {"post", "posts"} else base


def resolve_wp_post_id(article: dict) -> int | None:
    raw = article.get("wp_post_id")
    if raw is not None and raw != "":
        try:
            pid = int(raw)
            if pid > 0:
                return pid
        except (TypeError, ValueError):
            s = str(raw).strip()
            if s.isdigit() and int(s) > 0:
                return int(s)
    link = (article.get("wp_link") or "").strip()
    if not link:
        return None
    try:
        qs = parse_qs(urlparse(link).query)
        raw_p = (qs.get("p") or [None])[0]
        if raw_p is not None and str(raw_p).strip().isdigit():
            return int(str(raw_p).strip())
    except Exception:
        pass
    return None


def html_to_markdown(html: str) -> str:
    raw = (html or "").strip()
    if not raw:
        return ""
    try:
        import html2text

        conv = html2text.HTML2Text()
        conv.body_width = 0
        conv.ignore_images = False
        conv.ignore_emphasis = False
        conv.single_line_break = False
        return conv.handle(raw).strip()
    except Exception:
        log.debug("html2text unavailable; falling back to plain text extraction", exc_info=True)
        soup = BeautifulSoup(raw, "lxml")
        for tag in soup(["script", "style", "noscript"]):
            tag.decompose()
        return soup.get_text("\n\n").strip()


def _strip_html(text: str) -> str:
    s = (text or "").strip()
    if not s or "<" not in s:
        return s
    return BeautifulSoup(s, "lxml").get_text().strip()


def _wp_field_raw(block: object) -> str:
    if isinstance(block, dict):
        raw = (block.get("raw") or block.get("rendered") or "").strip()
        return _strip_html(raw) if raw else ""
    return _strip_html(str(block or ""))


def _extract_yoast(post: dict) -> dict[str, str]:
    meta = post.get("meta") if isinstance(post.get("meta"), dict) else {}
    out = {
        "meta_title": str(meta.get("_yoast_wpseo_title") or "").strip(),
        "meta_description": str(meta.get("_yoast_wpseo_metadesc") or "").strip(),
        "focus_keyphrase": str(meta.get("_yoast_wpseo_focuskw") or "").strip(),
    }
    yhj = post.get("yoast_head_json")
    if isinstance(yhj, dict):
        if not out["meta_title"]:
            out["meta_title"] = _strip_html(str(yhj.get("title") or ""))
        if not out["meta_description"]:
            out["meta_description"] = _strip_html(str(yhj.get("description") or ""))
    return out


def _riviso_status_from_wp(wp_status: str) -> str:
    s = (wp_status or "").strip().lower()
    if s == "publish":
        return "published"
    return "draft"


def _normalize_wp_modified(modified: object) -> str:
    s = str(modified or "").strip()
    if not s:
        return ""
    s = s.replace("T", " ").replace("Z", "")
    if re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", s):
        return s[:19]
    return s[:64]


async def fetch_wordpress_post(
    wp: WordpressClient,
    *,
    rest_base: str,
    post_id: int,
) -> dict[str, Any]:
    """Fetch one post from WP REST (``context=edit`` for raw title/content)."""
    base = normalize_rest_base(rest_base)
    pid = int(post_id)
    path = f"/wp-json/wp/v2/{base}/{pid}?context=edit&_fields={_WP_POST_FIELDS}"
    try:
        data = await wp.get_json(path, timeout=45.0)
    except Exception as first_err:
        if base != "posts":
            try:
                data = await wp.get_json(
                    f"/wp-json/wp/v2/posts/{pid}?context=edit&_fields={_WP_POST_FIELDS}",
                    timeout=45.0,
                )
            except Exception:
                raise first_err
        else:
            raise
    if not isinstance(data, dict):
        raise RuntimeError("WordPress returned an unexpected post payload")
    return data


def build_article_updates_from_wp_post(
    *,
    article: dict,
    post: dict,
    rest_base: str,
) -> tuple[dict[str, Any], list[str]]:
    """Map a WP REST post object to Riviso ``update_article_fields`` keys."""
    wp_status = (post.get("status") or "").strip().lower() or "draft"
    new_title = _wp_field_raw(post.get("title"))
    content_html = ""
    content_block = post.get("content")
    if isinstance(content_block, dict):
        content_html = (content_block.get("raw") or content_block.get("rendered") or "").strip()
    new_body = html_to_markdown(content_html)
    yoast = _extract_yoast(post)
    new_link = (post.get("link") or "").strip()
    wp_modified = _normalize_wp_modified(post.get("modified"))
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    updates: dict[str, Any] = {
        "wp_post_id": int(post.get("id") or resolve_wp_post_id(article) or 0) or article.get("wp_post_id"),
        "wp_link": new_link[:2048],
        "wp_rest_base": normalize_rest_base(rest_base),
        "wp_last_wp_status": wp_status[:32],
        "wp_modified_at": wp_modified,
        "wp_synced_at": now,
        "status": _riviso_status_from_wp(wp_status),
    }
    if wp_status == "publish":
        updates["posted_at"] = now

    if new_title:
        updates["title"] = new_title[:500]
    if new_body:
        updates["article"] = new_body
    if yoast["meta_title"]:
        updates["meta_title"] = yoast["meta_title"][:400]
    if yoast["meta_description"]:
        updates["meta_description"] = yoast["meta_description"][:600]
    if yoast["focus_keyphrase"]:
        updates["focus_keyphrase"] = yoast["focus_keyphrase"][:500]

    changes: list[str] = []
    if new_title and new_title != (article.get("title") or "").strip():
        changes.append("title")
    if new_body and new_body != (article.get("article") or "").strip():
        changes.append("article")
    if new_link and new_link != (article.get("wp_link") or "").strip():
        changes.append("wp_link")
    if wp_status != (article.get("wp_last_wp_status") or "").strip().lower():
        changes.append("wp_status")
    if yoast["meta_title"] and yoast["meta_title"] != (article.get("meta_title") or "").strip():
        changes.append("meta_title")
    if yoast["meta_description"] and yoast["meta_description"] != (article.get("meta_description") or "").strip():
        changes.append("meta_description")
    if yoast["focus_keyphrase"] and yoast["focus_keyphrase"] != (article.get("focus_keyphrase") or "").strip():
        changes.append("focus_keyphrase")
    if not changes:
        changes.append("checked")

    return updates, changes


async def sync_article_from_wordpress(
    *,
    wp: WordpressClient,
    article: dict,
    rest_base: str | None = None,
) -> dict[str, Any]:
    """Fetch WP post and return persistence updates + change summary."""
    pid = resolve_wp_post_id(article)
    if not pid:
        raise ValueError("Article is not linked to a WordPress post (missing wp_post_id / wp_link).")
    base = normalize_rest_base(rest_base or article.get("wp_rest_base") or "posts")
    post = await fetch_wordpress_post(wp, rest_base=base, post_id=pid)
    updates, changes = build_article_updates_from_wp_post(article=article, post=post, rest_base=base)
    return {
        "updates": updates,
        "changes": changes,
        "wp_post_id": pid,
        "wp_link": updates.get("wp_link"),
        "wp_status": updates.get("wp_last_wp_status"),
        "wp_modified_at": updates.get("wp_modified_at"),
        "wp_synced_at": updates.get("wp_synced_at"),
    }
