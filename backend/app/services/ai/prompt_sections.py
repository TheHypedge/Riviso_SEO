"""
One compiler per layer of the V2 prompt hierarchy.

``PromptBuilderService.compile()`` (prompt_builder.py) concatenates these in a
fixed order:

  SYSTEM RULES → OPTIMIZATION RULES → USER CONFIGURATION → WEBSITE DATA
  → CUSTOM INSTRUCTIONS → OUTPUT FORMAT

That order *is* the authority hierarchy: every layer before CUSTOM INSTRUCTIONS
is written as short, factual, non-competing statements (parameterized
requirements, falsifiable checklist lines, context facts) — leaving the user's
own free text the only imperative, prose-register block in the prompt.  "User
wins" is a property of the prompt's shape, not a sentence asking the model to
believe it retroactively.

Each ``compile_*`` returns "" when its layer has nothing to contribute — the
PromptBuilderService filters empties before joining, so an unused layer simply
doesn't appear rather than appearing as an empty heading.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.schemas.content_brief import (
    BriefBrandPersonality,
    BriefContentDepth,
    BriefTargetAudience,
    BriefToneOfVoice,
    ConversationStyle,
    ContentBrief,
    ContentOptimizationOption,
    ContentStructureOption,
    DataResearchOption,
    ReadabilityLevel,
)
from app.services.ai.optimization_rules import (
    build_content_optimization_lines,
    build_data_research_lines,
)

# ---------------------------------------------------------------------------
# SYSTEM RULES — structural requirements parameterized by §7 Content Depth,
# §8 Content Length, and §10 FAQ Generation.  These were previously fixed
# strings; they now reflect what the user actually configured.
# ---------------------------------------------------------------------------

_DEPTH_GUIDANCE: dict[BriefContentDepth, str] = {
    "Basic": (
        "Write an accessible overview — define key terms, avoid assumed knowledge, "
        "and favour clarity over comprehensiveness."
    ),
    "Standard": (
        "Provide balanced coverage — enough depth to be genuinely useful without "
        "overwhelming a reader who knows the basics."
    ),
    "In-Depth": (
        "Cover the topic thoroughly — include nuance, edge cases, and the kind of "
        "detail that rewards a reader who wants to go beyond the surface."
    ),
    "Comprehensive": (
        "Produce an exhaustive resource — leave no significant sub-topic unaddressed; "
        "a reader should come away with everything they need to act or decide."
    ),
    "Ultimate Guide": (
        "Create the definitive reference on this topic — cover every relevant angle, "
        "include practical takeaways and structured navigation, and write to the "
        "standard that other content on this topic would cite."
    ),
}

_READABILITY_GUIDANCE: dict[ReadabilityLevel, str] = {
    "General Public (8th Grade)": (
        "Readability: write at an 8th-grade level — short sentences, common vocabulary, "
        "concrete examples, no unexplained jargon."
    ),
    "Casual Reader": (
        "Readability: write in a relaxed, readable style — avoid dense blocks, use "
        "plain language, and keep paragraphs short."
    ),
    "Informed Reader": (
        "Readability: assume the reader is familiar with the topic's basics — you can "
        "use standard terminology without defining every term."
    ),
    "Professional Audience": (
        "Readability: write for a professional audience — precise vocabulary, "
        "industry-standard terminology used correctly, no over-explanation."
    ),
    "Technical Expert": (
        "Readability: assume expert-level domain knowledge — use technical terminology "
        "without hand-holding; precision matters more than accessibility."
    ),
    "Academic": (
        "Readability: write to an academic standard — rigorous argumentation, "
        "evidence-based claims, formal register, structured reasoning."
    ),
}

_STRUCTURE_LABELS: dict[ContentStructureOption, str] = {
    "Introduction": "Introduction",
    "Quick Answer / TL;DR": "Quick Answer / TL;DR (a 50–100 word direct answer to the primary query, near the top)",
    "Table of Contents": "Table of Contents",
    "Key Takeaways": "Key Takeaways (8–10 bullet summary of the most important insights)",
    "Pros and Cons": "Pros and Cons section",
    "Step-by-Step Breakdown": "Step-by-Step Breakdown section",
    "FAQs": "FAQs section (5–10 Q&A pairs optimised for AI extraction)",
    "CTA (Call to Action)": "Call to Action",
    "Summary / Conclusion": "Summary / Conclusion",
}


def compile_system_rules(brief: ContentBrief) -> str:
    lines = [
        "Write in clear prose, organized with descriptive H2/H3 headings and "
        "well-formed paragraphs and lists where they aid readability.",
        f"Write approximately {brief.content_length:,} words (±10%).",
        _DEPTH_GUIDANCE[brief.content_depth],
    ]

    if brief.readability_level:
        lines.append(_READABILITY_GUIDANCE[brief.readability_level])

    if brief.faq_generation:
        lines.append(
            "Include a '## Frequently Asked Questions' section with 5–10 Q&A pairs "
            "based on real search queries, each answer 50–120 words and optimised for "
            "AI extraction and featured snippets."
        )

    structure_items = [
        _STRUCTURE_LABELS[opt]
        for opt in ContentStructureOption.__args__
        if opt in brief.content_structure
    ]
    if structure_items:
        lines.append("Include the following named sections:")
        lines.extend(f"- {label}" for label in structure_items)

    return "SYSTEM RULES\n" + "\n".join(lines)


# ---------------------------------------------------------------------------
# OPTIMIZATION RULES — §11 Content Optimization + §12 Data & Research.
# One falsifiable line per checked box — never a "mode" block.  See
# optimization_rules.py and CONTENT_CONFIGURATION_PANEL_PLAN.md §0.3 + §4.3.
# ---------------------------------------------------------------------------


def compile_optimization_rules(brief: ContentBrief) -> str:
    lines = (
        build_content_optimization_lines(brief.content_optimization)
        + build_data_research_lines(brief.data_research)
    )
    if not lines:
        return ""
    return "OPTIMIZATION RULES\n" + "\n".join(f"- {line}" for line in lines)


# ---------------------------------------------------------------------------
# USER CONFIGURATION — §1–6, §14 rendered as a flat list of declarative facts.
# Deliberately not imperative — these are the user's own decisions, restated
# as grounding context.  A fact cannot outrank an instruction and isn't trying
# to; that's what keeps §19 uncontested.
# ---------------------------------------------------------------------------

_DEPTH_DESCRIPTIONS: dict[BriefContentDepth, str] = {
    "Basic": "accessible overview for readers with no prior knowledge",
    "Standard": "balanced coverage for a reader with basic familiarity",
    "In-Depth": "thorough coverage for a reader who wants more than the basics",
    "Comprehensive": "exhaustive resource covering all significant sub-topics",
    "Ultimate Guide": "definitive reference that other content would cite",
}

_AUDIENCE_DESCRIPTIONS: dict[BriefTargetAudience, str] = {
    "General Public": "a general, non-specialist audience",
    "Business Owners": "business owners making decisions about their operations",
    "Marketing Professionals": "marketing practitioners evaluating strategies and tools",
    "Developers / Technical Audience": "developers and technical practitioners",
    "Healthcare Professionals": "healthcare professionals (clinical or administrative)",
    "Finance / Legal Professionals": "finance or legal professionals",
    "Students / Beginners": "students or beginners new to the topic",
    "Young Adults (Gen Z / Millennials)": "young adult readers (Gen Z / Millennials)",
    "Small Business Owners": "small business owners managing their own operations",
    "Enterprise / B2B Buyers": "enterprise or B2B decision-makers evaluating solutions",
}

_TONE_DESCRIPTIONS: dict[BriefToneOfVoice, str] = {
    "Professional": "precise, credible, and business-appropriate",
    "Conversational": "warm and direct — as if speaking to the reader",
    "Friendly": "approachable and encouraging",
    "Authoritative": "confident and expert — the definitive word on the topic",
    "Witty / Humorous": "light and entertaining — wit used to make a point",
    "Empathetic": "understanding and supportive of the reader's situation",
    "Formal": "structured, measured, and formally written",
    "Inspirational": "motivating and forward-looking",
    "Technical": "precise and terminology-rich, prioritizing accuracy over accessibility",
    "Bold / Confident": "direct and assertive — no hedging, clear positions",
    "Neutral / Balanced": "objective and even-handed, presenting all sides fairly",
}

_CONVERSATION_STYLE_DESCRIPTIONS: dict[ConversationStyle, str] = {
    "Thought Leadership": "establishing a point of view and positioning the author as an expert",
    "Storytelling / Narrative": "using narrative arcs and real scenarios to engage the reader",
    "Educational / Tutorial": "teaching step-by-step, building understanding progressively",
    "Persuasive / Sales": "building a case and moving the reader toward a decision",
    "Investigative / Journalistic": "researching and presenting findings like a journalist would",
    "Interview / Q&A": "structured as questions and answers",
    "Opinionated / Editorial": "taking clear positions and defending them",
    "Step-by-Step Guide": "numbered or ordered instructions with clear progression",
    "Analytical / Data-Driven": "evidence-based reasoning with concrete data",
    "Casual / Blog": "informal, first-person-friendly, personal in register",
    "Expert Commentary": "providing professional analysis and interpretation",
}


def compile_user_configuration(brief: ContentBrief) -> str:
    facts: list[str] = [
        f"Content type: {brief.content_type}",
        f"Primary keyword: {brief.primary_keyword}",
    ]
    if brief.secondary_keywords:
        facts.append(f"Secondary keywords: {', '.join(brief.secondary_keywords)}")
    if brief.search_intent:
        facts.append(f"Search intent: {brief.search_intent}")
    if brief.target_audience:
        desc = _AUDIENCE_DESCRIPTIONS.get(brief.target_audience, brief.target_audience)
        facts.append(f"Target audience: {brief.target_audience} — {desc}.")
    if brief.tone_of_voice:
        desc = _TONE_DESCRIPTIONS.get(brief.tone_of_voice, "")
        facts.append(
            f"Tone of voice: {brief.tone_of_voice}"
            + (f" — {desc}" if desc else "")
            + "."
        )
    if brief.conversation_style:
        desc = _CONVERSATION_STYLE_DESCRIPTIONS.get(brief.conversation_style, "")
        facts.append(
            f"Conversation style: {brief.conversation_style}"
            + (f" — {desc}" if desc else "")
            + "."
        )
    if brief.brand_personality:
        facts.append(f"Brand personality: {', '.join(brief.brand_personality)}.")
    depth_desc = _DEPTH_DESCRIPTIONS[brief.content_depth]
    facts.append(f"Content depth: {brief.content_depth} — {depth_desc}.")

    return (
        "USER CONFIGURATION\n"
        "The user has configured this article as follows:\n"
        + "\n".join(f"- {fact}" for fact in facts)
    )


# ---------------------------------------------------------------------------
# WEBSITE DATA — gated entirely by §18 Use Website Data toggle.  Pure data
# supply — brand/site/product context — never an instruction about how to write.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PromptBuilderContext:
    """Project/article-level context the builder may fold into WEBSITE DATA.

    Mirrors the shape of data ``resolve_platform_generation_extras()`` and the
    project record already supply to the legacy assembly.  Every field defaults
    to "": the caller supplies what it has; absent facts don't render.
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
# CUSTOM INSTRUCTIONS — §19, the ONLY free-prose, imperative-register layer.
# Placed last, given USER PROMPT AUTHORITY framing, genuinely uncontested
# because every layer above it is declarative facts, parameterized rules, or
# falsifiable checklist lines — nothing in the same register to compete with.
# ---------------------------------------------------------------------------


def compile_custom_instructions(brief: ContentBrief) -> str:
    text = brief.custom_instructions.strip()
    if not text:
        return ""
    return (
        "CUSTOM INSTRUCTIONS — USER PROMPT AUTHORITY\n"
        "The following are the user's own instructions. They are the most specific "
        "and most recent statement of intent in this prompt. Where they add detail "
        "to anything above, apply that detail; where they differ from anything "
        "above, follow these instructions instead — nothing earlier in this prompt "
        "outranks them.\n\n"
        f"{text}"
    )


# ---------------------------------------------------------------------------
# OUTPUT FORMAT — unchanged JSON shape; aligned with the legacy assembly so
# brief-driven and legacy-driven generations produce identical mongo documents.
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
    "compile_optimization_rules",
    "compile_user_configuration",
    "compile_website_data",
    "compile_custom_instructions",
    "compile_output_format",
]
