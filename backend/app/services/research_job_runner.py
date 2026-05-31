"""Background research-ideas pipeline (SERP scrape + LLM curation)."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import random
from datetime import datetime
from typing import Any

from app.legacy.storage import get_legacy_storage_module
from app.services.research_ideas import generate_research_ideas
from app.services.research_scraper import extract_serp, fetch_google_serp_html
from app.services.to_thread import run_sync

log = logging.getLogger(__name__)


def _normalize_title_key(s: str) -> str:
    t = (s or "").strip()
    if not t:
        return ""
    try:
        t = t.encode("utf-8", errors="ignore").decode("utf-8", errors="ignore")
    except Exception:
        pass
    return t.casefold()


def _existing_title_and_keyphrase_sets(*, st, project_id: str) -> tuple[set[str], set[str]]:
    pid = (project_id or "").strip()
    titles: set[str] = set()
    keyphrases: set[str] = set()
    if not pid:
        return titles, keyphrases
    rows: list[dict[str, Any]] = []
    if hasattr(st, "load_articles_listing_for_project"):
        try:
            rows = st.load_articles_listing_for_project(pid, limit=20000) or []
        except Exception:
            rows = []
    if not rows:
        try:
            rows = st.load_articles() or []
        except Exception:
            rows = []
    for a in rows:
        if not isinstance(a, dict) or (a.get("project_id") or "").strip() != pid:
            continue
        t = _normalize_title_key(str(a.get("title") or ""))
        if t:
            titles.add(t)
        fk = _normalize_title_key(str(a.get("focus_keyphrase") or ""))
        if fk:
            keyphrases.add(fk)
    return titles, keyphrases


def build_research_cache_key(
    *,
    project_id: str,
    brand_niche: str,
    intent: str,
    tone: str,
    seeds: list[str],
    gl: str,
    hl: str,
    max_ideas: int,
) -> str:
    return hashlib.sha256(
        json.dumps(
            {
                "project_id": project_id,
                "brand_niche": brand_niche,
                "intent": intent,
                "tone": tone,
                "seeds": seeds,
                "gl": gl,
                "hl": hl,
                "max_ideas": max_ideas,
            },
            sort_keys=True,
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()


async def _set_cache_status(*, cache_key: str, patch: dict[str, Any]) -> None:
    st = get_legacy_storage_module()
    if not hasattr(st, "set_research_cache"):
        return
    existing: dict[str, Any] = {}
    if hasattr(st, "get_research_job_status"):
        row = st.get_research_job_status(cache_key=cache_key)
        if isinstance(row, dict):
            existing = dict(row)
    merged = {**existing, **patch}
    await run_sync(st.set_research_cache, cache_key=cache_key, value=merged)


async def execute_research_ideas(payload: dict[str, Any]) -> dict[str, Any]:
    """Run SERP + LLM curation and return the response payload (no cache writes)."""
    st = get_legacy_storage_module()
    project_id = (payload.get("project_id") or "").strip()
    user_id = (payload.get("user_id") or "").strip()
    brand_niche = (payload.get("brand_niche") or "").strip()
    intent = str(payload.get("intent") or "informational")
    tone = str(payload.get("tone") or "professional")
    seeds = [str(x).strip() for x in (payload.get("seed_keywords") or []) if str(x).strip()][:25]
    gl = (payload.get("country") or "US").strip()[:8] or "US"
    hl = (payload.get("language") or "en").strip()[:8] or "en"
    max_ideas = int(payload.get("max_ideas") or 30)

    history: list[dict[str, Any]] = []
    if hasattr(st, "load_research_serp_history"):
        try:
            history = st.load_research_serp_history(project_id=project_id, limit=50) or []
        except Exception:
            history = []
    idea_runs: list[dict[str, Any]] = []
    if hasattr(st, "load_research_ideas_runs"):
        try:
            idea_runs = st.load_research_ideas_runs(project_id=project_id, limit=20) or []
        except Exception:
            idea_runs = []

    sem = asyncio.Semaphore(3)

    async def _one(q: str) -> dict[str, Any] | None:
        try:
            async with sem:
                await asyncio.sleep(random.uniform(0.15, 0.55))
            html = await fetch_google_serp_html(query=q, gl=gl, hl=hl, timeout_s=12.0)
            ext = extract_serp(query=q, gl=gl, hl=hl, html=html)
            snap = {
                "project_id": project_id,
                "user_id": user_id,
                "query": ext.query,
                "gl": ext.gl,
                "hl": ext.hl,
                "fetched_at": float(ext.fetched_at),
                "html_sha256": ext.html_sha256,
                "results": ext.results,
                "related_searches": ext.related_searches,
                "created_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
            }
            if hasattr(st, "save_research_serp_snapshot"):
                try:
                    await run_sync(st.save_research_serp_snapshot, snap)
                except Exception:
                    pass
            return snap
        except Exception:
            return None

    tasks = [_one(q) for q in seeds[:8]]
    snaps = [s for s in (await asyncio.gather(*tasks)) if isinstance(s, dict)]
    scraped_queries = [str(s.get("query") or "").strip() for s in snaps if str(s.get("query") or "").strip()]

    existing_titles, existing_fk = await run_sync(
        _existing_title_and_keyphrase_sets,
        st=st,
        project_id=project_id,
    )

    gen = await generate_research_ideas(
        brand_niche=brand_niche,
        intent=intent,
        tone=tone,
        seed_keywords=seeds,
        serp_blobs=snaps,
        history_blobs=(history or []) + (idea_runs or []),
        max_ideas=max_ideas,
    )
    ideas = gen.get("ideas") if isinstance(gen, dict) else []
    keyword_analysis = gen.get("keyword_analysis") if isinstance(gen, dict) else None

    filtered: list[dict[str, Any]] = []
    seen_title: set[str] = set()
    seen_fk: set[str] = set()
    for it in ideas:
        if not isinstance(it, dict):
            continue
        title = (it.get("title") or "").strip()
        fk = (it.get("focus_keyphrase") or "").strip()
        if not title or not fk:
            continue
        tkey = _normalize_title_key(title)
        fkkey = _normalize_title_key(fk)
        if not tkey or not fkkey:
            continue
        if tkey in existing_titles or fkkey in existing_fk:
            continue
        if tkey in seen_title or fkkey in seen_fk:
            continue
        seen_title.add(tkey)
        seen_fk.add(fkkey)
        filtered.append(it)
        if len(filtered) >= max(5, min(max_ideas, 80)):
            break

    return {
        "ideas": filtered,
        "keyword_analysis": keyword_analysis if isinstance(keyword_analysis, dict) else None,
        "scraped_queries": scraped_queries,
        "used_history_count": len(history or []) + len(idea_runs or []),
    }


async def persist_research_ideas_result(
    *,
    project_id: str,
    user_id: str,
    cache_key: str,
    brand_niche: str,
    intent: str,
    tone: str,
    seeds: list[str],
    gl: str,
    hl: str,
    result: dict[str, Any],
) -> None:
    st = get_legacy_storage_module()
    filtered = result.get("ideas") if isinstance(result.get("ideas"), list) else []
    keyword_analysis = result.get("keyword_analysis")
    scraped_queries = result.get("scraped_queries") if isinstance(result.get("scraped_queries"), list) else []

    if hasattr(st, "save_research_ideas_run"):
        try:
            await run_sync(
                st.save_research_ideas_run,
                {
                    "id": str(hashlib.sha256(f"{project_id}:{cache_key}".encode("utf-8")).hexdigest()),
                    "project_id": project_id,
                    "user_id": user_id,
                    "brand_niche": brand_niche,
                    "intent": intent,
                    "tone": tone,
                    "seed_keywords": seeds,
                    "gl": gl,
                    "hl": hl,
                    "ideas": filtered,
                    "keyword_analysis": keyword_analysis if isinstance(keyword_analysis, dict) else None,
                    "scraped_queries": scraped_queries,
                    "created_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                },
            )
        except Exception:
            pass
    if hasattr(st, "set_research_cache"):
        await run_sync(st.set_research_cache, cache_key=cache_key, value=result)


async def run_research_ideas_job(payload: dict[str, Any]) -> None:
    """Execute SERP + LLM research curation and persist cache + run history."""
    cache_key = (payload.get("cache_key") or "").strip()
    project_id = (payload.get("project_id") or "").strip()
    if not project_id or not cache_key:
        return

    await _set_cache_status(cache_key=cache_key, patch={"status": "processing"})
    try:
        result = await execute_research_ideas(payload)
        await persist_research_ideas_result(
            project_id=project_id,
            user_id=(payload.get("user_id") or "").strip(),
            cache_key=cache_key,
            brand_niche=(payload.get("brand_niche") or "").strip(),
            intent=str(payload.get("intent") or "informational"),
            tone=str(payload.get("tone") or "professional"),
            seeds=[str(x).strip() for x in (payload.get("seed_keywords") or []) if str(x).strip()],
            gl=(payload.get("country") or "US").strip()[:8] or "US",
            hl=(payload.get("language") or "en").strip()[:8] or "en",
            result=result,
        )
    except Exception:
        log.exception("Research ideas job failed cache_key=%s project_id=%s", cache_key, project_id)
        await _set_cache_status(
            cache_key=cache_key,
            patch={"status": "error", "message": "Research curation failed. Try again shortly."},
        )
