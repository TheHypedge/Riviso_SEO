"""
Cluster-aware internal linking for WordPress pillar / supporting articles.

When an article was imported from a topic cluster, sibling articles that are
already live on WordPress can be linked automatically. Otherwise the editor
can map pages manually from the synced site map.
"""
from __future__ import annotations

import logging
from typing import Any

from app.services.wordpress_content_pipeline import WordPressMappedPage, is_valid_page_image_url

log = logging.getLogger(__name__)

MAX_CLUSTER_LINKS = 3


def is_article_live_on_wordpress(article: dict[str, Any]) -> bool:
    """True when the article has a public WordPress URL and publish status."""
    link = (article.get("wp_link") or "").strip()
    if not link:
        return False
    wp_status = (article.get("wp_last_wp_status") or "").strip().lower()
    riviso_status = (article.get("status") or "").strip().lower()
    if wp_status in {"publish", "published"}:
        return True
    if riviso_status == "published" and wp_status not in {"draft", "pending", "future", "trash"}:
        return True
    return False


def find_topic_cluster_for_article(
    st: Any,
    *,
    project_id: str,
    article_id: str,
) -> tuple[dict[str, Any], str, str] | None:
    """
    Locate the cluster row and this article's role.

    Returns ``(cluster_row, role, slot_id)`` where role is ``pillar`` or ``cluster``.
    """
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    if not pid or not aid:
        return None

    article: dict[str, Any] | None = None
    if hasattr(st, "get_article"):
        try:
            row = st.get_article(project_id=pid, article_id=aid)
            if isinstance(row, dict):
                article = row
        except Exception:
            log.debug("get_article failed during cluster lookup", exc_info=True)

    cluster_id = (article or {}).get("topic_cluster_id") or ""
    cluster_id = str(cluster_id).strip()
    if cluster_id and hasattr(st, "get_topic_cluster_by_id"):
        row = st.get_topic_cluster_by_id(cluster_id)
        if isinstance(row, dict) and (row.get("project_id") or "").strip() == pid:
            role = str((article or {}).get("topic_role") or "").strip().lower()
            slot_id = str((article or {}).get("topic_slot_id") or "").strip()
            if role not in {"pillar", "cluster"}:
                role, slot_id = _role_from_cluster_row(row, aid)
            return row, role, slot_id or "pillar"

    if not hasattr(st, "list_topic_clusters_for_project"):
        return None
    try:
        clusters = st.list_topic_clusters_for_project(pid, limit=200) or []
    except Exception:
        log.debug("list_topic_clusters_for_project failed", exc_info=True)
        return None

    for cluster in clusters:
        if not isinstance(cluster, dict):
            continue
        role, slot_id = _role_from_cluster_row(cluster, aid)
        if role:
            return cluster, role, slot_id
    return None


def _role_from_cluster_row(cluster: dict[str, Any], article_id: str) -> tuple[str, str]:
    pillar = cluster.get("pillar") or {}
    if isinstance(pillar, dict) and (pillar.get("imported_article_id") or "").strip() == article_id:
        return "pillar", (pillar.get("id") or "pillar").strip() or "pillar"
    for slot in cluster.get("clusters") or []:
        if not isinstance(slot, dict):
            continue
        if (slot.get("imported_article_id") or "").strip() == article_id:
            return "cluster", (slot.get("id") or "cluster").strip() or "cluster"
    return "", ""


def _load_article(st: Any, *, project_id: str, article_id: str) -> dict[str, Any] | None:
    aid = (article_id or "").strip()
    if not aid:
        return None
    try:
        row = st.get_article(project_id=project_id, article_id=aid)
        return row if isinstance(row, dict) else None
    except Exception:
        log.debug("Failed loading article %s for cluster links", aid, exc_info=True)
        return None


def _featured_image_for_url(st: Any, *, project_id: str, post_url: str) -> str:
    if not hasattr(st, "load_site_map_for_project"):
        return ""
    try:
        rows = st.load_site_map_for_project(project_id, limit=5000) or []
    except Exception:
        return ""
    target = (post_url or "").strip().rstrip("/")
    for row in rows:
        if not isinstance(row, dict):
            continue
        url = (row.get("post_url") or "").strip().rstrip("/")
        if url and url == target:
            image = str(row.get("featured_image_url") or "").strip()
            if is_valid_page_image_url(image):
                return image
    return ""


def article_to_mapped_page(
    st: Any,
    *,
    project_id: str,
    article: dict[str, Any],
) -> WordPressMappedPage | None:
    post_url = (article.get("wp_link") or "").strip()
    title = (article.get("title") or "").strip()
    if not post_url or not title:
        return None
    image = _featured_image_for_url(st, project_id=project_id, post_url=post_url)
    if not image:
        raw = (article.get("image_url") or "").strip()
        if raw.startswith("http://") or raw.startswith("https://"):
            image = raw
    post_id = str(article.get("wp_post_id") or "").strip()
    return WordPressMappedPage(
        title=title[:500],
        post_url=post_url[:2048],
        featured_image_url=image if is_valid_page_image_url(image) else "",
        post_id=post_id[:64],
    )


def build_cluster_link_context(
    st: Any,
    *,
    project_id: str,
    article_id: str,
) -> dict[str, Any] | None:
    """Structured context for the article editor (siblings, live status, auto-link readiness)."""
    found = find_topic_cluster_for_article(st, project_id=project_id, article_id=article_id)
    if not found:
        return None
    cluster, role, slot_id = found
    siblings = _cluster_sibling_rows(st, project_id=project_id, cluster=cluster, current_article_id=article_id)
    live_count = sum(1 for s in siblings if s.get("is_live"))
    return {
        "cluster_id": (cluster.get("id") or "").strip(),
        "role": role,
        "slot_id": slot_id,
        "auto_link_ready": live_count > 0,
        "live_sibling_count": live_count,
        "siblings": siblings,
    }


def _cluster_sibling_rows(
    st: Any,
    *,
    project_id: str,
    cluster: dict[str, Any],
    current_article_id: str,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    pillar = cluster.get("pillar") or {}
    if isinstance(pillar, dict):
        out.append(_sibling_row(st, project_id=project_id, slot=pillar, role="pillar"))
    for slot in cluster.get("clusters") or []:
        if not isinstance(slot, dict):
            continue
        out.append(_sibling_row(st, project_id=project_id, slot=slot, role="cluster"))
    _ = current_article_id
    return out


def _sibling_row(
    st: Any,
    *,
    project_id: str,
    slot: dict[str, Any],
    role: str,
) -> dict[str, Any]:
    aid = (slot.get("imported_article_id") or "").strip()
    title = (slot.get("title") or "").strip()
    post_url = ""
    is_live = False
    if aid:
        article = _load_article(st, project_id=project_id, article_id=aid)
        if article:
            title = (article.get("title") or title).strip()
            post_url = (article.get("wp_link") or "").strip()
            is_live = is_article_live_on_wordpress(article)
    return {
        "slot_id": (slot.get("id") or role).strip() or role,
        "role": role,
        "title": title,
        "article_id": aid or None,
        "post_url": post_url or None,
        "is_live": is_live,
    }


def resolve_cluster_mapped_pages(
    st: Any,
    *,
    project_id: str,
    article_row: dict[str, Any],
    max_pages: int = MAX_CLUSTER_LINKS,
) -> list[WordPressMappedPage]:
    """
    Return live sibling/pillar pages to weave into generated content.

    Pillar articles link to live supporting cluster articles; cluster articles
    link to the live pillar and other live siblings.
    """
    aid = (article_row.get("id") or "").strip()
    if not aid:
        return []
    found = find_topic_cluster_for_article(st, project_id=project_id, article_id=aid)
    if not found:
        return []
    cluster, role, _slot_id = found
    targets: list[dict[str, Any]] = []
    pillar = cluster.get("pillar") or {}
    clusters = [c for c in (cluster.get("clusters") or []) if isinstance(c, dict)]

    if role == "pillar":
        targets = list(clusters)
    else:
        if isinstance(pillar, dict):
            targets.append(pillar)
        for slot in clusters:
            if (slot.get("imported_article_id") or "").strip() != aid:
                targets.append(slot)

    pages: list[WordPressMappedPage] = []
    for slot in targets:
        if len(pages) >= max(0, int(max_pages)):
            break
        sibling_id = (slot.get("imported_article_id") or "").strip()
        if not sibling_id:
            continue
        article = _load_article(st, project_id=project_id, article_id=sibling_id)
        if not article or not is_article_live_on_wordpress(article):
            continue
        mapped = article_to_mapped_page(st, project_id=project_id, article=article)
        if mapped:
            pages.append(mapped)
    return pages
