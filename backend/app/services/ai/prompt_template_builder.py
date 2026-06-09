"""
compile_prompt_template — turns guided "Add new prompt" options into reusable
prompt **text** for the Prompts module (storage.py ``project.prompts[]``).

This is a sibling to ``PromptBuilderService.compile()`` (prompt_builder.py),
not a replacement: that service compiles a per-article ``ContentBrief`` into a
``system``/``user`` message pair for the (not-yet-wired) V2 generation path.
This module compiles a ``PromptTemplateOptions`` selection into a single flat
text blob — the shape ``prompts[].text`` already has, and the shape the live
``_apply_placeholders()`` substitution (article_generation.py) already knows
how to consume. Reuses the same falsifiable-line layer helpers wherever the
fields line up (EEAT/SEO lines, industry context, length targets, restriction
lines, depth descriptions) so the "one checked box -> one short factual line,
never a MODE block" guarantee holds here exactly as it does for the V2 path.

The one layer that's never empty is ARTICLE CONTEXT — it hard-codes the
standard ``{article_title}`` / ``{focus_keyphrase}`` / ``{targeting_keywords}``
placeholder tokens (the EXACT snake_case, single-brace syntax
``_apply_placeholders`` matches) so every generated template is
substitution-ready by construction, independent of whatever the user picked.
"""

from __future__ import annotations

from app.schemas.content_brief import ContentRestriction, PromptTemplateOptions
from app.services.ai.industry_rules import build_industry_context_block
from app.services.ai.prompt_sections import (
    _DEPTH_DESCRIPTIONS,
    _LENGTH_TARGETS,
    _RESTRICTION_LINES,
)
from app.services.ai.seo_rules import build_eeat_lines, build_seo_lines

__all__ = ["compile_prompt_template"]


def _compile_writing_guidelines(options: PromptTemplateOptions) -> str:
    lines = [
        "Write in clear prose, organized with descriptive H2/H3 headings and "
        "well-formed paragraphs and lists where they aid readability.",
        _LENGTH_TARGETS[options.article_length],
    ]
    restriction_lines = [
        _RESTRICTION_LINES[option]
        for option in ContentRestriction.__args__
        if option in options.content_restrictions
    ]
    if restriction_lines:
        lines.append("Boundaries — do not violate any of the following:")
        lines.extend(f"- {line}" for line in restriction_lines)
    return "WRITING GUIDELINES\n" + "\n".join(lines)


def _compile_seo_rules(options: PromptTemplateOptions) -> str:
    lines = build_eeat_lines(options.eeat_settings) + build_seo_lines(options.seo_settings)
    if not lines:
        return ""
    return "SEO RULES\n" + "\n".join(f"- {line}" for line in lines)


def _compile_industry_context(options: PromptTemplateOptions) -> str:
    block = build_industry_context_block(options.industry)
    if not block:
        return ""
    return f"INDUSTRY CONTEXT\n{block}"


def _compile_configuration(options: PromptTemplateOptions) -> str:
    facts = [f"Content type: {options.content_type}"]
    if options.target_audience.strip():
        facts.append(f"Target audience: {options.target_audience.strip()}")
    facts.append(f"Tone of voice: {options.tone_of_voice}")
    facts.append(f"Writing style: {options.writing_style}")
    if options.brand_personality:
        facts.append(f"Brand personality: {', '.join(options.brand_personality)}")
    facts.append(
        f"Content depth: {options.content_depth} — {_DEPTH_DESCRIPTIONS[options.content_depth]}."
    )
    facts.append(f"Target length category: {options.article_length}.")
    return (
        "CONFIGURATION\n"
        "This prompt template has been configured as follows:\n"
        + "\n".join(f"- {fact}" for fact in facts)
    )


def _compile_website_data(options: PromptTemplateOptions) -> str:
    if not options.use_website_data:
        return ""
    return (
        "WEBSITE DATA\n"
        "Where relevant, draw on the project's brand identity, site / niche "
        "description, and product or page context."
    )


def _compile_additional_instructions(options: PromptTemplateOptions) -> str:
    text = options.additional_instructions.strip()
    if not text:
        return ""
    return (
        "ADDITIONAL INSTRUCTIONS — USER PROMPT AUTHORITY\n"
        "The following are the user's own instructions. They are the most specific "
        "and most recent statement of intent in this prompt. Where they add detail "
        "to anything above, apply that detail; where they differ from anything "
        "above, follow these instructions instead — nothing earlier in this prompt "
        "outranks them.\n\n"
        f"{text}"
    )


def _compile_article_context() -> str:
    return (
        "ARTICLE CONTEXT\n"
        "- Article title: {article_title}\n"
        "- Focus keyphrase: {focus_keyphrase}\n"
        "- Target keywords: {targeting_keywords}"
    )


def compile_prompt_template(options: PromptTemplateOptions) -> str:
    """``PromptTemplateOptions`` -> reusable prompt text with placeholder tokens."""
    layers = [
        _compile_writing_guidelines(options),
        _compile_seo_rules(options),
        _compile_industry_context(options),
        _compile_configuration(options),
        _compile_website_data(options),
        _compile_additional_instructions(options),
        _compile_article_context(),
    ]
    return "\n\n".join(layer for layer in layers if layer)
