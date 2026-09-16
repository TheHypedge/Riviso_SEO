"""
Orchestrates one AI Citation Tracking run: prompts -> engines -> detection -> storage.

`build_queued_cells` is called by the route (POST /run) to fan prompts x engines
out into queued check-cell docs. `run_cell` is called by the worker
(ai_citation_worker.py) once per claimed cell to actually call the one engine
adapter it names and run brand-citation detection against the result.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine

from app.core.config import settings
from app.services.ai_citation import gemini_engine, google_ai_overview_engine, openai_engine, perplexity_engine
from app.services.ai_citation.detection import detect_citation
from app.services.ai_citation.engine_types import EngineResult
from app.services.site_audit.website import resolve_project_website_url

_ENGINE_CHECKS: dict[str, Callable[[str], Coroutine[Any, Any, EngineResult]]] = {
    openai_engine.ENGINE: openai_engine.check,
    perplexity_engine.ENGINE: perplexity_engine.check,
    gemini_engine.ENGINE: gemini_engine.check,
    google_ai_overview_engine.ENGINE: google_ai_overview_engine.check,
}

ALL_ENGINES: tuple[str, ...] = tuple(_ENGINE_CHECKS.keys())


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def enabled_engines() -> list[str]:
    """Engines that are both feature-flagged on AND have whatever key/config they
    need -- e.g. ChatGPT works day one on the existing OPENAI_API_KEY; Perplexity/
    Gemini stay excluded until their keys are set."""
    out: list[str] = []
    if settings.ai_citation_chatgpt_enabled and (settings.openai_api_key or "").strip():
        out.append(openai_engine.ENGINE)
    if settings.ai_citation_perplexity_enabled and (settings.perplexity_api_key or "").strip():
        out.append(perplexity_engine.ENGINE)
    if settings.ai_citation_gemini_enabled and (settings.gemini_api_key or "").strip():
        out.append(gemini_engine.ENGINE)
    if settings.ai_citation_google_ai_overview_enabled:
        out.append(google_ai_overview_engine.ENGINE)
    return out


def build_queued_cells(*, project_id: str, prompts: list[dict[str, str]], engines: list[str]) -> tuple[str, list[dict[str, Any]]]:
    """Returns (run_id, cell_docs) for the given prompts x engines -- caller
    persists via storage.create_ai_citation_checks_bulk."""
    run_id = secrets.token_hex(12)
    now = _now_iso()
    cells: list[dict[str, Any]] = []
    for engine in engines:
        if engine not in _ENGINE_CHECKS:
            continue
        for p in prompts:
            cells.append(
                {
                    "id": secrets.token_hex(16),
                    "run_id": run_id,
                    "project_id": project_id,
                    "engine": engine,
                    "prompt": p["prompt"],
                    "keyword": p.get("keyword", ""),
                    "keyword_source": p.get("keyword_source", ""),
                    "status": "queued",
                    "queued_at": now,
                    "started_at": None,
                    "completed_at": None,
                    "response_text": None,
                    "cited": False,
                    "match_type": None,
                    "matched_snippet": None,
                    "citation_urls": [],
                    "error": None,
                }
            )
    return run_id, cells


async def run_cell(cell: dict[str, Any], proj: dict[str, Any]) -> dict[str, Any]:
    """Executes one claimed check cell's engine call + detection. Returns the
    `$set` fields for storage.update_ai_citation_check_fields -- never raises,
    a failed engine call becomes status="failed" with `error` set."""
    engine = (cell.get("engine") or "").strip()
    check_fn = _ENGINE_CHECKS.get(engine)
    if check_fn is None:
        return {"status": "failed", "completed_at": _now_iso(), "error": f"Unknown engine: {engine}"}

    try:
        result = await check_fn(cell.get("prompt") or "")
    except Exception as e:  # belt-and-braces -- adapters already catch their own transport errors
        return {"status": "failed", "completed_at": _now_iso(), "error": str(e)}

    if result.error and not result.response_text:
        return {"status": "failed", "completed_at": _now_iso(), "error": result.error}

    domain = resolve_project_website_url(proj) or ""
    brand = (proj.get("name") or "").strip()
    detection = detect_citation(
        response_text=result.response_text,
        citation_urls=result.citation_urls,
        project_domain=domain,
        brand_name=brand,
    )
    return {
        "status": "done",
        "completed_at": _now_iso(),
        "response_text": (result.response_text or "")[:8000],
        "citation_urls": result.citation_urls or [],
        "cited": detection.cited,
        "match_type": detection.match_type,
        "matched_snippet": detection.matched_snippet,
        "error": None,
    }
