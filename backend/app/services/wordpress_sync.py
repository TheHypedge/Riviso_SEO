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


# =============================================================================
# WordPress Sync & Self-Healing  (Riviso = Source of Truth)
# =============================================================================
# The functions below COMPARE Riviso state against live WordPress and REPAIR
# any discrepancies by pushing Riviso values to WP.
# =============================================================================

import hashlib
from datetime import timezone

from app.services.wordpress_publish import (
    publish_post_to_wordpress,
    update_post_on_wordpress,
)
from app.services.wordpress_client import resolve_featured_media_id

# Sync status string constants
SYNC_SYNCED = "synced"
SYNC_MISSING = "missing"
SYNC_DRAFT = "draft"
SYNC_TRASHED = "trashed"
SYNC_URL_MISMATCH = "url_mismatch"
SYNC_METADATA_MISMATCH = "metadata_mismatch"
SYNC_CONTENT_MISMATCH = "content_mismatch"
SYNC_IMAGE_MISSING = "image_missing"
SYNC_CATEGORY_MISMATCH = "category_mismatch"
SYNC_NEEDS_ATTENTION = "needs_attention"
SYNC_UNKNOWN = "unknown"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _content_hash(text: str) -> str:
    normalized = re.sub(r"\s+", " ", (text or "").lower()).strip()[:3000]
    return hashlib.md5(normalized.encode("utf-8", errors="replace")).hexdigest()


def _word_count(text: str) -> int:
    return len(re.findall(r"\w+", text or ""))


def _slug_from_url(url: str) -> str:
    path = urlparse(url or "").path.rstrip("/")
    parts = [p for p in path.split("/") if p]
    return parts[-1] if parts else ""


def _markdown_to_plain(md: str) -> str:
    text = re.sub(r"^#{1,6}\s+", "", md or "", flags=re.MULTILINE)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", text)
    text = re.sub(r"`[^`]+`", "", text)
    text = re.sub(r"^[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\d+\.\s+", "", text, flags=re.MULTILINE)
    return text


def _html_to_plain(html: str) -> str:
    soup = BeautifulSoup(html or "", "lxml")
    return soup.get_text(" ")


def _compare_content(riviso_markdown: str, wp_html: str) -> bool:
    """Return True when content is substantially the same."""
    riv = re.sub(r"\s+", " ", _markdown_to_plain(riviso_markdown)).strip()
    wp = re.sub(r"\s+", " ", _html_to_plain(wp_html)).strip()
    if not riv and not wp:
        return True
    if not riv or not wp:
        return False
    riv_wc = _word_count(riv)
    wp_wc = _word_count(wp)
    if riv_wc > 30:
        diff_ratio = abs(riv_wc - wp_wc) / riv_wc
        if diff_ratio > 0.20:
            return False
    return _content_hash(riv) == _content_hash(wp)


def _compare_categories(riviso_cat_ids: str, wp_categories: list) -> bool:
    riv_ids = {int(x) for x in (riviso_cat_ids or "").split(",") if x.strip().isdigit()}
    wp_ids = {int(c) for c in (wp_categories or []) if isinstance(c, (int, float))}
    if not riv_ids:
        return True  # no preference set — treat as synced
    return riv_ids == wp_ids


def _get_wp_meta_value(wp_post: dict, *keys: str) -> str:
    meta = wp_post.get("meta") or {}
    if not isinstance(meta, dict):
        return ""
    for k in keys:
        v = meta.get(k)
        if v and isinstance(v, str) and v.strip():
            return v.strip()
    # Also check yoast_head_json as fallback
    yhj = wp_post.get("yoast_head_json")
    if isinstance(yhj, dict):
        for jk in ("title", "description"):
            v = yhj.get(jk)
            if v and isinstance(v, str) and v.strip():
                return _strip_html(v.strip())
    return ""


async def _fetch_wp_post_for_compare(wp: WordpressClient, article: dict) -> dict | None:
    """Fetch WP post, trying post ID → slug → title search."""
    import httpx as _httpx
    rest_base = normalize_rest_base(article.get("wp_rest_base"))
    wp_post_id = resolve_wp_post_id(article)

    # 1. By post ID (context=edit returns draft/trash too)
    if wp_post_id:
        try:
            data = await wp.get_json(
                f"/wp-json/wp/v2/{rest_base}/{wp_post_id}?context=edit",
                timeout=20.0,
            )
            if isinstance(data, dict) and data.get("id"):
                return data
        except _httpx.HTTPStatusError as e:
            if e.response.status_code not in (404, 401, 403):
                raise
        except Exception:
            pass

    # 2. By slug derived from stored wp_link
    stored_link = (article.get("wp_link") or "").strip()
    slug = _slug_from_url(stored_link)
    if not slug:
        title = (article.get("title") or "").strip()
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")

    if slug:
        try:
            results = await wp.get_json(
                f"/wp-json/wp/v2/{rest_base}?slug={slug}&context=edit&status=any",
                timeout=20.0,
            )
            if isinstance(results, list) and results:
                return results[0]
        except Exception:
            pass

    # 3. By title search
    title = (article.get("title") or "").strip()
    if title:
        try:
            results = await wp.get_json(
                f"/wp-json/wp/v2/{rest_base}?search={title[:80]}&context=edit&per_page=10",
                timeout=20.0,
            )
            if isinstance(results, list):
                for r in results:
                    if not isinstance(r, dict):
                        continue
                    raw = r.get("title") or {}
                    rn = (
                        (raw.get("rendered") or raw.get("raw") or "")
                        if isinstance(raw, dict)
                        else str(raw)
                    ).strip()
                    if rn.lower() == title.lower():
                        return r
        except Exception:
            pass

    return None


def _append_history(article: dict, updates: dict, action: str, detail: str) -> None:
    history = list(article.get("sync_history") or [])
    history.append({"ts": _now_iso(), "action": action, "detail": detail})
    updates["sync_history"] = history[-20:]


async def check_article_sync(wp: WordpressClient, article: dict) -> dict:
    """
    Compare a published Riviso article against its live WordPress post.

    Returns a dict of fields to patch onto the article (sync_status, etc.).
    Riviso is always the Source of Truth — this never updates Riviso content.
    """
    now = _now_iso()
    issues: list[str] = []

    wp_post = await _fetch_wp_post_for_compare(wp, article)

    if wp_post is None:
        updates = {
            "sync_status": SYNC_MISSING,
            "sync_issue_type": "missing",
            "last_synced_at": now,
        }
        _append_history(article, updates, "sync", "Article not found in WordPress")
        return updates

    wp_status = (wp_post.get("status") or "").lower()

    if wp_status == "trash":
        updates = {
            "sync_status": SYNC_TRASHED,
            "sync_issue_type": "trashed",
            "last_synced_at": now,
        }
        _append_history(article, updates, "sync", "Article is in WordPress trash")
        return updates

    if wp_status == "draft":
        updates = {
            "sync_status": SYNC_DRAFT,
            "sync_issue_type": "draft",
            "last_synced_at": now,
        }
        _append_history(article, updates, "sync", "Article is a draft in WordPress")
        return updates

    # --- URL / slug check ---
    wp_live_link = (wp_post.get("link") or "").strip()
    stored_link = (article.get("wp_link") or "").strip()
    if stored_link and wp_live_link:
        if stored_link.rstrip("/") != wp_live_link.rstrip("/"):
            issues.append(SYNC_URL_MISMATCH)

    # --- Content check ---
    riviso_body = (article.get("article") or "").strip()
    wp_raw = wp_post.get("content") or {}
    wp_content = (
        (wp_raw.get("raw") or wp_raw.get("rendered") or "")
        if isinstance(wp_raw, dict)
        else str(wp_raw or "")
    ).strip()
    if riviso_body and not _compare_content(riviso_body, wp_content):
        issues.append(SYNC_CONTENT_MISMATCH)

    # --- Featured image check ---
    wp_featured_media = wp_post.get("featured_media") or 0
    riviso_has_image = bool((article.get("image_url") or "").strip())
    if riviso_has_image and not wp_featured_media:
        issues.append(SYNC_IMAGE_MISSING)

    # --- Category check ---
    wp_categories = wp_post.get("categories") or []
    riviso_cat_ids = (article.get("wp_category_ids") or "").strip()
    if not _compare_categories(riviso_cat_ids, wp_categories):
        issues.append(SYNC_CATEGORY_MISMATCH)

    # --- SEO metadata check ---
    riviso_meta_title = (article.get("meta_title") or "").strip()
    riviso_meta_desc = (article.get("meta_description") or "").strip()
    wp_meta_title = _get_wp_meta_value(
        wp_post, "_yoast_wpseo_title", "rank_math_title", "_aioseo_title"
    )
    wp_meta_desc = _get_wp_meta_value(
        wp_post, "_yoast_wpseo_metadesc", "rank_math_description", "_aioseo_description"
    )
    meta_title_ok = (riviso_meta_title.lower() == wp_meta_title.lower()) or (not riviso_meta_title and not wp_meta_title)
    meta_desc_ok = (riviso_meta_desc.lower() == wp_meta_desc.lower()) or (not riviso_meta_desc and not wp_meta_desc)
    if riviso_meta_title and not (meta_title_ok and meta_desc_ok):
        issues.append(SYNC_METADATA_MISMATCH)

    # --- Determine overall status ---
    if not issues:
        riv_plain = re.sub(r"\s+", " ", _markdown_to_plain(riviso_body)).strip()
        updates = {
            "sync_status": SYNC_SYNCED,
            "sync_issue_type": "",
            "last_synced_at": now,
            "last_successful_sync": now,
            "last_verified_hash": _content_hash(riv_plain),
        }
        _append_history(article, updates, "sync", "All fields synced")
        return updates

    status = issues[0] if len(issues) == 1 else SYNC_NEEDS_ATTENTION
    issue_type = ",".join(issues)
    updates = {
        "sync_status": status,
        "sync_issue_type": issue_type,
        "last_synced_at": now,
    }
    _append_history(article, updates, "sync", f"Issues: {issue_type}")
    return updates


def _build_wp_meta_payload(article: dict) -> dict:
    meta: dict = {}
    meta_title = (article.get("meta_title") or "").strip()
    meta_desc = (article.get("meta_description") or "").strip()
    canonical = (article.get("wp_link") or "").strip()
    if meta_title:
        meta.update({
            "_yoast_wpseo_title": meta_title,
            "rank_math_title": meta_title,
            "_aioseo_title": meta_title,
        })
    if meta_desc:
        meta.update({
            "_yoast_wpseo_metadesc": meta_desc,
            "rank_math_description": meta_desc,
            "_aioseo_description": meta_desc,
        })
    if canonical:
        meta["_yoast_wpseo_canonical"] = canonical
    return meta


def _article_to_html(article: dict) -> str:
    body_md = (article.get("article") or "").strip()
    if not body_md:
        return ""
    try:
        import markdown as _md
        return _md.markdown(
            body_md,
            extensions=["tables", "fenced_code", "nl2br"],
        )
    except Exception:
        return body_md


async def repair_article_issue(wp: WordpressClient, article: dict, issue: str) -> dict:
    """
    Repair a single detected sync issue on a WordPress post.

    Returns {ok, operation, error, new_wp_post_id, new_wp_link}.
    """
    rest_base = normalize_rest_base(article.get("wp_rest_base"))
    wp_post_id = resolve_wp_post_id(article)

    if issue == SYNC_MISSING:
        # Re-publish the article from scratch
        meta = _build_wp_meta_payload(article)
        featured_media_id = await resolve_featured_media_id(wp, article, timeout=60.0)
        cat_ids = [int(x) for x in (article.get("wp_category_ids") or "").split(",") if x.strip().isdigit()]
        payload: dict = {
            "title": (article.get("title") or "").strip(),
            "content": _article_to_html(article),
            "status": "publish",
        }
        if meta:
            payload["meta"] = meta
        if cat_ids:
            payload["categories"] = cat_ids
        if featured_media_id:
            payload["featured_media"] = featured_media_id
        created = await publish_post_to_wordpress(wp, post_type=rest_base, payload=payload)
        new_id = created.get("id")
        new_link = (created.get("link") or "").strip()
        return {
            "ok": True,
            "operation": "republished",
            "new_wp_post_id": int(new_id) if new_id else None,
            "new_wp_link": new_link or None,
        }

    if not wp_post_id:
        return {"ok": False, "operation": issue, "error": "No wp_post_id stored"}

    if issue in (SYNC_DRAFT, SYNC_TRASHED):
        await update_post_on_wordpress(
            wp, post_type=rest_base, wp_post_id=wp_post_id, payload={"status": "publish"}
        )
        return {"ok": True, "operation": "published"}

    if issue == SYNC_URL_MISMATCH:
        correct_slug = _slug_from_url((article.get("wp_link") or "").strip())
        if not correct_slug:
            return {"ok": False, "operation": "fix_slug", "error": "Cannot derive slug from stored URL"}
        await update_post_on_wordpress(
            wp, post_type=rest_base, wp_post_id=wp_post_id, payload={"slug": correct_slug}
        )
        return {"ok": True, "operation": "slug_restored"}

    if issue == SYNC_METADATA_MISMATCH:
        meta = _build_wp_meta_payload(article)
        if not meta:
            return {"ok": True, "operation": "sync_metadata", "error": "No metadata to push"}
        await update_post_on_wordpress(
            wp, post_type=rest_base, wp_post_id=wp_post_id, payload={"meta": meta}
        )
        return {"ok": True, "operation": "metadata_synced"}

    if issue == SYNC_CONTENT_MISMATCH:
        await update_post_on_wordpress(
            wp,
            post_type=rest_base,
            wp_post_id=wp_post_id,
            payload={"title": (article.get("title") or "").strip(), "content": _article_to_html(article)},
        )
        return {"ok": True, "operation": "content_restored"}

    if issue == SYNC_IMAGE_MISSING:
        media_id = await resolve_featured_media_id(wp, article, timeout=60.0)
        if not media_id:
            return {"ok": False, "operation": "upload_image", "error": "No featured image available"}
        await update_post_on_wordpress(
            wp, post_type=rest_base, wp_post_id=wp_post_id, payload={"featured_media": media_id}
        )
        return {"ok": True, "operation": "image_uploaded"}

    if issue == SYNC_CATEGORY_MISMATCH:
        cat_ids = [int(x) for x in (article.get("wp_category_ids") or "").split(",") if x.strip().isdigit()]
        if not cat_ids:
            return {"ok": True, "operation": "sync_categories", "error": "No categories set"}
        await update_post_on_wordpress(
            wp, post_type=rest_base, wp_post_id=wp_post_id, payload={"categories": cat_ids}
        )
        return {"ok": True, "operation": "categories_synced"}

    return {"ok": False, "operation": issue, "error": f"Unknown issue: {issue}"}
