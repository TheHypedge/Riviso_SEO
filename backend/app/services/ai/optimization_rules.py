"""
§11 Content Optimization + §12 Data & Research checkbox compilers.

Both sections use the identical falsifiable-single-line pattern: each checked
option becomes exactly ONE short, factual, independently-verifiable instruction
line in the OPTIMIZATION RULES layer of the compiled prompt.

This is the structural resolution to the §0.3 flag in
CONTENT_CONFIGURATION_PANEL_PLAN.md: the options (SEO, AEO, GEO, EEAT, ...)
are conceptually the same family as the retired ``content_optimization.py``
surface, but the compilation design is opposite.  That module turned checkboxes
into multi-line blocks that announced their own authority ("CONTENT OPTIMIZATION
— SEO MODE... carries the same weight as system-prompt rules").  Each line here
is independently true-or-false against the finished draft; there is nothing to
"outrank" because no competing claim is being made.

See CONTENT_CONFIGURATION_PANEL_PLAN.md §4.3 for the worked example table that
demonstrates concretely why each of the §11 lines is safe.
"""

from __future__ import annotations

from app.schemas.content_brief import ContentOptimizationOption, DataResearchOption

# ---------------------------------------------------------------------------
# §11 — Content Optimization lines (worked example from §4.3 of the plan)
# ---------------------------------------------------------------------------

_CONTENT_OPTIMIZATION_LINES: dict[str, str] = {
    "SEO": (
        "Use the primary keyword naturally in the title, the opening paragraph, "
        "and at least one heading."
    ),
    "AEO (Answer Engine Optimization)": (
        "Phrase at least one passage as a direct, self-contained answer to a "
        "question the target audience would plausibly ask."
    ),
    "GEO (Generative Engine Optimization)": (
        "Write so that an AI system summarizing this content could extract accurate "
        "claims without ambiguity — define terms on first use and avoid unresolvable "
        "pronoun references."
    ),
    "EEAT": (
        "Demonstrate expertise and trustworthiness through specific, checkable details "
        "rather than general claims of authority."
    ),
    "Featured Snippet Optimization": (
        "Include one concise, 40–60 word passage that directly answers the primary "
        "keyword's implied question, positioned where a search engine could lift it "
        "as a featured snippet."
    ),
    "Voice Search Optimization": (
        "Phrase at least one heading or passage as a natural spoken question and answer "
        "(e.g. 'How much does X cost?' followed by a direct answer)."
    ),
}

# ---------------------------------------------------------------------------
# §12 — Data & Research lines
# ---------------------------------------------------------------------------

_DATA_RESEARCH_LINES: dict[str, str] = {
    "Statistics": (
        "Include at least one specific, named statistic or data point relevant to the topic."
    ),
    "Case Studies": (
        "Include at least one concrete example framed as a real-world case or scenario."
    ),
    "Expert Quotes": (
        "Include at least one perspective framed as an expert or practitioner viewpoint."
    ),
    "Research Studies": (
        "Reference at least one study, report, or research finding relevant to the topic."
    ),
    "Industry Reports": (
        "Reference at least one industry benchmark, standard, or typical-range figure "
        "relevant to the topic."
    ),
    "Real-World Examples": (
        "Include concrete, specific examples grounded in real situations rather than "
        "generic or hypothetical ones."
    ),
}


def build_content_optimization_lines(options: list[ContentOptimizationOption]) -> list[str]:
    """One falsifiable instruction line per checked §11 option, in spec order."""
    return [
        _CONTENT_OPTIMIZATION_LINES[opt]
        for opt in ContentOptimizationOption.__args__
        if opt in options
    ]


def build_data_research_lines(options: list[DataResearchOption]) -> list[str]:
    """One falsifiable instruction line per checked §12 option, in spec order."""
    return [
        _DATA_RESEARCH_LINES[opt]
        for opt in DataResearchOption.__args__
        if opt in options
    ]
