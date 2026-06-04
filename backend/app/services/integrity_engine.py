from __future__ import annotations

import time
from typing import Any

from app.services.riviso_grammar_engine import run_grammar_pipeline
from app.services.riviso_human_profile import polish_paragraph_natural
from app.services.riviso_linguistics import (
    AIDetectionAuditor,
    humanize_markdown_blocks,
    join_markdown_paragraphs,
    split_markdown_paragraphs,
)
from app.services.riviso_linguistics import _marker_hits
from app.services.riviso_paraphrase_engine import scrub_ai_markers

__all__ = [
    "AIDetectionAuditor",
    "execute_structural_humanization",
    "split_markdown_paragraphs",
    "join_markdown_paragraphs",
    "protected_terms_from_article",
]

_TARGET_AI_PCT = 6.0
_MAX_PASSES = 6


def protected_terms_from_article(article: dict | None) -> list[str]:
    if not article:
        return []
    terms: list[str] = []
    fk = (article.get("focus_keyphrase") or "").strip()
    if fk:
        terms.append(fk)
    for kw in article.get("keywords") or []:
        if isinstance(kw, str) and kw.strip():
            terms.append(kw.strip())
    title = (article.get("title") or "").strip()
    if title:
        terms.append(title)
    return terms


def _flagged_indices(audit: dict[str, Any]) -> list[int]:
    return [
        int(x.get("index"))
        for x in (audit.get("flagged_paragraphs") or [])
        if isinstance(x, dict) and "index" in x
    ]


def _grammar_finalize(text: str) -> str:
    return run_grammar_pipeline(scrub_ai_markers(text))


def _deep_polish(text: str, *, protected_terms: list[str] | None, strength: float) -> str:
    return run_grammar_pipeline(
        polish_paragraph_natural(scrub_ai_markers(text), protected_terms=protected_terms, strength=strength)
    )


async def execute_structural_humanization(
    *,
    md: str,
    flagged_indices: list[int] | None = None,
    protected_terms: list[str] | None = None,
    full_document: bool = True,
    max_passes: int = _MAX_PASSES,
    target_ai_pct: float = _TARGET_AI_PCT,
    initial_strength: float = 0.78,
) -> dict[str, Any]:
    """RIVISO full-document humanization — natural paraphrase, no repetitive filler.

    ``target_ai_pct`` and ``initial_strength`` can be overridden per-project via
    the project's ``humanization_settings`` so users can tune aggressiveness without
    touching the generation pipeline defaults.  Existing callers that don't pass
    these arguments continue to use the original hardcoded values.
    """
    paras = split_markdown_paragraphs(md)
    if not paras:
        return {"humanized_markdown": (md or ""), "rewritten": [], "full_document": full_document}

    if full_document:
        idxs = list(range(len(paras)))
    else:
        idxs = sorted({i for i in (flagged_indices or []) if isinstance(i, int) and 0 <= i < len(paras)})
    if not idxs:
        return {"humanized_markdown": (md or ""), "rewritten": [], "full_document": full_document}

    # Clamp strength to a sensible range regardless of caller input.
    _init_str = max(0.50, min(0.95, float(initial_strength)))
    # Strength cap scales with the initial value so presets don't all end at 0.90.
    _max_str = min(0.95, _init_str + 0.12)
    _target = max(0.0, float(target_ai_pct))
    # Deep-polish strength: slightly above initial, never above the cap.
    _polish_str = min(_max_str, _init_str + 0.07)

    start = time.perf_counter()
    auditor = AIDetectionAuditor()
    all_rewritten: list[dict[str, Any]] = []
    strength = _init_str
    current = list(paras)
    pass_num = 0
    final_ai = 100.0

    for pass_num in range(max(1, max_passes)):
        batch, rewritten = humanize_markdown_blocks(
            current,
            idxs,
            synonym_strength=strength,
            protected_terms=protected_terms,
            force_change=pass_num > 0,
        )
        current = batch
        all_rewritten.extend(rewritten)

        joined = join_markdown_paragraphs(current)
        audit_after = auditor.audit_markdown(joined)
        final_ai = float(audit_after.get("ai_percentage") or 0)
        if final_ai <= _target:
            break
        if pass_num >= max_passes - 1:
            break
        strength = min(_max_str, strength + 0.03)
        idxs = _flagged_indices(audit_after) or list(range(len(current)))

    current = [_grammar_finalize(p) for p in current]

    joined = join_markdown_paragraphs(current)
    final_ai = float((auditor.audit_markdown(joined)).get("ai_percentage") or final_ai)

    if final_ai > _target:
        for i in range(len(current)):
            current[i] = _deep_polish(current[i], protected_terms=protected_terms, strength=_polish_str)
        joined = join_markdown_paragraphs(current)
        final_ai = float((auditor.audit_markdown(joined)).get("ai_percentage") or final_ai)

    if final_ai > _target:
        touch = sorted(
            set(_flagged_indices(auditor.audit_markdown(joined)))
            | {i for i, p in enumerate(current) if _marker_hits(p)}
        )
        for i in touch or list(range(len(current))):
            if 0 <= i < len(current):
                current[i] = _deep_polish(current[i], protected_terms=protected_terms, strength=min(_max_str, _polish_str + 0.03))
        joined = join_markdown_paragraphs(current)
        final_ai = float((auditor.audit_markdown(joined)).get("ai_percentage") or final_ai)

    avg_sim = (
        sum(r.get("semantic_similarity", 0.0) for r in all_rewritten) / len(all_rewritten)
        if all_rewritten
        else 1.0
    )

    return {
        "humanized_markdown": joined,
        "rewritten": all_rewritten,
        "seo_preservation_score": round(avg_sim * 100, 1),
        "engine": "riviso_paraphrase_v3_natural",
        "grammar_engine": "riviso_grammar_v2",
        "full_document": full_document,
        "passes": pass_num + 1,
        "final_ai_percentage": round(final_ai, 1),
        "elapsed_ms": int((time.perf_counter() - start) * 1000),
    }
