"""
One compiler per layer of the V2 prompt hierarchy.

``PromptBuilderService.compile()`` (prompt_builder.py) concatenates these in a
fixed order — SYSTEM RULES → SEO RULES → INDUSTRY RULES → USER CONFIGURATION →
WEBSITE DATA → ADDITIONAL INSTRUCTIONS → OUTPUT FORMAT — and that order *is*
the authority hierarchy described in CONTENT_ENGINE_V2_PLAN.md: every layer
before ADDITIONAL INSTRUCTIONS is written as short, factual, non-competing
statements (context, configuration, parameterized requirements, falsifiable
checklist lines, hard boundaries), so the user's own free text — the one
imperative, prose-register block, placed last — has nothing of comparable
weight left to out-argue. "User wins" becomes a property of the shape of the
prompt, not a sentence asking the model to retroactively believe it.

Each ``compile_*`` returns "" when its layer has nothing to contribute (e.g.
no restrictions checked, no industry block, website data toggled off,
empty additional instructions) — ``PromptBuilderService`` filters empties
before joining, so an unused layer simply doesn't appear rather than appearing
as an empty heading.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.schemas.content_brief import ArticleLength, ContentBrief, ContentDepth, ContentRestriction
from app.services.ai.industry_rules import build_industry_context_block
from app.services.ai.seo_rules import build_eeat_lines, build_seo_lines

# ---------------------------------------------------------------------------
# SYSTEM RULES — structural requirements (parameterized by Article Length,
# replacing the legacy fixed "1,500 words minimum") plus §17 Content
# Restrictions, rendered as hard negative boundaries. Same category as the
# legacy "non-negotiable" structure block — but the *length* requirement now
# reflects what the user actually asked for instead of overriding it.
# ---------------------------------------------------------------------------

_LENGTH_TARGETS: dict[ArticleLength, str] = {
    "Short (600-900 words)": "Write approximately 600-900 words.",
    "Medium (1,000-1,800 words)": "Write approximately 1,000-1,800 words.",
    "Long (1,800-3,000 words)": "Write approximately 1,800-3,000 words.",
    "Comprehensive (3,000+ words)": (
        "Write at least 3,000 words — go deep enough to cover the topic fully "
        "rather than padding to reach a count."
    ),
}

_RESTRICTION_LINES: dict[str, str] = {
    "No competitor mentions": "Do not name or reference competitors.",
    "No pricing or cost claims": "Do not state or imply specific prices or costs.",
    "No medical, legal, or financial advice claims": (
        "Do not present the content as medical, legal, or financial advice."
    ),
    "No first-person voice ('I', 'we')": "Do not write in first-person voice ('I', 'we').",
    "No emojis": "Do not use emojis.",
    "No exclamation points": "Do not use exclamation points.",
    "Avoid superlatives ('best', '#1', 'guaranteed')": (
        "Do not use unsupported superlatives such as 'best', '#1', or 'guaranteed'."
    ),
    "No fabricated statistics, names, or citations": (
        "Do not invent statistics, studies, names, or citations — state only what "
        "can be reasonably asserted as general knowledge."
    ),
}


def compile_system_rules(brief: ContentBrief) -> str:
    lines = [
        "Write in clear prose, organized with descriptive H2/H3 headings and "
        "well-formed paragraphs and lists where they aid readability.",
        _LENGTH_TARGETS[brief.article_length],
    ]
    restriction_lines = [
        _RESTRICTION_LINES[option]
        for option in ContentRestriction.__args__
        if option in brief.content_restrictions
    ]
    if restriction_lines:
        lines.append("Boundaries — do not violate any of the following:")
        lines.extend(f"- {line}" for line in restriction_lines)
    return "SYSTEM RULES\n" + "\n".join(lines)


# ---------------------------------------------------------------------------
# SEO RULES — one falsifiable line per checked EEAT/SEO box (seo_rules.py).
# The structural replacement for content_optimization.py's "MODE" blocks —
# see that module's docstring contrast in seo_rules.py.
# ---------------------------------------------------------------------------


def compile_seo_rules(brief: ContentBrief) -> str:
    lines = build_eeat_lines(brief.eeat_settings) + build_seo_lines(brief.seo_settings)
    if not lines:
        return ""
    return "SEO RULES\n" + "\n".join(f"- {line}" for line in lines)


# ---------------------------------------------------------------------------
# INDUSTRY RULES — short factual context for the chosen industry
# (industry_rules.py). "" for "Other / general" — a generic industry adds no
# useful grounding, so the layer simply doesn't appear.
# ---------------------------------------------------------------------------


def compile_industry_rules(brief: ContentBrief) -> str:
    block = build_industry_context_block(brief.industry)
    if not block:
        return ""
    return f"INDUSTRY RULES\n{block}"


# ---------------------------------------------------------------------------
# USER CONFIGURATION — sections 1-12, rendered as a flat list of facts about
# what the user chose ("the user has configured this article as follows").
# Deliberately declarative, not imperative — these are the user's own
# decisions, restated so the model has them as grounding context. They can
# only ever conflict with §19 if the user contradicts themselves between the
# structured form and their own free text — in which case ADDITIONAL
# INSTRUCTIONS (more specific, more recent) is told it wins that internal tie.
# ---------------------------------------------------------------------------

_DEPTH_DESCRIPTIONS: dict[ContentDepth, str] = {
    "Beginner-friendly overview": "written so a newcomer with no prior background can follow it",
    "Standard / balanced": "written at a level that balances accessibility with useful detail",
    "In-depth / comprehensive": "written with thorough, comprehensive coverage of the topic",
    "Expert-level / technical": (
        "written for an audience that already has strong domain knowledge, "
        "using precise technical language"
    ),
}


def compile_user_configuration(brief: ContentBrief) -> str:
    facts = [
        f"Content type: {brief.content_type}",
        f"Content goal: {brief.content_goal}",
        f"Target audience: {brief.target_audience}",
        f"Industry: {brief.industry}",
        f"Primary keyword: {brief.primary_keyword}",
    ]
    if brief.secondary_keywords:
        facts.append(f"Secondary keywords: {', '.join(brief.secondary_keywords)}")
    facts.append(f"Search intent: {brief.search_intent}")
    facts.append(f"Tone of voice: {brief.tone_of_voice}")
    facts.append(f"Writing style: {brief.writing_style}")
    if brief.brand_personality:
        facts.append(f"Brand personality: {', '.join(brief.brand_personality)}")
    facts.append(f"Content depth: {brief.content_depth} — {_DEPTH_DESCRIPTIONS[brief.content_depth]}.")
    facts.append(f"Target length category: {brief.article_length}.")
    return (
        "USER CONFIGURATION\n"
        "The user has configured this article as follows:\n"
        + "\n".join(f"- {fact}" for fact in facts)
    )


# ---------------------------------------------------------------------------
# WEBSITE DATA — gated entirely by the §18 toggle. A pure data-inclusion
# switch supplying *context* (brand identity, site description, mapped
# product/page context) — exactly like today's brand_identity/product_context
# — never an instruction about how to write. "" when toggled off or when the
# caller has nothing to supply, so the layer simply doesn't appear.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PromptBuilderContext:
    """Project/article-level facts the builder may fold into WEBSITE DATA.

    Mirrors the shape of data ``resolve_platform_generation_extras()`` and the
    project record already supply to the legacy assembly — see
    CONTENT_GENERATION_ARCHITECTURE.md "platform integration". Every field is
    optional and defaults to "": the caller supplies what it has, and an
    absent fact simply doesn't render a line.
    """

    brand_identity: str = ""
    site_description: str = ""
    product_context: str = ""


def compile_website_data(brief: ContentBrief, context: PromptBuilderContext) -> str:
    if not brief.use_website_data:
        return ""
    facts = []
    if context.brand_identity:
        facts.append(f"Brand identity: {context.brand_identity}")
    if context.site_description:
        facts.append(f"Site / niche description: {context.site_description}")
    if context.product_context:
        facts.append(f"Relevant product or page context: {context.product_context}")
    if not facts:
        return ""
    return "WEBSITE DATA\n" + "\n".join(facts)


# ---------------------------------------------------------------------------
# ADDITIONAL INSTRUCTIONS — §19, the ONLY free-prose, imperative-register
# layer in the entire compiled prompt, placed last on purpose. Carries the
# same "USER PROMPT AUTHORITY" framing the legacy prompt uses today — but
# here it is genuinely uncontested, because every layer above it has been
# deliberately written in a register (facts, parameters, checklist lines,
# boundaries) that does not compete with prose instructions for priority.
# "" when empty: an empty value is meaningful (nothing to add beyond the
# structured choices above) and must not be padded with filler text.
# ---------------------------------------------------------------------------


def compile_additional_instructions(brief: ContentBrief) -> str:
    text = brief.additional_instructions.strip()
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


# ---------------------------------------------------------------------------
# OUTPUT FORMAT — the JSON-shape instruction. Kept byte-for-byte aligned with
# the legacy schema (title / body / meta_title / meta_description — see
# CONTENT_GENERATION_ARCHITECTURE.md "chat_json ... article body, meta title,
# meta description") so a brief-driven generation and a legacy generation
# produce mongo documents the rest of the pipeline treats identically.
# ---------------------------------------------------------------------------


def compile_output_format() -> str:
    return (
        "OUTPUT FORMAT\n"
        'Return ONLY a JSON object with exactly these keys: "title", "body", '
        '"meta_title", "meta_description". No text outside the JSON object.'
    )


__all__ = [
    "PromptBuilderContext",
    "compile_system_rules",
    "compile_seo_rules",
    "compile_industry_rules",
    "compile_user_configuration",
    "compile_website_data",
    "compile_additional_instructions",
    "compile_output_format",
]
