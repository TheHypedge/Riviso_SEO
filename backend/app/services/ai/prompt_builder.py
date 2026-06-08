"""
PromptBuilderService — compiles a ContentBrief into a CompiledPrompt.

This is the canonical home for the V2 spec's "/services/ai/prompt-builder":
the new source of truth for prompt *assembly*. It does not call OpenAI, does
not persist anything, and is not imported by the live generation path — see
CONTENT_ENGINE_V2_PLAN.md "Migration Strategy" for the (not-yet-written)
branch in ``execute_article_generation`` that will eventually call into it
alongside — never inside — the unchanged legacy ``build_generation_messages``.

``compile()`` assembles the seven hierarchy layers from prompt_sections.py in
the fixed order that *is* the authority guarantee (see that module's
docstring): every layer ahead of ADDITIONAL INSTRUCTIONS is written in a
register — facts, parameters, checklists, boundaries — that cannot compete
with prose instructions for the model's attention, leaving the user's own
free text the only imperative-register block left to weigh.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.schemas.content_brief import ContentBrief
from app.services.ai.prompt_sections import (
    PromptBuilderContext,
    compile_additional_instructions,
    compile_industry_rules,
    compile_output_format,
    compile_seo_rules,
    compile_system_rules,
    compile_user_configuration,
    compile_website_data,
)

__all__ = ["CompiledPrompt", "HumanizationParams", "PromptBuilderContext", "PromptBuilderService"]


@dataclass(frozen=True)
class HumanizationParams:
    """Post-generation tuning for ``integrity_engine.execute_structural_humanization()``.

    Mapped from §15 Humanization Level — never prompt text, because a slider
    about how the *finished* draft should be polished is not an instruction
    about how to *write* it, and folding it into the prompt would just be one
    more block competing for the model's attention. See _map_humanization().
    """

    target_ai_pct: int
    initial_strength: float


@dataclass(frozen=True)
class CompiledPrompt:
    """Everything the (future) pipeline branch needs from one ``compile()`` call.

    ``system`` / ``user`` are the literal strings to send to ``chat_json()`` —
    ``system`` is already the fully-assembled seven-layer hierarchy text;
    nothing further needs to be appended for the prompt itself to be complete.

    ``humanization_params`` and ``creativity_note`` are *not* part of
    ``system`` — they are non-prompt generation decisions the orchestration
    layer applies elsewhere (a post-generation humanize call; a place to sit
    alongside wherever a future temperature-capable model's parameters would
    be set). Returning them alongside the prompt text means one ``compile()``
    call is the single source of truth for everything §15/§16 affect, without
    smuggling a parameter-driven note into a hierarchy layer that exists for
    a different purpose.
    """

    system: str
    user: str
    humanization_params: HumanizationParams | None
    creativity_note: str | None


# ---------------------------------------------------------------------------
# §15 Humanization Level -> HumanizationParams
#
# Anchored on integrity_engine's existing tuned defaults (6% AI-detection
# target, 0.78 initial strength — see CONTENT_GENERATION_ARCHITECTURE.md
# "post-generation processing") at the spec's recommended slider default of
# 80, rather than guessing a mapping from scratch: at level 80 this resolves
# to ~5% / ~0.79, i.e. the engine's own tuned baseline. Higher levels push
# toward a stricter (lower) AI-detection target and a stronger starting
# rewrite; lower levels relax both toward the engine's gentlest behaviour.
# Risk #5 in the plan flags that these endpoints need empirical tuning against
# real generation runs — this is a principled starting point, not a final word.
# ---------------------------------------------------------------------------

_HUMANIZATION_TARGET_RANGE = (10, 4)     # (level=0 -> 10%, level=100 -> 4%)
_HUMANIZATION_STRENGTH_RANGE = (0.55, 0.85)  # (level=0 -> 0.55, level=100 -> 0.85)


def _map_humanization(level: int) -> HumanizationParams:
    fraction = max(0, min(100, level)) / 100.0
    lo_pct, hi_pct = _HUMANIZATION_TARGET_RANGE
    lo_strength, hi_strength = _HUMANIZATION_STRENGTH_RANGE
    target_ai_pct = round(lo_pct + (hi_pct - lo_pct) * fraction)
    initial_strength = round(lo_strength + (hi_strength - lo_strength) * fraction, 2)
    return HumanizationParams(target_ai_pct=target_ai_pct, initial_strength=initial_strength)


# ---------------------------------------------------------------------------
# §16 Creativity Level -> a compiled instruction about creative *range*.
#
# Deliberately NOT the OpenAI `temperature` parameter — `gpt-5.5` ignores any
# custom value (openai_client.py:86-89, "GPT-5.x only accepts the default
# temperature (1)"; see CONTENT_GENERATION_ARCHITECTURE.md and Risk #1). Three
# bands rather than a continuous numeric-to-prose mapping: a slider value like
# "57 -> some specific paragraph" would be precision theater — the model
# can't act on a difference the prose doesn't express. Three clearly distinct
# postures is what the prompt can actually make *true*, and the band edges
# (33/66) split the 0-100 range evenly. Risk #5 applies here too.
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
    """Stateless compiler: ``ContentBrief`` (+ article/project facts) -> ``CompiledPrompt``.

    A ``staticmethod`` rather than instance methods on purpose — there is no
    per-call state to hold, and a stateless compiler is trivially safe to call
    from any future entry point (manual generate, scheduled jobs, topic-cluster
    fan-out) without the dedup/concurrency questions a stateful service would raise.
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

        layers = [
            compile_system_rules(brief),
            compile_seo_rules(brief),
            compile_industry_rules(brief),
            compile_user_configuration(brief),
            compile_website_data(brief, context),
            compile_additional_instructions(brief),
            compile_output_format(),
        ]
        system = "\n\n".join(layer for layer in layers if layer)

        # User message — same shape as the legacy assembly (title / keywords /
        # focus keyphrase / "output the JSON object now"), see
        # PROMPT_FLOW_ANALYSIS.md "The USER message". The brief's own content
        # lives entirely in `system` now (USER CONFIGURATION + ADDITIONAL
        # INSTRUCTIONS), so this stays the same small, uniform shape rather
        # than also carrying a "writing instructions" block.
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
            creativity_note=_map_creativity(brief.creativity_level),
        )
