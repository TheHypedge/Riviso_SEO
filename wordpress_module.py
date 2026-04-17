import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

import requests


@dataclass(frozen=True)
class WordPressConfig:
    site_url: str
    username: str
    application_password: str


def _normalize_site_url(site_url: str) -> str:
    s = (site_url or "").strip()
    if not s:
        raise ValueError("Missing WordPress site URL.")
    if not re.match(r"^https?://", s, re.IGNORECASE):
        s = "https://" + s
    return s.rstrip("/")


def wp_api_url(site_url: str, path: str) -> str:
    base = _normalize_site_url(site_url) + "/"
    return urljoin(base, path.lstrip("/"))


def markdown_to_wp_html(markdown_text: str, *, strip_content_h1: bool = True) -> str:
    """
    Convert Markdown-ish article text into HTML suitable for WP `content`.
    By default strips H1 from the body: themes use the post title as the single page H1,
    so any `#` / <h1> in content is downgraded to H2.
    """
    raw = (markdown_text or "").strip()
    if not raw:
        return ""

    # Prefer python-markdown if available, otherwise fall back to a tiny formatter.
    try:
        import markdown  # type: ignore

        html = markdown.markdown(
            raw,
            extensions=["extra", "sane_lists", "toc"],
            output_format="html5",
        )
    except Exception:
        html = _fallback_text_to_html(raw)

    if strip_content_h1:
        html = _downgrade_all_h1_to_h2(html)
    return html


def _fallback_text_to_html(text: str) -> str:
    """
    Minimal conversion if Markdown lib isn't available:
    - Lines starting with # become headings
    - Lines starting with -, * become <ul><li>
    - Blank lines separate paragraphs
    """
    lines = [ln.rstrip() for ln in (text or "").splitlines()]
    out: list[str] = []
    in_ul = False

    def close_ul():
        nonlocal in_ul
        if in_ul:
            out.append("</ul>")
            in_ul = False

    for ln in lines:
        if not ln.strip():
            close_ul()
            continue

        m = re.match(r"^(#{1,6})\s+(.*)$", ln.strip())
        if m:
            close_ul()
            level = len(m.group(1))
            content = _escape_html(m.group(2).strip())
            # No H1 in body — WordPress theme outputs the post title as H1
            if level == 1:
                level = 2
            out.append(f"<h{level}>{content}</h{level}>")
            continue

        m = re.match(r"^([-*])\s+(.*)$", ln.strip())
        if m:
            if not in_ul:
                out.append("<ul>")
                in_ul = True
            out.append(f"<li>{_escape_html(m.group(2).strip())}</li>")
            continue

        close_ul()
        out.append(f"<p>{_escape_html(ln.strip())}</p>")

    close_ul()
    return "\n".join(out)


def _escape_html(s: str) -> str:
    return (
        (s or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def _downgrade_all_h1_to_h2(html: str) -> str:
    """
    WP themes render the post title as the page H1; body content must not add another H1.
    Converts every <h1>...</h1> to <h2>...</h2> (preserves attributes on the tag).
    """
    return re.sub(
        r"<h1(\s[^>]*)?>(.*?)</h1>",
        lambda m: f"<h2{m.group(1) or ''}>{m.group(2)}</h2>",
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )


def wp_request(
    cfg: WordPressConfig,
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json: dict[str, Any] | None = None,
    timeout_s: int = 30,
) -> requests.Response:
    url = wp_api_url(cfg.site_url, path)
    resp = requests.request(
        method=method.upper().strip(),
        url=url,
        params=params,
        json=json,
        auth=(cfg.username, cfg.application_password),
        timeout=timeout_s,
        headers={"Accept": "application/json"},
    )
    return resp


# Routes under /wp/v2/{name} that are not content collections.
_WP_V2_INDEX_BLACKLIST = frozenset(
    {
        "media",
        "comments",
        "users",
        "search",
        "blocks",
        "templates",
        "template-parts",
        "navigation",
        "settings",
        "themes",
        "plugins",
        "statuses",
        "taxonomies",
        "types",
        "categories",
        "tags",
        "menus",
        "sidebar",
        "widgets",
        "block-directory",
        "pattern-directory",
        "block-patterns",
        "global-styles",
        "font-families",
        "font-faces",
        "menu-items",
        "menu-locations",
        "wp_pattern_category",
        "block-renderer",
        "oembed",
        "revisions",
        "autosaves",
    }
)


def _route_allows_post_method(route_info: dict[str, Any]) -> bool:
    m = route_info.get("methods")
    if isinstance(m, list):
        return "POST" in m
    if isinstance(m, dict):
        return "POST" in m
    return False


def _pretty_label_from_rest_base(rest_base: str) -> str:
    s = (rest_base or "").replace("_", "-").replace("-", " ").strip()
    return s.title() if s else rest_base


def fetch_rest_collections_from_index(cfg: WordPressConfig, *, timeout_s: int = 20) -> list[dict[str, str]]:
    """
    Discover /wp/v2/{collection} routes that accept POST from GET /wp-json/.
    Surfaces CPTs that may not appear in /wp/v2/types (e.g. inconsistent show_in_rest).
    """
    r = wp_request(cfg, "GET", "/wp-json/", timeout_s=timeout_s)
    if not r.ok:
        return []
    data = r.json()
    routes = data.get("routes") if isinstance(data, dict) else None
    if not isinstance(routes, dict):
        return []
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for path, info in routes.items():
        if not isinstance(path, str) or not isinstance(info, dict):
            continue
        m = re.match(r"^/wp/v2/([^/]+)$", path)
        if not m:
            continue
        seg = m.group(1).lower()
        if seg in _WP_V2_INDEX_BLACKLIST:
            continue
        if not _route_allows_post_method(info):
            continue
        if seg in seen:
            continue
        seen.add(seg)
        out.append(
            {
                "slug": seg,
                "name": _pretty_label_from_rest_base(seg),
                "rest_base": seg,
            }
        )
    return out


def _fetch_types_from_types_endpoint(cfg: WordPressConfig, *, timeout_s: int) -> list[dict[str, str]]:
    r = wp_request(cfg, "GET", "/wp-json/wp/v2/types", timeout_s=timeout_s)
    if not r.ok:
        raise ValueError(
            f"Could not load post types (HTTP {r.status_code}). Check the site URL and credentials."
        )
    data = r.json()
    if not isinstance(data, dict):
        return []

    skip_slugs = {
        "attachment",
        "nav_menu_item",
        "wp_block",
        "wp_template",
        "wp_template_part",
        "wp_navigation",
        "wp_global_styles",
        "revision",
        "custom_css",
        "customize_changeset",
        "oembed_cache",
        "user_request",
        "wp_font_family",
        "wp_font_face",
    }
    out: list[dict[str, str]] = []
    for slug, obj in data.items():
        if not isinstance(obj, dict):
            continue
        if slug in skip_slugs:
            continue
        rest_base = (obj.get("rest_base") or "").strip()
        if not rest_base:
            continue
        name = (obj.get("name") or "").strip() or _pretty_label_from_rest_base(str(slug))
        out.append({"slug": str(slug), "name": name, "rest_base": rest_base})
    return out


def fetch_rest_post_types(cfg: WordPressConfig, *, timeout_s: int = 20) -> list[dict[str, str]]:
    """
    Content types for POST /wp/v2/{rest_base}.

    Merges GET /wp/v2/types (labels) with GET /wp-json/ (route index) so custom post types
    like `articles` appear when they expose a REST collection even if omitted from /types.
    """
    from_types: list[dict[str, str]] = []
    types_error: str | None = None
    try:
        from_types = _fetch_types_from_types_endpoint(cfg, timeout_s=timeout_s)
    except ValueError as e:
        types_error = str(e)

    from_index = fetch_rest_collections_from_index(cfg, timeout_s=timeout_s)

    by_rest_base: dict[str, dict[str, str]] = {}
    for item in from_types:
        rb = (item.get("rest_base") or "").strip()
        if rb:
            by_rest_base[rb] = dict(item)

    for item in from_index:
        rb = (item.get("rest_base") or "").strip()
        if not rb or rb in by_rest_base:
            continue
        by_rest_base[rb] = dict(item)

    out = list(by_rest_base.values())
    if not out:
        raise ValueError(
            types_error
            or "Could not discover any post types. Check the WordPress site URL and application password."
        )

    def sort_key(item: dict[str, str]) -> tuple[int, str]:
        rb = (item.get("rest_base") or "").lower()
        if rb == "posts":
            return (0, "")
        if rb == "pages":
            return (1, "")
        return (2, (item.get("name") or "").lower())

    out.sort(key=sort_key)
    return out


def ensure_tag_ids(cfg: WordPressConfig, tag_names: list[str]) -> list[int]:
    """
    Resolve tag names to IDs; create missing tags (requires permission).
    """
    out: list[int] = []
    for name in [t.strip() for t in (tag_names or []) if t and t.strip()]:
        # Search
        r = wp_request(cfg, "GET", "/wp-json/wp/v2/tags", params={"search": name, "per_page": 100})
        if r.ok:
            data = r.json() or []
            found = next((t for t in data if (t.get("name") or "").lower() == name.lower()), None)
            if found and isinstance(found.get("id"), int):
                out.append(found["id"])
                continue
        # Create
        r2 = wp_request(cfg, "POST", "/wp-json/wp/v2/tags", json={"name": name})
        if r2.ok and isinstance((r2.json() or {}).get("id"), int):
            out.append(r2.json()["id"])
            continue
        # If we can't create, just skip this tag (but don't fail the whole publish).
    return out


def upload_media(
    cfg: WordPressConfig,
    file_bytes: bytes,
    filename: str,
    *,
    mime: str = "image/png",
    timeout_s: int = 120,
) -> dict[str, Any]:
    """
    Upload a binary file to the WordPress media library via REST.
    Returns the created media object (includes id, source_url, etc.).
    """
    safe_name = (filename or "upload.png").replace("\\", "/").split("/")[-1] or "upload.png"
    url = wp_api_url(cfg.site_url, "/wp-json/wp/v2/media")
    headers = {
        "Content-Type": mime,
        "Content-Disposition": f'attachment; filename="{safe_name}"',
    }
    r = requests.post(
        url,
        data=file_bytes,
        headers=headers,
        auth=(cfg.username, cfg.application_password),
        timeout=timeout_s,
    )
    if not r.ok:
        try:
            details = r.json()
        except Exception:
            details = r.text
        raise ValueError(f"WordPress media upload failed ({r.status_code}): {details}")
    data = r.json()
    return data if isinstance(data, dict) else {}


def create_post(
    cfg: WordPressConfig,
    *,
    title: str,
    html_content: str,
    status: str = "draft",
    excerpt: str | None = None,
    tag_ids: list[int] | None = None,
    category_ids: list[int] | None = None,
    meta: dict[str, Any] | None = None,
    featured_media: int | None = None,
    rest_base: str = "posts",
) -> dict[str, Any]:
    """
    Create a post (or page/CPT item) via REST.
    `rest_base` is the collection route segment, e.g. "posts", "pages", "news" (from GET /wp/v2/types).
    Tags and default categories are only sent for the standard `posts` type to avoid REST errors on CPTs
    that do not support those taxonomies.
    """
    rb = (rest_base or "posts").strip().strip("/")
    if not re.match(r"^[a-z0-9][a-z0-9_-]*$", rb, re.IGNORECASE):
        raise ValueError(f"Invalid REST collection: {rest_base!r}")

    payload: dict[str, Any] = {
        "title": title,
        "content": html_content,
        "status": status,
    }
    if excerpt:
        payload["excerpt"] = excerpt
    if rb == "posts":
        if tag_ids:
            payload["tags"] = tag_ids
        if category_ids:
            payload["categories"] = category_ids
    if meta:
        payload["meta"] = meta
    if featured_media is not None:
        payload["featured_media"] = int(featured_media)

    path = f"/wp-json/wp/v2/{rb}"
    r = wp_request(cfg, "POST", path, json=payload)
    if not r.ok:
        try:
            details = r.json()
        except Exception:
            details = r.text
        msg = (
            f"WordPress post failed ({r.status_code}): {details}\n\n"
            "If this fails on `meta`, WordPress may not allow updating these meta keys via REST.\n"
            "For Yoast fields you typically need the meta keys registered with `show_in_rest` "
            "(or a plugin/snippet that exposes them)."
        )
        raise ValueError(msg)
    return r.json()

