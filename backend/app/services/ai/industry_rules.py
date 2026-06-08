"""
Per-industry factual context blocks for the prompt builder's INDUSTRY RULES layer.

Deliberate design contrast with the retired ``content_optimization.py``: that
module's blocks announced themselves as authoritative ("CONTENT OPTIMIZATION —
SEO MODE… applies to this article… carries the same weight as system-prompt
rules"). These blocks do the opposite on purpose — they read as plain facts
about the subject matter ("this article sits in the legal industry, where...")
with no claim to priority at all, because a fact cannot outrank an instruction
and isn't trying to. That register choice is what lets §19 Additional
Instructions remain the only imperative free-text layer in the compiled prompt
— see CONTENT_ENGINE_V2_PLAN.md "How V2 avoids repeating the regression".

"Other / general" intentionally returns an empty string: a generic industry
adds no useful factual grounding, and an empty block is better than a vague one.
"""

from __future__ import annotations

from app.schemas.content_brief import Industry

_INDUSTRY_CONTEXT: dict[str, str] = {
    "Legal": (
        "Industry context: this article sits in the legal field. Readers expect precise "
        "terminology, awareness that laws vary by jurisdiction, and a clear distinction "
        "between general information and formal legal advice."
    ),
    "Healthcare": (
        "Industry context: this article sits in healthcare. Readers expect clinically "
        "accurate language, awareness that individual medical situations vary, and a "
        "clear distinction between general health information and personal medical advice."
    ),
    "Finance": (
        "Industry context: this article sits in finance. Readers expect accurate use of "
        "financial terminology, awareness that figures and regulations change over time "
        "and by region, and a clear distinction between general information and personal "
        "financial advice."
    ),
    "Technology / SaaS": (
        "Industry context: this article sits in technology / SaaS. Readers range from "
        "technical evaluators to non-technical decision-makers; precise product and "
        "category terminology matters, and claims about capability or performance should "
        "be concrete rather than promotional."
    ),
    "E-commerce / Retail": (
        "Industry context: this article sits in e-commerce / retail. Readers are often "
        "comparing options before a purchase decision; concrete product, pricing, and "
        "use-case details are more useful than generic praise."
    ),
    "Real Estate": (
        "Industry context: this article sits in real estate. Readers expect awareness "
        "that markets, prices, and regulations vary by location and change over time, "
        "and concrete, locality-aware framing rather than universal claims."
    ),
    "Education": (
        "Industry context: this article sits in education. Readers range from learners "
        "to educators to decision-makers evaluating programs; clarity, accurate use of "
        "academic terminology, and concrete examples matter more than broad claims."
    ),
    "Travel & Hospitality": (
        "Industry context: this article sits in travel & hospitality. Readers are often "
        "planning a real trip or stay; concrete, current, location-specific detail is "
        "more useful than generic destination praise."
    ),
    "Marketing & Advertising": (
        "Industry context: this article sits in marketing & advertising. Readers are "
        "often practitioners evaluating tactics or tools; concrete examples, named "
        "approaches, and honest tradeoffs matter more than buzzword-driven framing."
    ),
    "Manufacturing": (
        "Industry context: this article sits in manufacturing. Readers expect accurate "
        "technical and process terminology, and concrete operational detail rather than "
        "broad claims about efficiency or quality."
    ),
    "Food & Beverage": (
        "Industry context: this article sits in food & beverage. Readers respond to "
        "concrete sensory and practical detail (ingredients, preparation, sourcing) "
        "rather than generic descriptions like 'delicious' or 'high quality'."
    ),
    "Fitness & Wellness": (
        "Industry context: this article sits in fitness & wellness. Readers expect "
        "awareness that individual results and needs vary, accurate use of health and "
        "exercise terminology, and a clear distinction between general guidance and "
        "personal medical or training advice."
    ),
    "Automotive": (
        "Industry context: this article sits in automotive. Readers expect accurate "
        "technical terminology and concrete, model/spec-aware detail rather than broad "
        "claims about performance or reliability."
    ),
    "Non-profit": (
        "Industry context: this article sits in the non-profit sector. Readers respond "
        "to concrete impact detail (who is affected, how, and by how much) rather than "
        "broad appeals; tone should be sincere rather than promotional."
    ),
    "Other / general": "",
}


def build_industry_context_block(industry: Industry) -> str:
    """Return the factual context block for the given industry, or "" for the
    catch-all "Other / general" (and any value not in the map, defensively)."""
    return _INDUSTRY_CONTEXT.get(industry, "")
