"""
EEAT / SEO checkbox compilers — the structural replacement for
``content_optimization.py``'s "MODE" blocks.

The retired module turned a handful of toggles into multi-line blocks that
announced their own authority ("CONTENT OPTIMIZATION — SEO MODE… applies to
this article… carries the same weight as system-prompt rules"). That framing
is exactly what made it compete with the user's prompt instead of serving it.

Here, each checked box becomes exactly ONE short, factual, falsifiable
instruction line — same register as the rest of SYSTEM RULES, no "mode",
no "applies to this article", no claim to weight or priority. A line either
gets satisfied or it doesn't; there's nothing to "outrank" because there's
no competing claim being made in the first place.
"""

from __future__ import annotations

from app.schemas.content_brief import EEATOption, SEOOption

_EEAT_LINES: dict[str, str] = {
    "Add Expert Opinions": "Include at least one perspective framed as an expert or practitioner viewpoint.",
    "Add Statistics": "Include at least one specific, named statistic relevant to the topic.",
    "Add Research": "Reference at least one study, report, or research finding relevant to the topic.",
    "Add Case Studies": "Include at least one concrete example framed as a real-world case or scenario.",
    "Add Real Examples": "Include concrete, specific examples rather than generic or hypothetical ones.",
    "Add Industry Benchmarks": "Reference at least one industry benchmark, standard, or typical-range figure relevant to the topic.",
    "Add FAQs": "Include a short FAQ section answering common questions a reader would have on this topic.",
}

_SEO_LINES: dict[str, str] = {
    # Output-field hints — explicitly scoped to the JSON fields, never article_markdown.
    "Generate Meta Title": (
        "Craft the meta_title output field (separate JSON field, never inside article_markdown) "
        "to precisely reflect the article and include the primary keyword (≤60 chars where possible)."
    ),
    "Generate Meta Description": (
        "Craft the meta_description output field (separate JSON field, never inside article_markdown) "
        "to summarize the article and include the primary keyword (≤155 chars where possible)."
    ),
    # Article-body structural hints.
    "Generate FAQ Schema": "Structure any FAQ content as clearly separated question/answer pairs eligible for FAQ schema markup.",
    "Generate Article Schema": "Ensure the article has a clear headline, defined sections, and structured layout consistent with Article schema.",
    "Generate Internal Linking": "Where natural, reference related topics in a way that supports internal linking.",
    "Optimize for Featured Snippet": "Include at least one concise, direct-answer passage (40–60 words) near the top of a relevant section.",
    "Generate Social Snippets": "Include a brief, shareable pull-quote callout within the article body (clearly distinct from, and never a substitute for, the meta description).",
    "Generate Image Alt Text": "Where images would naturally appear, add a bracketed alt-text note in the format: [Image: descriptive alt text here].",
}


def build_eeat_lines(options: list[EEATOption]) -> list[str]:
    """One factual instruction line per checked EEAT option, in spec order."""
    return [_EEAT_LINES[opt] for opt in EEATOption.__args__ if opt in options]


def build_seo_lines(options: list[SEOOption]) -> list[str]:
    """One factual instruction line per checked SEO option, in spec order."""
    return [_SEO_LINES[opt] for opt in SEOOption.__args__ if opt in options]
