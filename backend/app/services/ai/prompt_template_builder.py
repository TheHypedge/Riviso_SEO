"""
compile_prompt_template — turns guided "Add new prompt" options into reusable
prompt **text** for the Prompts module (storage.py ``project.prompts[]``).

This is a sibling to ``PromptBuilderService.compile()`` (prompt_builder.py),
not a replacement: that service compiles a per-article ``ContentBrief`` into a
``system``/``user`` message pair for the (not-yet-wired) V2 generation path.
This module compiles a ``PromptTemplateOptions`` selection into a single flat
text blob — the shape ``prompts[].text`` already has, and the shape the live
``_apply_placeholders()`` substitution (article_generation.py) already knows
how to consume.

Every field now compiles to an **imperative directive** the model must follow,
not a declarative label it can treat as context and ignore. Each option maps to
a concrete behavioural instruction so that selecting "Listicle" actually
produces a list-structured article, "Short (600-900 words)" actually produces a
short article, and "Beginner-friendly overview" actually simplifies the language.
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

# H2 section range per article length — prevents the system-level "minimum 4
# H2 sections" requirement from inflating a short article into a long one.
_LENGTH_SECTION_GUIDANCE: dict[str, str] = {
    "Short (600-900 words)": (
        "Structure: use 2-3 H2 sections only. Do not add extra sections to reach "
        "a higher count — stay within the word limit above."
    ),
    "Medium (1,000-1,800 words)": "Structure: use 3-5 H2 sections.",
    "Long (1,800-3,000 words)": "Structure: use 4-6 H2 sections.",
    "Comprehensive (3,000+ words)": (
        "Structure: use at least 6 H2 sections to cover the topic fully."
    ),
}

# Per-content-type structural directives — tells the model exactly how to
# format the article, not just what category it belongs to.
_CONTENT_TYPE_DIRECTIVES: dict[str, str] = {
    "Blog Article": (
        "Format: write a standard blog article with an engaging introduction, "
        "well-structured body sections, and a conclusion."
    ),
    "How-To Guide": (
        "Format: write a step-by-step how-to guide. Open with a brief intro "
        "explaining what the reader will accomplish, then present each step as a "
        "numbered item under clear H2/H3 headings. Each step must include the "
        "action and the reason or expected result."
    ),
    "Listicle": (
        "Format: write a listicle. Organise the entire body around a numbered "
        "or bulleted list of distinct items — each item gets its own H2 or H3 "
        "heading followed by a substantive explanation. The number of items "
        "should be appropriate for the target length."
    ),
    "Product Review": (
        "Format: write a product review. Include sections for overview, key "
        "features, pros and cons, and a final verdict. Be specific and "
        "evidence-based; avoid vague praise. State what the product does well "
        "and where it falls short."
    ),
    "Comparison Article": (
        "Format: write a comparison article. Structure it to clearly contrast "
        "the options being compared using parallel sections for each option. "
        "Close with a summary recommendation that helps the reader choose."
    ),
    "News Article": (
        "Format: write a news article using the inverted pyramid — lead with the "
        "most important facts in the first paragraph, then add context and "
        "supporting detail in decreasing order of importance. Keep the tone "
        "factual and direct."
    ),
    "Case Study": (
        "Format: write a case study structured around the challenge, the approach "
        "taken, and the measurable outcome. Use concrete details, specific data "
        "points, and named results. Avoid vague generalisations."
    ),
    "Opinion / Editorial": (
        "Format: write an opinion or editorial piece. Open with a clear, bold "
        "thesis. Build the argument in logical sections, address likely "
        "objections, and close with a decisive conclusion. The perspective should "
        "be distinctive, not neutral."
    ),
    "Press Release": (
        "Format: write a press release. Lead with the announcement headline, "
        "follow with a dateline and opening paragraph covering who/what/when/"
        "where/why, then add supporting quotes and detail. Keep paragraphs short "
        "and factual."
    ),
    "Landing Page Copy": (
        "Format: write landing page copy focused on a single value proposition. "
        "Address the reader's key pain points, lead with benefits not features, "
        "and keep each section concise and action-oriented."
    ),
    "Product Description": (
        "Format: write a product description. Lead with the primary benefit, "
        "explain key features in terms of user benefit (not spec lists), and use "
        "concrete, specific language. Avoid vague praise like 'premium quality'."
    ),
    "Buying Guide": (
        "Format: write a buying guide covering what to look for, how to evaluate "
        "options, common mistakes buyers make, and a decision framework. Be "
        "practical and specific."
    ),
    "Tutorial": (
        "Format: write a tutorial. Open with prerequisites and what the reader "
        "will learn, then walk through each step with clear, actionable "
        "instructions. Include expected outcomes or checkpoints where relevant."
    ),
    "Industry Report Summary": (
        "Format: write an industry report summary. Present key findings, data "
        "points, and trends in a structured, authoritative way. Name specific "
        "figures and trends clearly — do not generalise."
    ),
    "FAQ Page": (
        "Format: write an FAQ page structured entirely as question-and-answer "
        "pairs. Each question is an H2 or H3 heading followed directly by a "
        "concise, direct answer. Do not use a standard article body structure — "
        "the entire piece is Q&A."
    ),
    "Glossary / Definition Article": (
        "Format: write a glossary or definition article. Each term gets its own "
        "section with a clear, precise definition followed by context, usage, and "
        "a concrete example."
    ),
    "Interview-Style Article": (
        "Format: write an interview-style piece using a Q&A structure with "
        "clearly labelled questions and responses. The tone should feel "
        "conversational and authentic, as if from a real exchange."
    ),
}

# Per-writing-style behavioural directives.
_WRITING_STYLE_DIRECTIVES: dict[str, str] = {
    "Narrative / storytelling": (
        "Writing style: use a narrative approach — lead with a relatable "
        "scenario or real-world situation, develop ideas through examples and "
        "concrete cases rather than abstract exposition, and maintain a sense "
        "of progression through the piece."
    ),
    "Descriptive": (
        "Writing style: use a descriptive approach — build clear mental pictures "
        "through specific, concrete detail. Avoid vague adjectives; make "
        "descriptions grounded and precise."
    ),
    "Persuasive": (
        "Writing style: write persuasively — present a clear point of view, "
        "support claims with evidence and reasoning, address likely objections, "
        "and guide the reader toward a conclusion."
    ),
    "Expository / informative": (
        "Writing style: write in an expository, informative style — explain "
        "clearly, build understanding step by step, and prioritise accuracy and "
        "clarity over personality or persuasion."
    ),
    "Technical / instructional": (
        "Writing style: use a technical, instructional style — be precise with "
        "terminology, give specific steps or criteria rather than general advice, "
        "and write for a reader who wants to understand exactly how something "
        "works or how to do it."
    ),
    "Conversational / casual": (
        "Writing style: use a conversational, casual style — write as a "
        "knowledgeable person explaining the topic to a friend. Use contractions, "
        "everyday vocabulary, and direct address ('you'). Avoid formal or stiff "
        "phrasing."
    ),
}

# Per-tone-of-voice directives.
_TONE_DIRECTIVES: dict[str, str] = {
    "Professional": (
        "Tone: write in a professional, polished voice. Maintain credibility and "
        "authority throughout; avoid slang or overly casual phrasing."
    ),
    "Conversational": (
        "Tone: write in a conversational voice — approachable, direct, and easy "
        "to read aloud. Use contractions and plain language."
    ),
    "Friendly": (
        "Tone: write in a friendly, warm voice. Be encouraging and accessible; "
        "the reader should feel at ease."
    ),
    "Authoritative": (
        "Tone: write with authority. State positions and findings with confidence; "
        "back claims with specifics rather than hedging language."
    ),
    "Witty / humorous": (
        "Tone: bring wit and light humour to the piece. Use dry observations or "
        "wordplay where natural — the humour should serve the content, not "
        "distract from it."
    ),
    "Empathetic": (
        "Tone: write with empathy. Acknowledge the reader's situation or "
        "challenges, and frame information in a way that feels supportive rather "
        "than prescriptive."
    ),
    "Formal": (
        "Tone: maintain a formal register throughout. Avoid contractions, "
        "colloquialisms, or casual phrasing. Write as you would for a "
        "professional publication or academic audience."
    ),
    "Inspirational": (
        "Tone: write with an inspirational voice. Use positive framing, "
        "motivational language, and examples that emphasise possibility and "
        "achievement."
    ),
    "Technical": (
        "Tone: use a precise, technical tone. Prioritise accuracy and specificity "
        "over readability shortcuts; your audience expects correct terminology "
        "and rigorous detail."
    ),
    "Bold / confident": (
        "Tone: write with a bold, confident voice. Take clear positions; avoid "
        "wishy-washy qualifications. The article should have a distinct point "
        "of view."
    ),
}

# Per-content-depth audience and complexity directives.
_DEPTH_DIRECTIVES: dict[str, str] = {
    "Beginner-friendly overview": (
        "Depth: write for readers with no prior background on this topic. "
        "Define all specialised terms when first used. Use relatable analogies "
        "and simple, concrete examples. Avoid assumed knowledge — if a concept "
        "requires prior understanding, briefly explain it first. Do not use "
        "jargon without defining it."
    ),
    "Standard / balanced": (
        "Depth: write at a standard, balanced level — accessible to a general "
        "reader but not so simplified that it's vague. Assume basic familiarity "
        "with the topic without requiring deep expertise."
    ),
    "In-depth / comprehensive": (
        "Depth: write an in-depth, thorough treatment. Cover nuances, edge cases, "
        "and less-obvious considerations. Assume the reader has working knowledge "
        "and can handle detailed explanations. Do not over-simplify."
    ),
    "Expert-level / technical": (
        "Depth: write for domain experts. Use precise technical terminology "
        "without defining common concepts. Engage at the depth and specificity "
        "an experienced practitioner would find genuinely useful — not a "
        "surface-level treatment they already know."
    ),
}

# Brand personality trait → concrete writing quality descriptor.
_PERSONALITY_DESCRIPTORS: dict[str, str] = {
    "Innovative": "forward-thinking and fresh — avoid clichés and generic phrasing",
    "Trustworthy": "reliable and credible — back claims with specifics",
    "Bold": "direct and willing to take a clear position",
    "Friendly": "warm and approachable",
    "Premium / luxury": "polished, elevated, and detail-oriented",
    "Playful": "light and engaging with well-placed wit",
    "Authoritative": "confident and expert",
    "Minimalist": "clear and concise — every sentence must earn its place",
    "Empathetic": "understanding and supportive in tone",
    "Quirky": "distinctive and a little unexpected — avoid generic or predictable phrasing",
}


def _compile_writing_guidelines(options: PromptTemplateOptions) -> str:
    lines = [
        "Write in clear prose, organised with descriptive H2/H3 headings and "
        "well-formed paragraphs and lists where they aid readability.",
        _LENGTH_TARGETS[options.article_length],
        _LENGTH_SECTION_GUIDANCE[options.article_length],
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
    lines: list[str] = []

    # Content type — structural format directive
    directive = _CONTENT_TYPE_DIRECTIVES.get(
        options.content_type, f"Format: write this as a {options.content_type}."
    )
    lines.append(directive)

    # Target audience — directive framing
    if options.target_audience.strip():
        lines.append(
            f"Audience: write for {options.target_audience.strip()} — "
            "tailor examples, vocabulary, and framing specifically to this audience."
        )

    # Tone of voice — directive
    tone_directive = _TONE_DIRECTIVES.get(
        options.tone_of_voice, f"Tone: write in a {options.tone_of_voice} voice."
    )
    lines.append(tone_directive)

    # Writing style — behavioural directive
    style_directive = _WRITING_STYLE_DIRECTIVES.get(
        options.writing_style, f"Writing style: {options.writing_style}."
    )
    lines.append(style_directive)

    # Brand personality — tone quality descriptors
    if options.brand_personality:
        descriptors = [
            _PERSONALITY_DESCRIPTORS.get(trait, trait.lower())
            for trait in options.brand_personality
        ]
        lines.append(
            f"Brand voice: the article should feel {', '.join(descriptors)}."
        )

    # Content depth — directive with vocabulary/complexity guidance
    depth_directive = _DEPTH_DIRECTIVES.get(
        options.content_depth,
        f"Depth: {options.content_depth} — {_DEPTH_DESCRIPTIONS[options.content_depth]}.",
    )
    lines.append(depth_directive)

    return "CONFIGURATION\n" + "\n".join(lines)


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
