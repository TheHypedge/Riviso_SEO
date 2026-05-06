from __future__ import annotations

import json
import uuid
from typing import Any

from app.core.config import settings
from app.services.openai_client import OpenAIClient


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
        return _clamp_list([str(x) for x in v], 12)
    if isinstance(v, str):
        parts = [p.strip() for p in v.replace("\n", ",").split(",")]
        return _clamp_list(parts, 12)
    return []


async def generate_research_ideas(
    *,
    brand_niche: str,
    intent: str,
    tone: str,
    seed_keywords: list[str],
    serp_blobs: list[dict[str, Any]],
    history_blobs: list[dict[str, Any]],
    max_ideas: int,
) -> dict[str, Any]:
    """
    Convert SERP + user curation into structured research ideas.

    Returns a list of dicts with keys: title, focus_keyphrase, keywords, score?, rationale?
    """
    client = OpenAIClient()
    max_ideas_i = max(5, min(int(max_ideas or 30), 80))

    seeds = _clamp_list(seed_keywords, 25)
    serp_trim = serp_blobs[:8]
    hist_trim = history_blobs[:8]

    system = (
        "You are Riviso Research. Your job: generate SEO-focused article ideas.\n"
        "Return ONLY JSON, matching the required schema.\n"
        "Constraints:\n"
        "- Create unique, non-duplicative titles.\n"
        "- Each idea must have: title, focus_keyphrase, keywords.\n"
        "- focus_keyphrase should be 2-6 words.\n"
        "- keywords should be 5-10 supporting terms (no duplicates).\n"
        "- Keep titles concise (<= 90 chars) and clear.\n"
        "- Prefer high-intent, high-clarity, non-clickbait phrasing.\n"
    )

    user = {
        "brand_niche": brand_niche[:300],
        "intent": intent,
        "tone": tone,
        "seed_keywords": seeds,
        "serp": serp_trim,
        "history": hist_trim,
        "max_ideas": max_ideas_i,
        "output_schema": {
            "keyword_analysis": {
                "primary_topics": ["string"],
                "supporting_keywords": ["string"],
                "notes": "string (short)",
            },
            "ideas": [
                {
                    "title": "string",
                    "focus_keyphrase": "string",
                    "keywords": ["string"],
                    "score": "number (0-100, optional)",
                    "rationale": "string (optional, 1 sentence)",
                }
            ]
        },
    }

    obj = await client.chat_json(
        model=settings.openai_text_model,
        system=system,
        user=json.dumps(user, ensure_ascii=False),
    )
    ideas_in = obj.get("ideas")
    if not isinstance(ideas_in, list):
        return {"ideas": [], "keyword_analysis": None}

    out: list[dict[str, Any]] = []
    seen_title: set[str] = set()
    seen_fk: set[str] = set()
    for it in ideas_in:
        if not isinstance(it, dict):
            continue
        title = " ".join(str(it.get("title") or "").strip().split())[:500]
        fk = " ".join(str(it.get("focus_keyphrase") or "").strip().split())[:500]
        if not title or not fk:
            continue
        tkey = title.casefold()
        fkkey = fk.casefold()
        if tkey in seen_title or fkkey in seen_fk:
            continue
        seen_title.add(tkey)
        seen_fk.add(fkkey)
        kws = _to_kw_list(it.get("keywords"))[:10]
        score = it.get("score")
        score_f: float | None = None
        try:
            if score is not None:
                score_f = float(score)
        except Exception:
            score_f = None
        rationale = str(it.get("rationale") or "").strip()[:400] or None
        out.append(
            {
                "id": str(uuid.uuid4()),
                "title": title[:500],
                "focus_keyphrase": fk[:500],
                "keywords": kws,
                "score": score_f,
                "rationale": rationale,
            }
        )
        if len(out) >= max_ideas_i:
            break
    ka = obj.get("keyword_analysis")
    if not isinstance(ka, dict):
        ka = None
    return {"ideas": out, "keyword_analysis": ka}

