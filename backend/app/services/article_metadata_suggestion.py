"""
Lightweight AI metadata suggestion for the Add Article modal.

Unlike ``research_ideas.py`` (SERP-backed, multi-idea, quota-gated), these are
single direct ``chat_json`` calls with no SERP scrape and no ``generation_slot()``
— the same "cheap, synchronous, unguarded" class of work as the Research ideas
endpoint's underlying LLM call, just simpler (one result, no history/avoid-list).
"""

from __future__ import annotations

import json
from typing import Any

from app.core.config import settings
from app.services.generation_blocklist import strip_em_dashes
from app.services.openai_client import OpenAIClient
from app.services.title_humanization_guardrail import (
    format_title_ban_list_for_prompt,
    humanize_planning_title,
)


def _clamp_list(xs: list[str], n: int) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for x in xs:
        t = " ".join((x or "").strip().split())
        if not t:
            continue
        k = t.casefold()
        if k in seen:
            continue
        seen.add(k)
        out.append(t)
        if len(out) >= n:
            break
    return out


def _to_kw_list(v: Any) -> list[str]:
    if isinstance(v, list):
        return _clamp_list([str(x) for x in v], 10)
    if isinstance(v, str):
        return _clamp_list([p.strip() for p in v.replace("\n", ",").split(",")], 10)
    return []


def _coerce_metadata(obj: dict[str, Any]) -> dict[str, Any]:
    title = " ".join(str(obj.get("title") or "").strip().split())[:500]
    title = humanize_planning_title(title, role="research", keyword_fallback=title)
    focus = strip_em_dashes(" ".join(str(obj.get("focus_keyphrase") or "").strip().split()))[:500]
    keywords = [strip_em_dashes(k) for k in _to_kw_list(obj.get("keywords"))]
    return {"title": title, "focus_keyphrase": focus, "keywords": keywords}


async def suggest_metadata_from_idea(*, idea: str) -> dict[str, Any]:
    """Expand a rough keyword/idea/sentence into {title, focus_keyphrase, keywords}."""
    client = OpenAIClient()
    system = (
        "You are an SEO strategist. Given a rough idea, keyword, or sentence from a user, "
        "produce the single best semantic, high-search-intent article title plus supporting "
        "SEO metadata.\n"
        "Return ONLY JSON: "
        '{"title": string, "focus_keyphrase": string, "keywords": [string]}.\n'
        "- Title: clear, high-intent, non-clickbait, sounds editor-picked (not a generic "
        "auto-generated SEO template). <= 90 characters.\n"
        "- focus_keyphrase: 2-6 words, the primary search phrase this article should rank for.\n"
        "- keywords: 5-10 unique supporting terms, no duplicates of the focus keyphrase.\n"
        f"{format_title_ban_list_for_prompt()}"
    )
    user = json.dumps({"idea": idea.strip()[:500]}, ensure_ascii=False)
    obj = await client.chat_json(model=settings.openai_text_model, system=system, user=user)
    return _coerce_metadata(obj if isinstance(obj, dict) else {})


async def suggest_metadata_from_source_content(*, extracted_title: str, extracted_text: str) -> dict[str, Any]:
    """Derive {title, focus_keyphrase, keywords} for a faithful rewrite of the given source
    content — same specific subject and information as the source, not a broader/looser topic."""
    client = OpenAIClient()
    system = (
        "You are an SEO strategist. You are given the extracted title and body text of an "
        "existing web page. This article will be faithfully rewritten in original wording, "
        "preserving all of the source's facts and information — so the title/keyphrase/keywords "
        "must target the exact same specific subject as the source, not a broader or different angle.\n"
        "Produce the best semantic, high-search-intent Title + Focus Keyphrase + supporting Keywords "
        "for that rewrite.\n"
        "Return ONLY JSON: "
        '{"title": string, "focus_keyphrase": string, "keywords": [string]}.\n'
        "- Title: clear, high-intent, non-clickbait, accurately reflects the source's specific subject. <= 90 characters.\n"
        "- focus_keyphrase: 2-6 words.\n"
        "- keywords: 5-10 unique supporting terms.\n"
        f"{format_title_ban_list_for_prompt()}"
    )
    user = json.dumps(
        {"source_title": extracted_title.strip()[:300], "source_content": extracted_text.strip()[:8000]},
        ensure_ascii=False,
    )
    obj = await client.chat_json(model=settings.openai_text_model, system=system, user=user)
    return _coerce_metadata(obj if isinstance(obj, dict) else {})
