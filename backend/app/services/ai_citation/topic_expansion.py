"""
LLM-based keyword expansion -- once a project's own articles/topic clusters run
out of new keywords to check (a finite, content-bound pool), this generates
additional realistic search-query-style topics for the brand's niche so
citation-check coverage keeps growing instead of plateauing at whatever the
project happened to already write about. Reuses OPENAI_API_KEY (the same key
article generation and the ChatGPT citation engine use) -- no new dependency.

Grounded in the project's own seed keywords (a sample of what it already
covers) so expansion stays topically relevant instead of drifting into
generic filler, and explicitly told what's already been used so it doesn't
just regenerate near-duplicates of existing coverage.
"""

from __future__ import annotations

import logging

from app.core.config import settings
from app.services.openai_client import OpenAIClient

log = logging.getLogger(__name__)

_SEED_SAMPLE_SIZE = 15
_EXCLUDE_SAMPLE_SIZE = 200


async def expand_keywords(
    *,
    brand_name: str,
    website_domain: str,
    seed_keywords: list[str],
    exclude: set[str],
    count: int,
) -> list[str]:
    """Returns up to `count` new keywords, deduped against `exclude` (already
    casefolded). Returns [] on any failure -- this is a best-effort supplement,
    never something that should break a citation-check run if it fails."""
    if count <= 0:
        return []
    try:
        client = OpenAIClient()
    except RuntimeError:
        return []

    seed_sample = seed_keywords[:_SEED_SAMPLE_SIZE]
    system = (
        "You generate realistic, distinct search-query-style topics/keywords for a brand's niche, "
        "used to test whether AI answer engines mention the brand when asked about related subjects. "
        "Stay closely relevant to the niche implied by the seed topics -- never invent unrelated subjects "
        "just to hit the count. Return strict JSON: {\"keywords\": [\"...\"]}."
    )
    user = (
        f"Brand: {brand_name or '(unknown)'}\n"
        f"Website: {website_domain or '(unknown)'}\n"
        f"Seed topics this brand already covers: {', '.join(seed_sample) or '(none yet)'}\n"
        f"Already used, do not repeat or closely paraphrase: {', '.join(sorted(exclude)[:_EXCLUDE_SAMPLE_SIZE]) or '(none)'}\n"
        f"Generate {count} new, distinct topics in the same niche."
    )
    try:
        obj = await client.chat_json(model=settings.openai_text_model, system=system, user=user)
    except Exception as e:
        log.warning("ai_citation: keyword expansion failed: %s", e)
        return []

    raw = obj.get("keywords") if isinstance(obj, dict) else None
    if not isinstance(raw, list):
        return []

    out: list[str] = []
    seen = set(exclude)
    for kw in raw:
        if not isinstance(kw, str):
            continue
        kw = kw.strip()
        key = kw.casefold()
        if not kw or key in seen:
            continue
        seen.add(key)
        out.append(kw)
        if len(out) >= count:
            break
    return out
