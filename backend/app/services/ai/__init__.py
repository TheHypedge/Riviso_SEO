"""
Content Engine V2 — structured prompt-building services.

Everything under ``app.services.ai`` compiles a ``ContentBrief`` (see
``app.schemas.content_brief``) into prompt text for the existing OpenAI
generation pipeline. None of these modules are imported by the live
generation path yet — see CONTENT_ENGINE_V2_PLAN.md "Migration Strategy"
for how (and when) ``article_pipeline.execute_article_generation`` gains a
branch that resolves a ``content_brief`` and calls into this package instead
of the legacy free-text ``build_generation_messages`` assembly. Until that
branch lands, this package is net-new code with no production callers and
changes here cannot affect any running generation.

Module map:
  prompt_sections.py  — one compiler per layer of the prompt hierarchy
  industry_rules.py   — short factual per-industry context (replaces the
                        "mode block" framing that made content_optimization.py
                        compete with the user's prompt instead of serving it)
  seo_rules.py        — EEAT/SEO checkbox -> single falsifiable instruction line
  prompt_builder.py   — PromptBuilderService: assembles the layers in hierarchy
                        order and maps the two non-prompt sliders to generation
                        parameters
"""

from __future__ import annotations

from app.services.ai.prompt_builder import CompiledPrompt, PromptBuilderService

__all__ = ["PromptBuilderService", "CompiledPrompt"]
