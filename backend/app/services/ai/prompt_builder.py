"""
PromptBuilderService — compiles a ContentBrief into a CompiledPrompt.

This is the canonical home for the V2 spec's "/services/ai/prompt-builder":
the new source of truth for prompt *assembly*.  It does not call OpenAI, does
not persist anything, and is not imported by the live generation path yet —
see CONTENT_ENGINE_V2_PLAN.md "Migration Strategy" for the branch in
``execute_article_generation`` that will call into it alongside — never inside
— the unchanged legacy ``build_generation_messages``.

``compile()`` assembles the six hierarchy layers from prompt_sections.py in
the fixed order that *is* the authority guarantee: every layer ahead of
CUSTOM INSTRUCTIONS is written in a register (facts, parameterized requirements,
falsifiable checklist lines) that cannot compete with prose instructions for the
model's attention, leaving the user's own §19 free text the only
imperative-register block left to weigh.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.schemas.content_brief import ContentBrief
from app.services.ai.prompt_sections import (
    PromptBuilderContext,
    compile_custom_instructions,
    compile_optimization_rules,
    compile_output_format,
    compile_system_rules,
    compile_user_configuration,
    compile_website_data,
)

__all__ = ["CompiledPrompt", "HumanizationParams", "PromptBuilderContext", "PromptBuilderService"]


@dataclass(frozen=True)
class HumanizationParams:
    """Post-generation tuning for ``integrity_engine.execute_structural_humanization()``.

    Mapped from §16 Humanization Level — never prompt text, because a slider
    about how the *finished* draft should be polished is not an instruction
    about how to *write* it.  See _map_humanization().
    """

    target_ai_pct: int
    initial_strength: float


@dataclass(frozen=True)
class CompiledPrompt:
    """Everything the (future) pipeline branch needs from one ``compile()`` call.

    ``system`` / ``user`` are the literal strings to send to ``chat_json()``.
    ``humanization_params`` and ``creativity_note`` are non-prompt decisions
    the orchestration layer applies elsewhere (post-generation humanize call;
    creative-range instruction that feeds the prompt separately from the rest
    of the system text).
    """

    system: str
    user: str
    humanization_params: HumanizationParams | None
    creativity_note: str | None


# ---------------------------------------------------------------------------
# §16 Humanization Level → HumanizationParams
#
# Anchored on integrity_engine's existing tuned defaults (6% AI-detection
# target, 0.78 initial strength) at the spec's recommended default of 80,
# so level=80 resolves to ~5% / ~0.79 — the engine's own tuned baseline.
# Higher levels push toward stricter targets and stronger rewrites.
# Risk #5 in the plan: these mappings need empirical tuning against real runs.
# ---------------------------------------------------------------------------

_HUMANIZATION_TARGET_RANGE = (10, 4)       # (level=0 → 10%, level=100 → 4%)
_HUMANIZATION_STRENGTH_RANGE = (0.55, 0.85)  # (level=0 → 0.55, level=100 → 0.85)


def _map_humanization(level: int) -> HumanizationParams:
    fraction = max(0, min(100, level)) / 100.0
    lo_pct, hi_pct = _HUMANIZATION_TARGET_RANGE
    lo_strength, hi_strength = _HUMANIZATION_STRENGTH_RANGE
    target_ai_pct = round(lo_pct + (hi_pct - lo_pct) * fraction)
    initial_strength = round(lo_strength + (hi_strength - lo_strength) * fraction, 2)
    return HumanizationParams(target_ai_pct=target_ai_pct, initial_strength=initial_strength)


# ---------------------------------------------------------------------------
# §17 Creativity Level → a compiled instruction about creative range.
#
# NOT the OpenAI temperature param — gpt-5.5 ignores custom temperature
# (openai_client.py:86-89).  Three bands rather than continuous mapping:
# a model can act on clearly distinct postures; it cannot act on a numeric
# difference it cannot observe in the prose.  Risk #5 applies here too.
# ---------------------------------------------------------------------------


def _map_creativity(level: int) -> str:
    clamped = max(0, min(100, level))
    if clamped <= 33:
        guidance = (
            "Favor conventional structure, familiar framings, and a measured, "
            "predictable rhythm — clarity and reliability matter more than novelty here."
        )
    elif clamped <= 66:
        guidance = (
            "Balance familiar structure with occasional fresh framing or analogy — "
            "enough variation to stay engaging without drawing attention to itself."
        )
    else:
        guidance = (
            "Use unconventional analogies, varied sentence rhythm, and less "
            "predictable framing wherever it serves the reader — while keeping "
            "every fact accurate and every claim properly grounded."
        )
    return f"Creative range for this article: {guidance}"


class PromptBuilderService:
    """Stateless compiler: ContentBrief (+ article/project facts) → CompiledPrompt.

    Layers assembled in fixed authority order:
      SYSTEM RULES → OPTIMIZATION RULES → USER CONFIGURATION → WEBSITE DATA
      → CUSTOM INSTRUCTIONS → OUTPUT FORMAT
    """

    @staticmethod
    def compile(
        brief: ContentBrief,
        *,
        title: str,
        keywords: list[str] | None = None,
        focus_keyphrase: str = "",
        project_context: PromptBuilderContext | None = None,
    ) -> CompiledPrompt:
        context = project_context or PromptBuilderContext()

        # §17 creativity note is compiled separately and prepended to SYSTEM RULES
        # so it sits in the parameterized-requirement layer, not mixed into the
        # user's custom instructions.
        creativity_note = _map_creativity(brief.creativity_level)

        layers = [
            compile_system_rules(brief),
            compile_optimization_rules(brief),
            compile_user_configuration(brief),
            compile_website_data(brief, context),
            compile_custom_instructions(brief),
            compile_output_format(),
        ]
        system_parts = [layer for layer in layers if layer]
        # Append creativity note to system rules block (first non-empty layer)
        if system_parts and creativity_note:
            system_parts[0] = system_parts[0] + f"\n{creativity_note}"

        system = "\n\n".join(system_parts)

        user_lines = [f"Article title: {title}"]
        keyword_list = list(keywords or [])
        if keyword_list:
            user_lines.append(f"Target keywords: {', '.join(keyword_list)}")
        if focus_keyphrase:
            user_lines.append(f"Focus keyphrase: {focus_keyphrase}")
        user_lines.append("")
        user_lines.append("Output the JSON object now.")

        return CompiledPrompt(
            system=system,
            user="\n".join(user_lines),
            humanization_params=_map_humanization(brief.humanization_level),
            creativity_note=creativity_note,
        )
