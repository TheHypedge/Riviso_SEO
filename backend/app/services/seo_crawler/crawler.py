"""BFS crawl loop (Site-Audit-Design.md §5, §11-§14, §18-§19, §37).

Scope for this build (Phase 1 + Phase 2 of the approved plan): the frontier only
follows `<a href>` links to same-scope pages and fetches them. Links to obviously
non-HTML resources (images/CSS/JS/fonts/archives/media by extension) and links
outside crawl scope are recorded as graph edges (`seo_audit_links`) but never
fetched -- resource/external auditing is a later phase (§Technical/§External).
A same-scope link with no recognizable non-HTML extension IS fetched even if it
turns out not to be HTML (so broken-link/redirect status is still captured); it
just isn't parsed for further link discovery if it isn't HTML.
"""

from __future__ import annotations

import asyncio
import posixpath
import secrets
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

from app.services.seo_crawler import robots as robots_mod
from app.services.seo_crawler import sitemap as sitemap_mod
from app.services.seo_crawler.fetcher import build_http_client, fetch_url
from app.services.seo_crawler.parser import parse_html
from app.services.seo_crawler.url_utils import folder_depth, normalize_url, registrable_host, same_scope
from app.services.storage_db import call_storage
from app.services.to_thread import run_sync


async def _storage(fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
    """Run a blocking storage call off the event loop with Mongo-transient-error
    retries, via the same `call_storage` helper generation_worker.py/
    article_pipeline.py/scheduler.py already use -- the SEO crawler's writes were
    the one hot path in this codebase that still called pymongo directly, which
    is what let a single transient timeout abort an otherwise-healthy crawl."""
    return await run_sync(call_storage, fn, *args, **kwargs)

_NON_HTML_EXTENSIONS = frozenset(
    {
        ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif",
        ".css", ".js", ".mjs", ".json", ".xml",
        ".woff", ".woff2", ".ttf", ".otf", ".eot",
        ".pdf", ".zip", ".rar", ".7z", ".gz", ".tar",
        ".mp4", ".mp3", ".webm", ".mov", ".avi", ".wav", ".ogg",
        ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    }
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _looks_non_html(url: str) -> bool:
    try:
        path = urlparse(url).path or ""
    except Exception:
        return False
    ext = posixpath.splitext(path)[1].lower()
    return ext in _NON_HTML_EXTENSIONS


@dataclass
class _FrontierItem:
    url: str
    normalized_url: str
    discovered_from: str | None
    discovery_type: str
    depth: int


@dataclass
class CrawlCounts:
    discovered: int = 0
    fetched: int = 0
    queued: int = 0
    blocked: int = 0
    failed: int = 0
    internal: int = 0
    external: int = 0
    # Tracked incrementally (not just in the post-crawl `_summary_stats` pass) so the
    # KPI strip's Broken Links / Redirects tiles can update live during the crawl
    # instead of sitting at "--" until the whole pipeline finishes -- computed the
    # same way (status_code >= 400 / redirect_url is not None) so the live number
    # matches the final post-analysis aggregate exactly once the crawl completes.
    broken_links: int = 0
    redirects: int = 0
    # Same live-during-crawl treatment as broken_links/redirects: indexability is
    # already known the moment a page is fetched (_compute_indexability), so the
    # Indexability donut can update live instead of waiting for the whole pipeline.
    indexability_breakdown: dict[str, int] = field(default_factory=lambda: {"indexable": 0, "non_indexable": 0, "blocked": 0, "unknown": 0})


def _compute_indexability(*, status_code: int | None, robots_blocked: bool, meta_robots: str | None, x_robots_tag: str | None, canonical: str | None, page_url: str, redirect_url: str | None) -> tuple[str, str]:
    """Minimal §37 indexability engine for Phase 1+2's inputs. Never confuses a
    robots.txt block with a noindex directive -- distinct reasons, per spec."""
    if robots_blocked:
        return "blocked", "Disallowed by robots.txt"
    if redirect_url:
        return "non_indexable", "URL redirects"
    if status_code is None:
        return "unknown", "No response"
    if status_code >= 500:
        return "non_indexable", f"Server error ({status_code})"
    if status_code >= 400:
        return "non_indexable", f"Client error ({status_code})"
    directives = f"{meta_robots or ''} {x_robots_tag or ''}".lower()
    if "noindex" in directives:
        return "non_indexable", "noindex directive"
    if canonical and normalize_url(canonical) not in (None, normalize_url(page_url)):
        return "non_indexable", "Canonicalised to another URL"
    if status_code == 200:
        return "indexable", ""
    return "unknown", f"Unhandled status {status_code}"


async def run_crawl(
    st: Any,
    *,
    audit_id: str,
    seed_url: str,
    max_urls: int,
    respect_robots: bool,
    user_agent: str,
    timeout_seconds: float,
    concurrency_per_host: int,
    max_duration_seconds: float,
    should_cancel: Callable[[], bool] | None = None,
    flush_every: int = 25,
    progress_every_seconds: float = 3.0,
) -> dict[str, Any]:
    """Crawl `seed_url`'s scope from scratch, writing results incrementally via
    `st` (the storage module). Returns the final counts dict. `st` is passed
    explicitly (never imported at module scope) so this stays testable in
    isolation, mirroring serp_refresh_worker.py's `_refresh_stale_entries(st, ...)`
    convention."""
    seed_normalized = normalize_url(seed_url)
    if not seed_normalized:
        raise ValueError(f"Invalid seed URL: {seed_url!r}")
    seed_host = registrable_host(seed_normalized)

    counts = CrawlCounts()
    visited: set[str] = set()
    frontier: deque[_FrontierItem] = deque()
    frontier.append(_FrontierItem(url=seed_normalized, normalized_url=seed_normalized, discovered_from=None, discovery_type="seed", depth=0))
    visited.add(seed_normalized)
    counts.discovered = 1
    counts.queued = 1

    async with build_http_client(user_agent=user_agent, timeout_seconds=timeout_seconds) as client:
        robots_policy: robots_mod.RobotsPolicy | None = None
        rp: RobotFileParser | None = None
        if respect_robots:
            robots_policy, rp = await robots_mod.fetch_robots_policy(client, seed_normalized)

        # Pure link-following BFS from the homepage routinely misses most of a real
        # site (confirmed: a WordPress site with 66 pages reachable by links alone
        # had 533 in its articles sitemap). Seed the frontier from every sitemap
        # robots.txt declares so discovery isn't limited to "however many clicks
        # from the homepage" -- every seeded URL still goes through the same
        # scope/dedup/cap checks and gets fetched normally, this only fixes *finding*
        # it. discovered_in="sitemap" per the CrawlLink model (spec §19).
        seed_link_docs: list[dict[str, Any]] = []
        if robots_policy and robots_policy.sitemap_urls:
            sitemap_page_urls = await sitemap_mod.collect_sitemap_urls(client, robots_policy.sitemap_urls)
            for raw_url in sitemap_page_urls:
                if counts.discovered >= max_urls:
                    break
                target_norm = normalize_url(raw_url)
                if not target_norm or target_norm in visited:
                    continue
                if not same_scope(target_norm, seed_host or "") or _looks_non_html(target_norm):
                    continue
                visited.add(target_norm)
                counts.discovered += 1
                counts.queued += 1
                seed_link_docs.append(
                    {
                        "audit_id": audit_id, "source_url_id": None, "target_url_id": None,
                        "target_url": target_norm, "type": "sitemap", "anchor_text": "",
                        "rel": [], "followable": True, "discovered_in": "sitemap",
                    }
                )
                frontier.append(_FrontierItem(url=target_norm, normalized_url=target_norm, discovered_from=None, discovery_type="sitemap", depth=1))

        return await _drain_frontier(
            st,
            client=client,
            rp=rp,
            respect_robots=respect_robots,
            user_agent=user_agent,
            audit_id=audit_id,
            seed_host=seed_host,
            max_urls=max_urls,
            concurrency_per_host=concurrency_per_host,
            max_duration_seconds=max_duration_seconds,
            should_cancel=should_cancel,
            flush_every=flush_every,
            progress_every_seconds=progress_every_seconds,
            frontier=frontier,
            visited=visited,
            counts=counts,
            url_id_by_normalized={},
            seed_link_docs=seed_link_docs,
        )


async def resume_crawl(
    st: Any,
    *,
    audit_id: str,
    seed_url: str,
    max_urls: int,
    respect_robots: bool,
    user_agent: str,
    timeout_seconds: float,
    concurrency_per_host: int,
    max_duration_seconds: float,
    should_cancel: Callable[[], bool] | None = None,
    flush_every: int = 25,
    progress_every_seconds: float = 3.0,
) -> dict[str, Any]:
    """Continue a crawl that was interrupted mid-way (Mongo hiccup, process
    restart, hitting max_duration_seconds, ...) from exactly where it left off,
    instead of re-crawling from scratch and re-spending everything already fetched.

    No separate checkpoint state to keep in sync: `seo_audit_urls` for this
    audit_id already IS the visited set, and any `seo_audit_links` target not yet
    in `seo_audit_urls` already IS the remaining frontier -- both durably written
    by the interrupted attempt's own incremental flushes (every ~25 pages, not
    just at the end). Counts are recomputed from those same stored docs rather
    than trusted from the audit's last periodic progress write, because that
    write is throttled to once per ~3s and can be briefly ahead of what actually
    made it to `seo_audit_urls`/`seo_audit_links` if the failure landed between
    the two -- resuming from a stale, too-high count would silently overcount
    every field for the rest of the crawl."""
    seed_normalized = normalize_url(seed_url)
    if not seed_normalized:
        raise ValueError(f"Invalid seed URL: {seed_url!r}")
    seed_host = registrable_host(seed_normalized)

    # batch_size=200 (the max the loader allows) rather than its default 50: this read
    # has no progress bar to feed, so there's no reason to pay for ~4x the round-trips
    # a large site's link graph would otherwise need to reconstruct state.
    existing_urls = await _storage(st.load_all_seo_audit_urls, audit_id, batch_size=200)
    existing_links = await _storage(st.load_all_seo_audit_links, audit_id, batch_size=200)

    visited: set[str] = set()
    depth_by_url_id: dict[str, int] = {}
    url_id_by_normalized: dict[str, str] = {}
    blocked = 0
    failed = 0
    broken_links = 0
    redirects = 0
    indexability_breakdown = {"indexable": 0, "non_indexable": 0, "blocked": 0, "unknown": 0}
    for u in existing_urls:
        norm = u.get("normalized_url")
        if norm:
            visited.add(norm)
        uid = u.get("id")
        if uid and norm:
            url_id_by_normalized[norm] = uid
        if uid:
            depth_by_url_id[uid] = int(u.get("crawl_depth") or 0)
        idx = u.get("indexability")
        if idx in indexability_breakdown:
            indexability_breakdown[idx] += 1
        else:
            indexability_breakdown["unknown"] += 1
        if idx == "blocked":
            blocked += 1
        elif u.get("status_code") is None:
            failed += 1
        status_code = u.get("status_code")
        if isinstance(status_code, int) and status_code >= 400:
            broken_links += 1
        if u.get("redirect_url"):
            redirects += 1
    fetched = len(existing_urls) - blocked

    frontier: deque[_FrontierItem] = deque()
    seen_targets: set[str] = set()
    internal = 0
    external = 0
    for link in existing_links:
        target = link.get("target_url")
        if not target:
            continue
        is_internal = same_scope(target, seed_host or "")
        if is_internal:
            internal += 1
        else:
            external += 1
        if not is_internal or target in visited or target in seen_targets or _looks_non_html(target):
            continue
        seen_targets.add(target)
        source_id = link.get("source_url_id")
        depth = (depth_by_url_id.get(source_id, 0) + 1) if source_id else 1
        frontier.append(_FrontierItem(url=target, normalized_url=target, discovered_from=None, discovery_type=link.get("discovered_in") or "raw_html", depth=depth))

    counts = CrawlCounts(
        discovered=len(visited) + len(seen_targets),
        fetched=fetched,
        queued=len(seen_targets),
        blocked=blocked,
        failed=failed,
        internal=internal,
        external=external,
        broken_links=broken_links,
        redirects=redirects,
        indexability_breakdown=indexability_breakdown,
    )

    async with build_http_client(user_agent=user_agent, timeout_seconds=timeout_seconds) as client:
        rp: RobotFileParser | None = None
        if respect_robots:
            _robots_policy, rp = await robots_mod.fetch_robots_policy(client, seed_normalized)

        return await _drain_frontier(
            st,
            client=client,
            rp=rp,
            respect_robots=respect_robots,
            user_agent=user_agent,
            audit_id=audit_id,
            seed_host=seed_host,
            max_urls=max_urls,
            concurrency_per_host=concurrency_per_host,
            max_duration_seconds=max_duration_seconds,
            should_cancel=should_cancel,
            flush_every=flush_every,
            progress_every_seconds=progress_every_seconds,
            frontier=frontier,
            visited=visited | seen_targets,
            counts=counts,
            url_id_by_normalized=url_id_by_normalized,
        )


async def incremental_crawl(
    st: Any,
    *,
    audit_id: str,
    previous_audit_id: str,
    seed_url: str,
    max_urls: int,
    respect_robots: bool,
    user_agent: str,
    timeout_seconds: float,
    concurrency_per_host: int,
    max_duration_seconds: float,
    should_cancel: Callable[[], bool] | None = None,
    flush_every: int = 25,
    progress_every_seconds: float = 3.0,
) -> dict[str, Any]:
    """Start a NEW audit (its own audit_id, its own Crawl History entry) that reuses
    a previous audit's already-fetched pages instead of re-fetching every one of
    them, so a routine "re-run the audit" doesn't re-pay the full cost of a large
    site every time. Only two kinds of pages actually get crawled this run: the
    seed/homepage (always re-fetched fresh -- the surest way to discover links
    added since last time) and anything genuinely new -- a URL that either wasn't
    in the previous audit's link graph at all, or was discovered but never
    actually got fetched (an interrupted previous run). Everything else
    previously fetched is copied forward as-is into the new audit_id, tagged
    `carried_forward: true` (with its original `fetched_at` preserved, not
    stamped "now") so URL Explorer / API consumers can tell a page's data is
    from a prior crawl rather than freshly verified this run.

    Trade-off, by design: a page that changed (title edited, now 404s, a broken
    link got fixed) since the previous audit won't be caught until either that
    page is reached by a fresh crawl again or the user runs "Start Fresh Audit"
    for a full re-verification -- that path stays one click away specifically so
    this isn't the only option."""
    seed_normalized = normalize_url(seed_url)
    if not seed_normalized:
        raise ValueError(f"Invalid seed URL: {seed_url!r}")
    seed_host = registrable_host(seed_normalized)

    previous_urls = await _storage(st.load_all_seo_audit_urls, previous_audit_id, batch_size=200)
    previous_links = await _storage(st.load_all_seo_audit_links, previous_audit_id, batch_size=200)

    # The seed's own outgoing links get regenerated fresh below (it's always
    # re-crawled), so its previous url_id is needed to exclude those from carry-forward.
    seed_old_id: str | None = None
    for u in previous_urls:
        if u.get("normalized_url") == seed_normalized:
            seed_old_id = u.get("id")
            break

    visited: set[str] = set()
    depth_by_url_id: dict[str, int] = {}
    old_id_to_new_id: dict[str, str] = {}
    carried_url_docs: list[dict[str, Any]] = []
    blocked = 0
    failed = 0
    broken_links = 0
    redirects = 0
    indexability_breakdown = {"indexable": 0, "non_indexable": 0, "blocked": 0, "unknown": 0}
    for u in previous_urls:
        norm = u.get("normalized_url")
        old_id = u.get("id")
        if not norm or norm == seed_normalized:
            continue  # seed always gets a fresh fetch this run, never carried forward
        new_id = secrets.token_hex(12)
        if old_id:
            old_id_to_new_id[old_id] = new_id
        visited.add(norm)
        depth_by_url_id[new_id] = int(u.get("crawl_depth") or 0)
        doc = dict(u)
        doc["id"] = new_id
        doc["audit_id"] = audit_id
        doc["carried_forward"] = True
        carried_url_docs.append(doc)
        idx = doc.get("indexability")
        if idx in indexability_breakdown:
            indexability_breakdown[idx] += 1
        else:
            indexability_breakdown["unknown"] += 1
        if idx == "blocked":
            blocked += 1
        elif doc.get("status_code") is None:
            failed += 1
        status_code = doc.get("status_code")
        if isinstance(status_code, int) and status_code >= 400:
            broken_links += 1
        if doc.get("redirect_url"):
            redirects += 1
    fetched = len(carried_url_docs) - blocked

    carried_link_docs: list[dict[str, Any]] = []
    internal = 0
    external = 0
    frontier: deque[_FrontierItem] = deque()
    seen_targets: set[str] = set()
    for link in previous_links:
        source_id = link.get("source_url_id")
        if seed_old_id and source_id == seed_old_id:
            continue  # regenerated fresh when the seed is re-crawled below
        target = link.get("target_url")
        if not target:
            continue
        is_internal = same_scope(target, seed_host or "")
        if is_internal:
            internal += 1
        else:
            external += 1
        doc = dict(link)
        doc.pop("_id", None)
        doc["audit_id"] = audit_id
        if source_id:
            doc["source_url_id"] = old_id_to_new_id.get(source_id, source_id)
        carried_link_docs.append(doc)

        if not is_internal or target == seed_normalized or target in visited or target in seen_targets or _looks_non_html(target):
            continue
        seen_targets.add(target)
        new_source_id = old_id_to_new_id.get(source_id) if source_id else None
        depth = (depth_by_url_id.get(new_source_id, 0) + 1) if new_source_id else 1
        frontier.append(_FrontierItem(url=target, normalized_url=target, discovered_from=None, discovery_type=link.get("discovered_in") or "raw_html", depth=depth))

    # Persist carried-forward docs before the fresh crawl starts writing its own --
    # chunked (200/call) so a large site's carry-forward isn't one giant write.
    for i in range(0, len(carried_url_docs), 200):
        await _storage(st.insert_seo_audit_urls_bulk, carried_url_docs[i : i + 200])
    for i in range(0, len(carried_link_docs), 200):
        await _storage(st.insert_seo_audit_links_bulk, carried_link_docs[i : i + 200])

    visited.add(seed_normalized)
    counts = CrawlCounts(
        discovered=len(visited) + len(seen_targets),
        fetched=fetched,
        queued=1 + len(seen_targets),  # +1 for the seed, always queued fresh
        blocked=blocked,
        failed=failed,
        internal=internal,
        external=external,
        broken_links=broken_links,
        redirects=redirects,
        indexability_breakdown=indexability_breakdown,
    )
    frontier.appendleft(_FrontierItem(url=seed_normalized, normalized_url=seed_normalized, discovered_from=None, discovery_type="seed", depth=0))

    async with build_http_client(user_agent=user_agent, timeout_seconds=timeout_seconds) as client:
        robots_policy: robots_mod.RobotsPolicy | None = None
        rp: RobotFileParser | None = None
        if respect_robots:
            robots_policy, rp = await robots_mod.fetch_robots_policy(client, seed_normalized)

        # Fresh sitemap fetch too -- the other main way genuinely new pages surface
        # without ever being linked from a page we're re-crawling this run.
        seed_link_docs: list[dict[str, Any]] = []
        if robots_policy and robots_policy.sitemap_urls:
            sitemap_page_urls = await sitemap_mod.collect_sitemap_urls(client, robots_policy.sitemap_urls)
            for raw_url in sitemap_page_urls:
                if counts.discovered >= max_urls:
                    break
                target_norm = normalize_url(raw_url)
                if not target_norm or target_norm in visited:
                    continue
                if not same_scope(target_norm, seed_host or "") or _looks_non_html(target_norm):
                    continue
                visited.add(target_norm)
                counts.discovered += 1
                counts.queued += 1
                seed_link_docs.append(
                    {
                        "audit_id": audit_id, "source_url_id": None, "target_url_id": None,
                        "target_url": target_norm, "type": "sitemap", "anchor_text": "",
                        "rel": [], "followable": True, "discovered_in": "sitemap",
                    }
                )
                frontier.append(_FrontierItem(url=target_norm, normalized_url=target_norm, discovered_from=None, discovery_type="sitemap", depth=1))

        return await _drain_frontier(
            st,
            client=client,
            rp=rp,
            respect_robots=respect_robots,
            user_agent=user_agent,
            audit_id=audit_id,
            seed_host=seed_host,
            max_urls=max_urls,
            concurrency_per_host=concurrency_per_host,
            max_duration_seconds=max_duration_seconds,
            should_cancel=should_cancel,
            flush_every=flush_every,
            progress_every_seconds=progress_every_seconds,
            frontier=frontier,
            visited=visited,
            counts=counts,
            url_id_by_normalized={},
            seed_link_docs=seed_link_docs,
        )


async def _drain_frontier(
    st: Any,
    *,
    client: Any,
    rp: RobotFileParser | None,
    respect_robots: bool,
    user_agent: str,
    audit_id: str,
    seed_host: str,
    max_urls: int,
    concurrency_per_host: int,
    max_duration_seconds: float,
    should_cancel: Callable[[], bool] | None,
    flush_every: int,
    progress_every_seconds: float,
    frontier: "deque[_FrontierItem]",
    visited: set[str],
    counts: CrawlCounts,
    url_id_by_normalized: dict[str, str],
    seed_link_docs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """The actual BFS drain loop, shared by a fresh `run_crawl` and a `resume_crawl`
    that reconstructed its starting frontier/visited/counts from storage -- from
    here on a resumed crawl behaves identically to a fresh one, same flush
    cadence, same retry/off-thread writes, same cancel/duration checks."""
    started_at = time.monotonic()
    pending_url_docs: list[dict[str, Any]] = []
    pending_link_docs: list[dict[str, Any]] = list(seed_link_docs or [])

    async def _flush(force: bool = False) -> None:
        url_batch: list[dict[str, Any]] | None = None
        link_batch: list[dict[str, Any]] | None = None
        if pending_url_docs and (force or len(pending_url_docs) >= flush_every):
            url_batch = list(pending_url_docs)
            pending_url_docs.clear()
        if pending_link_docs and (force or len(pending_link_docs) >= flush_every * 4):
            link_batch = list(pending_link_docs)
            pending_link_docs.clear()
        if url_batch is not None:
            await _storage(st.insert_seo_audit_urls_bulk, url_batch)
        if link_batch is not None:
            await _storage(st.insert_seo_audit_links_bulk, link_batch)

    semaphore = asyncio.Semaphore(max(1, concurrency_per_host))
    last_progress = time.monotonic()

    async def _process_one(item: _FrontierItem) -> None:
        nonlocal last_progress
        async with semaphore:
            if respect_robots and rp is not None and not robots_mod.can_fetch(rp, user_agent, item.url):
                counts.blocked += 1
                counts.queued -= 1
                counts.indexability_breakdown["blocked"] += 1
                url_id = secrets.token_hex(12)
                url_id_by_normalized[item.normalized_url] = url_id
                pending_url_docs.append(
                    {
                        "id": url_id, "audit_id": audit_id, "fetched_at": _now_iso(), "url": item.url, "normalized_url": item.normalized_url,
                        "encoded_url": item.normalized_url, "discovered_from": item.discovered_from,
                        "discovery_type": item.discovery_type, "crawl_depth": item.depth, "folder_depth": folder_depth(item.url),
                        "content_type": None, "status_code": None, "status_text": None,
                        "indexability": "blocked", "indexability_reason": "Disallowed by robots.txt",
                        "title": None, "title_length": None, "meta_description": None, "meta_description_length": None,
                        "h1": None, "h1_count": 0, "h2": None, "h2_count": 0,
                        "canonical": None, "robots_meta": None, "x_robots_tag": None,
                        "word_count": None, "response_time_ms": None,
                        "redirect_url": None, "redirect_type": None, "redirect_hop_count": 0,
                    }
                )
                return

            result = await fetch_url(client, item.url)
            counts.fetched += 1
            counts.queued -= 1
            url_id = secrets.token_hex(12)
            url_id_by_normalized[item.normalized_url] = url_id

            if result.error:
                counts.failed += 1
                counts.indexability_breakdown["unknown"] += 1
                pending_url_docs.append(
                    {
                        "id": url_id, "audit_id": audit_id, "fetched_at": _now_iso(), "url": item.url, "normalized_url": item.normalized_url,
                        "encoded_url": item.normalized_url, "discovered_from": item.discovered_from,
                        "discovery_type": item.discovery_type, "crawl_depth": item.depth, "folder_depth": folder_depth(item.url),
                        "content_type": None, "status_code": None, "status_text": result.error,
                        "indexability": "unknown", "indexability_reason": result.error,
                        "title": None, "title_length": None, "meta_description": None, "meta_description_length": None,
                        "h1": None, "h1_count": 0, "h2": None, "h2_count": 0,
                        "canonical": None, "robots_meta": None, "x_robots_tag": None,
                        "word_count": None, "response_time_ms": None,
                        "redirect_url": None, "redirect_type": None, "redirect_hop_count": 0,
                    }
                )
                return

            is_html = "html" in (result.content_type or "").lower()
            # `result.final_url` is the actual destination after following the chain --
            # `redirect_chain[-1].url` (the previous, now-fixed bug) is the *source* of the
            # last hop, not where it landed, which meant every redirected page reported
            # itself as its own "destination".
            redirect_url = result.final_url if result.redirect_chain and result.final_url != item.url else None
            redirect_type = str(result.redirect_chain[0].status_code) if result.redirect_chain else None
            x_robots = result.headers.get("x-robots-tag")

            parsed = parse_html(result.body, result.final_url) if (is_html and result.body) else None

            indexability, reason = _compute_indexability(
                status_code=result.status_code,
                robots_blocked=False,
                meta_robots=parsed.meta_robots if parsed else None,
                x_robots_tag=x_robots,
                canonical=parsed.canonical if parsed else None,
                page_url=item.url,
                redirect_url=redirect_url,
            )

            pending_url_docs.append(
                {
                    "id": url_id, "audit_id": audit_id, "fetched_at": _now_iso(), "url": item.url, "normalized_url": item.normalized_url,
                    "encoded_url": item.normalized_url, "discovered_from": item.discovered_from,
                    "discovery_type": item.discovery_type, "crawl_depth": item.depth, "folder_depth": folder_depth(item.url),
                    "content_type": result.content_type, "status_code": result.status_code, "status_text": result.status_text,
                    "indexability": indexability, "indexability_reason": reason,
                    "title": parsed.title if parsed else None,
                    "title_length": len(parsed.title) if (parsed and parsed.title) else None,
                    "title_count": parsed.title_count if parsed else 0,
                    "meta_description": parsed.meta_description if parsed else None,
                    "meta_description_length": len(parsed.meta_description) if (parsed and parsed.meta_description) else None,
                    "meta_description_count": parsed.meta_description_count if parsed else 0,
                    "h1": parsed.h1 if parsed else None, "h1_count": parsed.h1_count if parsed else 0,
                    "h2": parsed.h2 if parsed else None, "h2_count": parsed.h2_count if parsed else 0,
                    "canonical": parsed.canonical if parsed else None,
                    "robots_meta": parsed.meta_robots if parsed else None,
                    "x_robots_tag": x_robots,
                    "word_count": parsed.word_count if parsed else None,
                    "response_time_ms": result.response_time_ms,
                    "redirect_url": redirect_url, "redirect_type": redirect_type, "redirect_hop_count": len(result.redirect_chain),
                }
            )
            if redirect_url:
                counts.redirects += 1
            if isinstance(result.status_code, int) and result.status_code >= 400:
                counts.broken_links += 1
            if indexability in counts.indexability_breakdown:
                counts.indexability_breakdown[indexability] += 1
            else:
                counts.indexability_breakdown["unknown"] += 1

            if not parsed:
                return

            for link in parsed.links:
                target_norm = normalize_url(link.href)
                if not target_norm:
                    continue
                internal = same_scope(target_norm, seed_host or "")
                if internal:
                    counts.internal += 1
                else:
                    counts.external += 1
                pending_link_docs.append(
                    {
                        "audit_id": audit_id, "source_url_id": url_id, "target_url_id": None,
                        "target_url": target_norm, "type": "anchor", "anchor_text": link.anchor_text[:300],
                        "rel": link.rel, "followable": not link.nofollow, "discovered_in": "raw_html",
                    }
                )
                if not internal or target_norm in visited or _looks_non_html(target_norm):
                    continue
                if counts.discovered >= max_urls:
                    continue
                visited.add(target_norm)
                counts.discovered += 1
                counts.queued += 1
                frontier.append(_FrontierItem(url=target_norm, normalized_url=target_norm, discovered_from=item.url, discovery_type="raw_html", depth=item.depth + 1))

            if len(pending_url_docs) >= flush_every or len(pending_link_docs) >= flush_every * 4:
                await _flush()
            now = time.monotonic()
            if now - last_progress >= progress_every_seconds:
                last_progress = now
                try:
                    await _storage(st.update_seo_audit_fields, audit_id, {"counts": _counts_dict(counts)})
                except Exception:
                    pass

    # Drain the frontier level-by-level: pull everything currently queued, run it
    # concurrently (bounded by the semaphore), then re-check what got appended.
    while frontier:
        if should_cancel and await _storage(should_cancel):
            break
        if time.monotonic() - started_at > max_duration_seconds:
            break
        batch = []
        while frontier:
            batch.append(frontier.popleft())
        await asyncio.gather(*(_process_one(item) for item in batch))

    await _flush(force=True)
    return _counts_dict(counts)


def _counts_dict(c: CrawlCounts) -> dict[str, Any]:
    return {
        "discovered": c.discovered, "fetched": c.fetched, "queued": max(0, c.queued), "blocked": c.blocked, "failed": c.failed,
        "internal": c.internal, "external": c.external, "broken_links": c.broken_links, "redirects": c.redirects,
        "indexability_breakdown": dict(c.indexability_breakdown),
    }
