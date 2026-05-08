"""
Per-project article title duplicate detection (Unicode-safe, case-insensitive).

Used by article CRUD and by topic-cluster bulk generation so both paths share one rule.
"""

from __future__ import annotations

import unicodedata
from typing import Any


def normalize_article_title_key(raw: str) -> str:
    """Stable case-insensitive key for duplicate detection within a project."""
    s = (raw or "").strip()
    if not s:
        return ""
    try:
        s = unicodedata.normalize("NFKC", s)
    except Exception:
        pass
    return s.casefold()


def sync_project_title_index(st: Any, project_id: str) -> dict[str, tuple[str, str]]:
    """
    Map normalized title key -> (stored display title, article id) for one project.
    First occurrence wins when legacy data contains inconsistent casing.
    """
    pid = (project_id or "").strip()
    if hasattr(st, "load_articles_listing_for_project"):
        rows = st.load_articles_listing_for_project(pid, limit=20000) or []
    else:
        rows = [
            a
            for a in (st.load_articles() or [])
            if isinstance(a, dict) and (a.get("project_id") or "").strip() == pid
        ]
    out: dict[str, tuple[str, str]] = {}
    for a in rows:
        if not isinstance(a, dict):
            continue
        t = (a.get("title") or "").strip()
        if not t:
            continue
        k = normalize_article_title_key(t)
        if not k:
            continue
        aid = (a.get("id") or "").strip()
        if not aid:
            continue
        if k not in out:
            out[k] = (t[:500], aid)
    return out
