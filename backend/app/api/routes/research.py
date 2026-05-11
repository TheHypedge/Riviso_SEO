from __future__ import annotations

import asyncio
import hashlib
import json
import random
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.core.deps import get_current_user
from app.core.ids import user_ids_equal
from app.legacy.storage import get_legacy_storage_module
from app.schemas.research import ResearchIdeasRequest, ResearchIdeasResponse
from app.services.research_ideas import generate_research_ideas
from app.services.research_scraper import extract_serp, fetch_google_serp_html
from app.services.to_thread import run_sync

router = APIRouter(prefix="/projects/{project_id}/research", tags=["research"])


def _normalize_title_key(s: str) -> str:
    # Align with other duplicate logic: NFKC + casefold (Python-side approximation for casefold)
    t = (s or "").strip()
    if not t:
        return ""
    try:
        t = t.encode("utf-8", errors="ignore").decode("utf-8", errors="ignore")
    except Exception:
        pass
    return t.casefold()


def _require_project_access(*, st, user: dict, project_id: str) -> dict:
    pid = (project_id or "").strip()
    proj = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role != "admin" and not user_ids_equal((proj.get("owner_user_id") or "").strip(), uid):
        raise HTTPException(status_code=404, detail="Project not found")
    return proj


def _plan_for_user(*, st, user: dict) -> tuple[str, dict[str, Any]]:
    plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
    try:
        plans = st.load_plans() or {}
        plan = plans.get(plan_key) if isinstance(plans, dict) else {}
        if not isinstance(plan, dict):
            plan = {}
    except Exception:
        plan = {}
    return plan_key, plan


def _enforce_custom_research_quota(*, st, user: dict) -> None:
    if (user.get("role") or "").strip().lower() == "admin":
        return
    plan_key, plan = _plan_for_user(st=st, user=user)
    if not hasattr(st, "consume_custom_research_usage"):
        return
    ok, msg = st.consume_custom_research_usage(
        (user.get("id") or "").strip(),
        month_limit=plan.get("max_custom_research_per_month"),
        amount=1,
    )
    if not ok:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "quota_exceeded",
                "feature": "custom_research",
                "plan_key": plan_key,
                "message": msg or "Monthly Custom Curations limit reached for your plan.",
            },
        )


def _existing_title_and_keyphrase_sets(*, st, project_id: str) -> tuple[set[str], set[str]]:
    """
    Return normalized sets for de-duping research output against existing content.
    """
    pid = (project_id or "").strip()
    titles: set[str] = set()
    keyphrases: set[str] = set()
    if not pid:
        return titles, keyphrases
    # Prefer listing without full bodies when available.
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
        if not isinstance(a, dict):
            continue
        if (a.get("project_id") or "").strip() != pid:
            continue
        t = _normalize_title_key(str(a.get("title") or ""))
        if t:
            titles.add(t)
        fk = _normalize_title_key(str(a.get("focus_keyphrase") or ""))
        if fk:
            keyphrases.add(fk)
    return titles, keyphrases


@router.post("/ideas", response_model=ResearchIdeasResponse)
async def research_ideas(
    project_id: str,
    payload: ResearchIdeasRequest,
    user: dict = Depends(get_current_user),
) -> ResearchIdeasResponse:
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)

    seeds = [str(x).strip() for x in (payload.seed_keywords or []) if str(x).strip()]
    seeds = seeds[:25]
    if not seeds:
        raise HTTPException(status_code=400, detail="seed_keywords is required")

    brand_niche = (payload.brand_niche or "").strip()
    intent = str(payload.intent or "informational")
    tone = str(payload.tone or "professional")
    gl = (payload.country or "US").strip()[:8] or "US"
    hl = (payload.language or "en").strip()[:8] or "en"
    max_ideas = int(payload.max_ideas or 30)

    # Pull some project history to improve stability/consistency.
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

    # Fast path cache for repeated runs with same inputs.
    cache_key = hashlib.sha256(
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
    if hasattr(st, "get_research_cache"):
        try:
            cached = st.get_research_cache(cache_key=cache_key, max_age_s=6 * 60 * 60)
        except Exception:
            cached = None
        if isinstance(cached, dict) and isinstance(cached.get("ideas"), list):
            return ResearchIdeasResponse(
                ok=True,
                ideas=cached.get("ideas") or [],
                keyword_analysis=cached.get("keyword_analysis") if isinstance(cached.get("keyword_analysis"), dict) else None,
                scraped_queries=cached.get("scraped_queries") if isinstance(cached.get("scraped_queries"), list) else [],
                used_history_count=int(cached.get("used_history_count") or 0),
            )

    # Count only real generation/cache-miss requests. Cached repeats stay free,
    # but every new LLM-backed Custom Curation run is capped monthly by plan.
    _enforce_custom_research_quota(st=st, user=user)

    # Scrape SERPs concurrently (best-effort). If some fail, continue with what we have.
    sem = asyncio.Semaphore(3)

    async def _one(q: str) -> dict[str, Any] | None:
        try:
            async with sem:
                # Gentle jitter to reduce burstiness (helps avoid temporary blocks).
                await asyncio.sleep(random.uniform(0.15, 0.55))
            html = await fetch_google_serp_html(query=q, gl=gl, hl=hl, timeout_s=12.0)
            ext = extract_serp(query=q, gl=gl, hl=hl, html=html)
            snap = {
                "project_id": project_id,
                "user_id": (user.get("id") or "").strip(),
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

    existing_titles, existing_fk = await run_sync(_existing_title_and_keyphrase_sets, st=st, project_id=project_id)

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

    # Filter out ideas that already exist in the project (title OR focus keyphrase).
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

    resp = ResearchIdeasResponse(
        ok=True,
        ideas=filtered,
        keyword_analysis=keyword_analysis if isinstance(keyword_analysis, dict) else None,
        scraped_queries=scraped_queries,
        used_history_count=len(history or []) + len(idea_runs or []),
    )

    # Persist run + cache (best-effort).
    if hasattr(st, "save_research_ideas_run"):
        try:
            await run_sync(
                st.save_research_ideas_run,
                {
                    "id": str(hashlib.sha256(f"{project_id}:{cache_key}".encode("utf-8")).hexdigest()),
                    "project_id": project_id,
                    "user_id": (user.get("id") or "").strip(),
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
        try:
            await run_sync(
                st.set_research_cache,
                cache_key=cache_key,
                value={
                    "ideas": filtered,
                    "keyword_analysis": keyword_analysis if isinstance(keyword_analysis, dict) else None,
                    "scraped_queries": scraped_queries,
                    "used_history_count": resp.used_history_count,
                },
            )
        except Exception:
            pass

    return resp

