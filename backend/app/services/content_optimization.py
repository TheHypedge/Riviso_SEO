"""
Per-project content optimization profile blocks injected into the generation system prompt.

Each profile adds a short, authoritative set of structural requirements placed after the
banned-phrases block in ``build_generation_messages()``.  The instructions carry the same
weight as other system-prompt rules so they are not overridden by the user's writing prompt.

Profiles are mutually exclusive (one per project).  "none" returns an empty string so the
existing generation behaviour is unchanged for projects that have not opted in.
"""

from __future__ import annotations

_SEO_BLOCK = """
---
CONTENT OPTIMIZATION — SEO MODE (applies to this article):
- The focus keyphrase MUST appear in the H1 title, at least one H2 heading, and the opening paragraph.
- Use a clear H2 → H3 heading hierarchy; each H2 maps to one distinct sub-topic.
- Keep body paragraphs to 2–4 sentences; use numbered lists for sequential steps.
- The meta_title must include the focus keyphrase near the start (≤60 characters total).
- The meta_description must include the focus keyphrase and be 120–155 characters.
- DO NOT label any heading with "SEO-Optimized", "Keyword-Rich", or similar tags.
---
"""

_AEO_BLOCK = """
---
CONTENT OPTIMIZATION — AEO MODE (applies to this article):
- Include a "Frequently Asked Questions" section near the end of the article.
- The FAQ section must contain at least 4 items. Format: H3 question → 1–3 sentence direct answer.
- Open each major section with a direct, complete-sentence answer before expanding with context (inverted pyramid).
- Answers must be self-contained complete sentences suitable for extraction as a featured snippet.
- Write concise, precise answers — avoid vague hedges like "it depends" as the opening phrase.
- Question headings must be plain reader-facing questions. NEVER append labels like "(AEO-Optimized)", "(Featured Snippet)", or similar.
---
"""

_GEO_BLOCK = """
---
CONTENT OPTIMIZATION — GEO MODE (applies to this article):
- Write for AI answer engine retrieval (Google AI Overviews, Perplexity, AI-powered search).
- Include specific named entities: real people, organisations, places, dates, and statistics with context.
- Every major factual claim must be a self-contained statement (complete subject + predicate + qualifier).
- Include at least one precise statistic, named study, or verifiable reference for every 300 words of body copy.
- Use structured factual lists where appropriate. Avoid vague quantifiers like "many", "some", "various".
- Do not fabricate statistics, names, or citations — use only well-known, verifiable information.
---
"""

_EEAT_BLOCK = """
---
CONTENT OPTIMIZATION — E-E-A-T MODE (applies to this article):
- Demonstrate first-hand experience or professional expertise: use grounded signals like "in practice", "based on real cases", or concrete observations.
- Cite at least two specific named sources, recognised organisations, or published studies per article (do not fabricate — use only well-known, verifiable references).
- Include a section that acknowledges potential limitations, counterpoints, or edge cases — this signals balanced expertise.
- Every major claim must be attributable to a named professional, organisation, regulation, or published study.
- End with a trust signal: a professional context, real-world application example, or verifiable credential reference.
- Do not use vague authority phrases like "experts say" or "studies show" without naming the source.
---
"""

_BLOCKS: dict[str, str] = {
    "seo": _SEO_BLOCK,
    "aeo": _AEO_BLOCK,
    "geo": _GEO_BLOCK,
    "eeat": _EEAT_BLOCK,
}

VALID_PROFILES: frozenset[str] = frozenset({"none", "seo", "aeo", "geo", "eeat"})


def build_optimization_profile_block(profile: str | None) -> str:
    """
    Return the system-prompt block for the given optimization profile.

    Returns an empty string for ``"none"`` or unknown values so the caller can
    unconditionally concatenate the result without branching.
    """
    key = (profile or "none").strip().lower()
    return _BLOCKS.get(key, "")
