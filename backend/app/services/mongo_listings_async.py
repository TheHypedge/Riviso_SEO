"""Non-blocking MongoDB listing queries via Motor (dashboard / workspace hot paths)."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import anyio
from pymongo import ReadPreference

from app.services.storage_db import _database_module

log = logging.getLogger(__name__)

# F1.4: process-wide micro-cache, same shape as GoogleConsoleService._CACHE
# (google_console_service.py). Date-range/project filtering in the /overview
# route happens in Python after this bundle is fetched, so the expensive
# Mongo aggregation itself is identical for every view of the same user's
# dashboard -- one cache entry per user covers all of them.
_OVERVIEW_CACHE: dict[tuple, tuple[float, dict[str, Any]]] = {}
_OVERVIEW_CACHE_TTL_SECONDS = 90

# The global Mongo client (database.py) pins read_preference=PRIMARY everywhere
# so ordinary read-after-write flows (create a project, see it immediately) stay
# consistent. Dashboard/workspace listing reads are the one class of query that
# doesn't need that guarantee — they're summary data tolerant of a few seconds
# of replica lag — and they're also the queries most exposed to the Atlas
# primary's occasional flakiness (see fetch_workspace_overview_bundle). Reading
# from a secondary lets these survive a degraded/unreachable primary instead of
# hanging for the full socketTimeoutMS on every attempt.
_LISTING_READ_PREFERENCE = ReadPreference.SECONDARY_PREFERRED


def _tolerant(coll: Any) -> Any:
    """Same collection handle, scoped to secondaryPreferred for this one read."""
    return coll.with_options(read_preference=_LISTING_READ_PREFERENCE)


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


async def _aggregate_with_retry(
    coll: Any,
    pipeline: list[dict[str, Any]],
    *,
    limit: int,
    attempts: int = 2,
) -> list[dict[str, Any]]:
    """Run aggregate().to_list() with retry on transient Mongo errors.

    PyMongo's retryReads only covers the initial command, not ``getMore`` —
    a network blip mid-cursor otherwise bubbles up as an uncaught
    NetworkTimeout even though the operation is a plain read. Re-running the
    whole aggregation is safe here since these are read-only listing queries.
    """
    is_transient = _database_module().is_transient_mongo_error
    last_exc: BaseException | None = None
    for attempt in range(max(1, attempts)):
        try:
            return await coll.aggregate(pipeline, allowDiskUse=False).to_list(length=limit)
        except Exception as e:
            last_exc = e
            if not is_transient(e) or attempt >= attempts - 1:
                raise
            log.warning("Transient Mongo error on aggregate (attempt %s/%s): %s", attempt + 1, attempts, e)
            await asyncio.sleep(0.3 * (attempt + 1))
    assert last_exc is not None
    raise last_exc


async def _aggregate_sort_fallback(
    coll: Any,
    match: dict[str, Any],
    project: dict[str, Any],
    sort: dict[str, int],
    *,
    limit: int | None,
    label: str,
    warnings: list[str],
) -> list[dict[str, Any]]:
    """Run a $match/$project/$sort[/$limit] aggregation; if the in-memory sort
    exceeds Mongo's 32MB cap (this cluster's tier does not support allowDiskUse
    external sort), fall back to the same query without the $sort stage rather
    than failing the whole dashboard.

    Ordering only matters for truncation (picking the "most recent N" when the
    result set exceeds ``limit``) — every downstream consumer of these rows
    re-sorts in Python by its own timestamp field, so an unsorted fallback is
    fully correct whenever the account is under the limit, and a graceful
    degradation (arbitrary N instead of most-recent N) otherwise.
    """
    from pymongo.errors import OperationFailure

    pipeline: list[dict[str, Any]] = [{"$match": match}, {"$project": project}, {"$sort": sort}]
    if limit is not None:
        pipeline.append({"$limit": limit})
    try:
        return await _aggregate_with_retry(coll, pipeline, limit=limit or 5000)
    except OperationFailure as e:
        if "memory limit" not in str(e).lower():
            raise
        log.warning("%s: sort exceeded memory limit, falling back to unsorted fetch", label)
        fallback: list[dict[str, Any]] = [{"$match": match}, {"$project": project}]
        if limit is not None:
            fallback.append({"$limit": limit})
        result = await _aggregate_with_retry(coll, fallback, limit=limit or 5000)
        if limit is not None and len(result) >= limit:
            # Only truncation ("most recent N" vs. arbitrary N) is affected when
            # the unsorted fetch itself got capped at the limit — that's the one
            # case that's a real, user-visible degradation. When it returns
            # fewer rows than the limit, the account was under the limit and
            # every matching row came back; per the docstring above that's fully
            # correct data, not degraded, so don't surface a "some data
            # couldn't load" warning over a dataset that loaded completely.
            warnings.append(label)
        return result


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
    cursor = _tolerant(db.projects).aggregate(pipeline, allowDiskUse=False)
    docs = await cursor.to_list(length=500)
    return [_mongo_doc_to_project(doc) for doc in docs if isinstance(doc, dict)]


async def _fetch_shared_project_ids(db: Any, user_id: str) -> list[str]:
    """Project IDs where user_id is an active collaborator (not the owner).

    Mirrors storage.get_projects_shared_with_user()'s query so the workspace
    overview sees the same "shared with me" set as GET /projects and the
    dashboard's Members tab — just via Motor so it stays on the non-blocking
    dashboard hot path instead of a thread-pool round trip.
    """
    uid = (user_id or "").strip()
    if not uid:
        return []
    cursor = _tolerant(db.project_collaborators).find(
        {"user_id": uid, "status": "active"}, {"_id": 0, "project_id": 1}
    )
    docs = await cursor.to_list(length=1000)
    return [d["project_id"] for d in docs if isinstance(d, dict) and d.get("project_id")]


def _combine_owner_and_shared_filter(owner_filter: dict[str, Any], shared_pids: list[str]) -> dict[str, Any]:
    """Union an owner_user_id filter with an explicit set of shared project ids."""
    if not shared_pids:
        return owner_filter
    owner_clauses = owner_filter.get("$or") if "$or" in owner_filter else ([owner_filter] if owner_filter else [])
    return {"$or": [*owner_clauses, {"id": {"$in": shared_pids}}]}


async def fetch_workspace_overview_bundle(
    owner_user_id: str,
    *,
    article_limit: int = 1500,
) -> dict[str, Any]:
    """
    Cross-project workspace data: owned + shared/collaborator projects, recent
    article listing rows, open scheduled jobs. Cached for _OVERVIEW_CACHE_TTL_SECONDS
    (F1.4) -- see _OVERVIEW_CACHE above.
    """
    key = ((owner_user_id or "").strip(), int(article_limit or 1500))
    cached = _OVERVIEW_CACHE.get(key)
    if cached is not None:
        expires_at, value = cached
        if expires_at >= time.time():
            return value
        _OVERVIEW_CACHE.pop(key, None)

    result = await _fetch_workspace_overview_bundle_uncached(owner_user_id, article_limit=article_limit)
    # Don't cache a degraded result -- a widget that failed due to primary
    # flakiness should get to retry on the next request, not serve the same
    # gap for 90s.
    if not result.get("warnings"):
        _OVERVIEW_CACHE[key] = (time.time() + _OVERVIEW_CACHE_TTL_SECONDS, result)
    return result


async def _fetch_workspace_overview_bundle_uncached(
    owner_user_id: str,
    *,
    article_limit: int = 1500,
) -> dict[str, Any]:
    st = _storage()
    owner = (owner_user_id or "").strip()
    if st.storage_mode() != "mongo":
        return await anyio.to_thread.run_sync(_sync_workspace_overview_bundle, st, owner, article_limit)

    from storage import (
        _coerce_wp_scheduled_at_str,
        _mongo_doc_to_project,
        _mongo_owner_user_id_filter,
    )

    owner_filter = _mongo_owner_user_id_filter(owner) if owner else {}
    db = _database_module().get_async_db()
    warnings: list[str] = []

    shared_pids = await _fetch_shared_project_ids(db, owner)
    match = _combine_owner_and_shared_filter(owner_filter, shared_pids)

    project_docs = await _aggregate_sort_fallback(
        _tolerant(db.projects), match, _PROJECT_LISTING_AGGREGATE_PROJECT, {"created_at": 1},
        limit=500, label="projects", warnings=warnings,
    )
    projects = [_mongo_doc_to_project(doc) for doc in project_docs if isinstance(doc, dict)]
    by_id: dict[str, dict[str, Any]] = {}
    for p in projects:
        pid = (p.get("id") or "").strip()
        if pid:
            by_id[pid] = p
    pids = sorted(by_id.keys())
    if not pids:
        return {"projects_by_id": {}, "pids": [], "articles": [], "scheduled_jobs": [], "warnings": warnings}

    lim = max(1, min(int(article_limit or 1500), 5000))
    jobs_pipeline: list[dict[str, Any]] = [
        {
            "$match": {
                "project_id": {"$in": pids},
                "state": {"$nin": ["cancelled", "completed", "failed", "posted"]},
            }
        },
        {"$project": _SCHEDULED_JOB_OVERVIEW_PROJECT},
    ]

    # Articles and scheduled jobs are independent widgets: one failing (even
    # after retries/fallback) must not take down the other or the whole
    # dashboard — collect results with return_exceptions and degrade gracefully.
    articles_result, jobs_result = await asyncio.gather(
        _aggregate_sort_fallback(
            _tolerant(db.articles),
            {"project_id": {"$in": pids}},
            _WORKSPACE_ARTICLE_AGGREGATE_PROJECT,
            {"created_at": -1},
            limit=lim, label="articles", warnings=warnings,
        ),
        _aggregate_with_retry(_tolerant(db.scheduled_jobs), jobs_pipeline, limit=2000),
        return_exceptions=True,
    )

    articles_raw: list[dict[str, Any]]
    if isinstance(articles_result, BaseException):
        log.exception("workspace overview: articles fetch failed for user %s", owner, exc_info=articles_result)
        warnings.append("articles")
        articles_raw = []
    else:
        articles_raw = articles_result

    jobs_raw: list[dict[str, Any]]
    if isinstance(jobs_result, BaseException):
        log.exception("workspace overview: scheduled_jobs fetch failed for user %s", owner, exc_info=jobs_result)
        warnings.append("scheduled_jobs")
        jobs_raw = []
    else:
        jobs_raw = jobs_result

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
        "warnings": warnings,
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
