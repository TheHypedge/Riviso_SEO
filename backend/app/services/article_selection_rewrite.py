"""
Lightweight AI rewrite for the article editor's inline "AI regenerate selection"
tool. Same class of work as ``article_metadata_suggestion.py`` — a single direct
``chat_json`` call, no queue, no ``generation_slot()`` — but scoped to rewording
one already-selected piece of an article rather than suggesting new metadata.

Fidelity is the whole point: this must preserve the same facts/meaning/intent as
the selected text, only changing the wording — mirrors the same principle applied
to the "Through Source" article-creation feature's source-material rules in
``article_generation.py``.
"""

from __future__ import annotations

import json
from typing import Any

from app.core.config import settings
from app.services.human_writing_guardrail import format_ai_detector_banned_phrases_for_prompt
from app.services.openai_client import OpenAIClient

_SYSTEM_PROMPT = (
    "You are rewording one selected piece of an existing article. This is a fidelity "
    "rewrite, not a new take on the topic.\n"
    "- Preserve every fact, name, number, date, and claim in the selected text. Do not "
    "invent or omit information.\n"
    "- The meaning and intent must match exactly — only the wording, sentence structure, "
    "and phrasing may change.\n"
    "- Match the tone and voice of the surrounding context provided.\n"
    "- Preserve the same rough shape as the input: a single sentence in must come back as "
    "a single sentence, one paragraph in as one paragraph, multiple paragraphs in as the "
    "same number of paragraphs. Do not add or remove headings or list markers that were "
    "not present in the selected text.\n"
    "- If the focus keyphrase or keywords naturally fit the selection's topic you may keep "
    "them, but never force one in if it would change the meaning.\n"
    "- Never use em dashes (—) anywhere. Use a comma, plain hyphen (-), or rewrite the "
    "sentence instead. Never use a semicolon as a sentence connector.\n"
    f"{format_ai_detector_banned_phrases_for_prompt()}"
    "Return ONLY JSON: {\"rewritten\": string}. No commentary, no markdown code fences."
)


def _build_selection_rewrite_messages(
    *,
    selected_text: str,
    context_before: str,
    context_after: str,
    focus_keyphrase: str,
    keywords: list[str],
) -> tuple[str, str]:
    user = json.dumps(
        {
            "selected_text": selected_text,
            "context_before": context_before,
            "context_after": context_after,
            "focus_keyphrase": focus_keyphrase,
            "keywords": keywords,
        },
        ensure_ascii=False,
    )
    return _SYSTEM_PROMPT, user


async def rewrite_selected_text(
    *,
    selected_text: str,
    context_before: str,
    context_after: str,
    focus_keyphrase: str,
    keywords: list[str],
) -> str:
    """Reword `selected_text` in place, preserving its facts/meaning. Returns the
    replacement text (plain prose, paragraph breaks as blank lines)."""
    system, user = _build_selection_rewrite_messages(
        selected_text=selected_text,
        context_before=context_before,
        context_after=context_after,
        focus_keyphrase=focus_keyphrase,
        keywords=keywords,
    )
    client = OpenAIClient()
    obj: dict[str, Any] = await client.chat_json(model=settings.openai_text_model, system=system, user=user)
    return str((obj or {}).get("rewritten") or "").strip()
