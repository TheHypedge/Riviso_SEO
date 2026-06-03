"""Non-blocking MongoDB listing queries via Motor (dashboard / workspace hot paths)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import anyio

from app.services.storage_db import _database_module

log = logging.getLogger(__name__)

# Layout-only fields for project dashboard rows (no tokens, catalog, prompts, GSC secrets).
_PROJECT_LISTING_AGGREGATE_PROJECT: dict[str, int] = {
    "_id": 0,
    "id": 1,
    "owner_user_id": 1,
    "name": 1,
    "website_url": 1,
    "platform": 1,
    "shopify_shop": 1,
    "shopify_verified_status": 1,
    "shopify_verified_at": 1,
    "shopify_sync_status": 1,
    "brand_identity": 1,
    "niche_identifier": 1,
    "brand_voice": 1,
    "brand_tones": 1,
    "brand_rules": 1,
    "niche_topic": 1,
    "audience": 1,
    "target_countries": 1,
    "target_countries_all": 1,
    "target_cities": 1,
    "target_cities_all": 1,
    "created_at": 1,
}

# Workspace article rows: status derivation + feed cards only (no article body / SEO blobs).
_WORKSPACE_ARTICLE_AGGREGATE_PROJECT: dict[str, Any] = {
    "_id": 0,
    "id": {
        "$cond": {
            "if": {"$gt": [{"$strLenCP": {"$ifNull": ["$id", ""]}}, 0]},
            "then": "$id",
            "else": {"$toString": "$_id"},
        }
    },
    "project_id": 1,
    "title": 1,
    "status": {"$ifNull": ["$status", "pending"]},
    "posted_at": 1,
    "created_at": 1,
    "updated_at": 1,
    "wp_post_id": 1,
    "wp_link": 1,
    "wp_last_wp_status": 1,
    "wp_scheduled_at": 1,
    "shopify_link": 1,
    "shopify_article_id": 1,
    "image_url": 1,
}

_SCHEDULED_JOB_OVERVIEW_PROJECT: dict[str, int] = {
    "_id": 0,
    "id": 1,
    "project_id": 1,
    "article_id": 1,
    "run_at": 1,
    "state": 1,
}


def _storage():
    from app.legacy.storage import get_legacy_storage_module

    return get_legacy_storage_module()


async def fetch_user_by_id(user_id: str) -> dict[str, Any] | None:
    """Non-blocking user point-read (P4.8) — runs on the busiest auth path.

    Returns the exact same shape as ``storage.get_user_by_id`` (shared normalizer)
    and falls back to the sync/thread-pool read in JSON mode.
    """
    st = _storage()
    uid = (user_id or "").strip()
    if not uid:
        return None
    if st.storage_mode() != "mongo":
        return await anyio.to_thread.run_sync(st.get_user_by_id, uid)

    import re

    from storage import _user_doc_to_public

    db = _database_module().get_async_db()
    doc = await db.users.find_one({"id": uid})
    if not doc:
        try:
            doc = await db.users.find_one({"id": {"$regex": f"^{re.escape(uid)}$", "$options": "i"}})
        except re.error:
            doc = None
    return _user_doc_to_public(doc) if doc else None


async def fetch_project_access_row(project_id: str) -> dict[str, Any] | None:
    """Non-blocking project access/verification read (P4.8), heavy blobs excluded."""
    st = _storage()
    pid = (project_id or "").strip()
    if not pid:
        return None
    if st.storage_mode() != "mongo":
        reader = getattr(st, "get_project_access_row", None) or st.get_project_by_id
        return await anyio.to_thread.run_sync(reader, pid)

    from storage import _PROJECT_ACCESS_MONGO_PROJECTION, _mongo_doc_to_project

    db = _database_module().get_async_db()
    doc = await db.projects.find_one({"id": pid}, _PROJECT_ACCESS_MONGO_PROJECTION)
    return _mongo_doc_to_project(doc) if doc else None


async def fetch_projects_listing(owner_user_id: str) -> list[dict[str, Any]]:
    """
    Owner-scoped project list via a single Motor aggregation (no thread pool).
    Falls back to sync storage when JSON mode is active.
    """
    st = _storage()
    owner = (owner_user_id or "").strip()
    if st.storage_mode() != "mongo":
        return await anyio.to_thread.run_sync(st.load_projects_listing, owner)

    from storage import _mongo_doc_to_project, _mongo_owner_user_id_filter

    match = _mongo_owner_user_id_filter(owner) if owner else {}
    pipeline: list[dict[str, Any]] = [
        {"$match": match},
        {"$project": _PROJECT_LISTING_AGGREGATE_PROJECT},
        {"$sort": {"created_at": 1}},
    ]
    db = _database_module().get_async_db()
    cursor = db.projects.aggregate(pipeline, allowDiskUse=False)
    docs = await cursor.to_list(length=500)
    return [_mongo_doc_to_project(doc) for doc in docs if isinstance(doc, dict)]


async def fetch_workspace_overview_bundle(
    owner_user_id: str,
    *,
    article_limit: int = 1500,
) -> dict[str, Any]:
    """
    Cross-project workspace data: projects, recent article listing rows, open scheduled jobs.

    Uses parallel Motor aggregations (no per-project loops, no thread pool on Mongo path).
    """
    st = _storage()
    owner = (owner_user_id or "").strip()
    if st.storage_mode() != "mongo":
        return await anyio.to_thread.run_sync(_sync_workspace_overview_bundle, st, owner, article_limit)

    from storage import (
        _coerce_wp_scheduled_at_str,
        _mongo_doc_to_project,
        _mongo_owner_user_id_filter,
    )

    match = _mongo_owner_user_id_filter(owner) if owner else {}
    db = _database_module().get_async_db()

    project_pipeline: list[dict[str, Any]] = [
        {"$match": match},
        {"$project": _PROJECT_LISTING_AGGREGATE_PROJECT},
        {"$sort": {"created_at": 1}},
    ]
    project_docs = await db.projects.aggregate(project_pipeline, allowDiskUse=False).to_list(length=500)
    projects = [_mongo_doc_to_project(doc) for doc in project_docs if isinstance(doc, dict)]
    by_id: dict[str, dict[str, Any]] = {}
    for p in projects:
        pid = (p.get("id") or "").strip()
        if pid:
            by_id[pid] = p
    pids = sorted(by_id.keys())
    if not pids:
        return {"projects_by_id": {}, "pids": [], "articles": [], "scheduled_jobs": []}

    lim = max(1, min(int(article_limit or 1500), 5000))
    article_pipeline: list[dict[str, Any]] = [
        {"$match": {"project_id": {"$in": pids}}},
        {"$project": _WORKSPACE_ARTICLE_AGGREGATE_PROJECT},
        {"$sort": {"created_at": -1}},
        {"$limit": lim},
    ]
    jobs_pipeline: list[dict[str, Any]] = [
        {
            "$match": {
                "project_id": {"$in": pids},
                "state": {"$nin": ["cancelled", "completed", "failed", "posted"]},
            }
        },
        {"$project": _SCHEDULED_JOB_OVERVIEW_PROJECT},
    ]

    articles_raw, jobs_raw = await asyncio.gather(
        db.articles.aggregate(article_pipeline, allowDiskUse=False).to_list(length=lim),
        db.scheduled_jobs.aggregate(jobs_pipeline, allowDiskUse=False).to_list(length=2000),
    )

    articles: list[dict[str, Any]] = []
    for row in articles_raw:
        if not isinstance(row, dict):
            continue
        d = dict(row)
        d["wp_scheduled_at"] = _coerce_wp_scheduled_at_str(d.get("wp_scheduled_at"))
        if not (d.get("id") or "").strip():
            continue
        articles.append(d)

    scheduled_jobs = [dict(j) for j in jobs_raw if isinstance(j, dict)]

    return {
        "projects_by_id": by_id,
        "pids": pids,
        "articles": articles,
        "scheduled_jobs": scheduled_jobs,
    }


def _sync_workspace_overview_bundle(st: Any, owner_user_id: str, article_limit: int) -> dict[str, Any]:
    """JSON / sync fallback for workspace overview."""
    from app.core.ids import user_ids_equal

    uid = (owner_user_id or "").strip()
    projs = [p for p in (st.load_projects(uid) or []) if isinstance(p, dict)]
    by_id: dict[str, dict[str, Any]] = {}
    for p in projs:
        pid = (p.get("id") or "").strip()
        owner = (p.get("owner_user_id") or "").strip()
        if not pid or not user_ids_equal(owner, uid):
            continue
        by_id[pid] = p
    pids = sorted(by_id.keys())
    if not pids:
        return {"projects_by_id": {}, "pids": [], "articles": [], "scheduled_jobs": []}

    articles: list[dict[str, Any]] = []
    if hasattr(st, "load_recent_article_listings_for_projects"):
        try:
            articles = list(st.load_recent_article_listings_for_projects(pids, limit=article_limit) or [])
        except Exception:
            log.exception("workspace overview: cross-project article listing failed")
    if not articles and hasattr(st, "load_articles_listing_for_project"):
        per_project = max(80, article_limit // max(1, len(pids)))
        for pid in pids:
            try:
                rows = st.load_articles_listing_for_project(pid, limit=per_project) or []
                if isinstance(rows, list):
                    articles.extend([r for r in rows if isinstance(r, dict)])
            except Exception:
                log.warning("workspace overview: skip articles for project %s", pid, exc_info=True)
        articles.sort(key=lambda r: (str(r.get("created_at") or "")), reverse=True)
        articles = articles[:article_limit]

    scheduled_jobs: list[dict[str, Any]] = []
    if hasattr(st, "load_scheduled_jobs"):
        for pid in pids:
            jobs = list(st.load_scheduled_jobs(project_id=pid) or [])
            for j in jobs:
                if isinstance(j, dict):
                    scheduled_jobs.append(j)

    return {
        "projects_by_id": by_id,
        "pids": pids,
        "articles": articles,
        "scheduled_jobs": scheduled_jobs,
    }
