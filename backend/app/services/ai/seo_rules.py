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
    "Generate Meta Title": "Generate a meta title that accurately reflects the article's content and primary keyword.",
    "Generate Meta Description": "Generate a meta description that accurately summarizes the article and includes the primary keyword.",
    "Generate FAQ Schema": "Structure any FAQ content so it can be represented as FAQ schema markup (clear question/answer pairs).",
    "Generate Article Schema": "Ensure the article has a clear headline, author voice, and structure consistent with Article schema markup.",
    "Generate Internal Linking": "Where natural, reference related topics in a way that supports internal linking.",
    "Optimize for Featured Snippet": "Include at least one concise, direct-answer passage (40-60 words) positioned to be eligible for a featured snippet.",
    "Generate Social Snippets": "Include a short summary suitable for sharing on social media, distinct from the meta description.",
    "Generate Image Alt Text": "Write descriptive, specific alt text for any images that accurately describes their content.",
}


def build_eeat_lines(options: list[EEATOption]) -> list[str]:
    """One factual instruction line per checked EEAT option, in spec order."""
    return [_EEAT_LINES[opt] for opt in EEATOption.__args__ if opt in options]


def build_seo_lines(options: list[SEOOption]) -> list[str]:
    """One factual instruction line per checked SEO option, in spec order."""
    return [_SEO_LINES[opt] for opt in SEOOption.__args__ if opt in options]
