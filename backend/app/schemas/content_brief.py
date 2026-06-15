"""
Structured content brief — the V2 per-article configuration shape.

``ContentBrief`` is the 19-section structured form described in
CONTENT_CONFIGURATION_PANEL_PLAN.md.  It is consumed by
``app.services.ai.prompt_builder.PromptBuilderService`` to compile a
hierarchically-ordered prompt where user authority is true by construction
(see that module and CONTENT_ENGINE_V2_PLAN.md).

IMPORTANT — separation of concerns
-----------------------------------
``PromptTemplateOptions`` (bottom of this file) is the *separate, slimmer*
sibling used by the live Prompts-tab guided builder
(``app.services.ai.prompt_template_builder``).  The type aliases it relies on
(``ContentType``, ``Industry``, ``ToneOfVoice``, ``WritingStyle``,
``BrandPersonalityTrait``, ``ContentDepth``, ``ArticleLength``,
``EEATOption``, ``SEOOption``, ``ContentRestriction``) are kept here unchanged
for backward compat.  Do NOT alter them — the Prompts-tab builder is live.

``ContentBrief`` uses its own, differently-named type aliases that match the
final spec in CONTENT_CONFIGURATION_PANEL_PLAN.md §2.  The two schemas share
no types, by design: they serve different surfaces and may evolve independently.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# ===========================================================================
# ── LEGACY TYPES — used exclusively by PromptTemplateOptions (live feature)
#    Do not change option sets; the prompt_template_builder.py compilers
#    reference these literal values directly.
# ===========================================================================

ContentType = Literal[
    "Blog Article",
    "How-To Guide",
    "Listicle",
    "Product Review",
    "Comparison Article",
    "News Article",
    "Case Study",
    "Opinion / Editorial",
    "Press Release",
    "Landing Page Copy",
    "Product Description",
    "Buying Guide",
    "Tutorial",
    "Industry Report Summary",
    "FAQ Page",
    "Glossary / Definition Article",
    "Interview-Style Article",
]

Industry = Literal[
    "Legal",
    "Healthcare",
    "Finance",
    "Technology / SaaS",
    "E-commerce / Retail",
    "Real Estate",
    "Education",
    "Travel & Hospitality",
    "Marketing & Advertising",
    "Manufacturing",
    "Food & Beverage",
    "Fitness & Wellness",
    "Automotive",
    "Non-profit",
    "Other / general",
]

ToneOfVoice = Literal[
    "Professional",
    "Conversational",
    "Friendly",
    "Authoritative",
    "Witty / humorous",
    "Empathetic",
    "Formal",
    "Inspirational",
    "Technical",
    "Bold / confident",
]

WritingStyle = Literal[
    "Narrative / storytelling",
    "Descriptive",
    "Persuasive",
    "Expository / informative",
    "Technical / instructional",
    "Conversational / casual",
]

BrandPersonalityTrait = Literal[
    "Innovative",
    "Trustworthy",
    "Bold",
    "Friendly",
    "Premium / luxury",
    "Playful",
    "Authoritative",
    "Minimalist",
    "Empathetic",
    "Quirky",
]

ContentDepth = Literal[
    "Beginner-friendly overview",
    "Standard / balanced",
    "In-depth / comprehensive",
    "Expert-level / technical",
]

ArticleLength = Literal[
    "Short (600-900 words)",
    "Medium (1,000-1,800 words)",
    "Long (1,800-3,000 words)",
    "Comprehensive (3,000+ words)",
]

EEATOption = Literal[
    "Add Expert Opinions",
    "Add Statistics",
    "Add Research",
    "Add Case Studies",
    "Add Real Examples",
    "Add Industry Benchmarks",
    "Add FAQs",
]

SEOOption = Literal[
    "Generate Meta Title",
    "Generate Meta Description",
    "Generate FAQ Schema",
    "Generate Article Schema",
    "Generate Internal Linking",
    "Optimize for Featured Snippet",
    "Generate Social Snippets",
    "Generate Image Alt Text",
]

ContentRestriction = Literal[
    "No competitor mentions",
    "No pricing or cost claims",
    "No medical, legal, or financial advice claims",
    "No first-person voice ('I', 'we')",
    "No emojis",
    "No exclamation points",
    "Avoid superlatives ('best', '#1', 'guaranteed')",
    "No fabricated statistics, names, or citations",
]


# ===========================================================================
# ── CONTENT BRIEF V2 TYPES — used exclusively by ContentBrief
#    Named distinctly to avoid confusion with the legacy aliases above.
#    Option sets match the final spec in CONTENT_CONFIGURATION_PANEL_PLAN.md §2.
# ===========================================================================

# §1 — 12 content types covering both format and SEO-architecture categories
BriefContentType = Literal[
    "Blog Article",
    "How-To Guide",
    "Listicle / List Article",
    "Product Review",
    "Comparison Article",
    "Case Study",
    "Service Page",
    "Location Page",
    "Pillar Page / In-Depth Guide",
    "FAQ Page",
    "Landing Page Copy",
    "Product Description",
]

# §4 — 10 named audience segments (closed dropdown)
BriefTargetAudience = Literal[
    "General Public",
    "Business Owners",
    "Marketing Professionals",
    "Developers / Technical Audience",
    "Healthcare Professionals",
    "Finance / Legal Professionals",
    "Students / Beginners",
    "Young Adults (Gen Z / Millennials)",
    "Small Business Owners",
    "Enterprise / B2B Buyers",
]

# §5 — 11 tone options
BriefToneOfVoice = Literal[
    "Professional",
    "Conversational",
    "Friendly",
    "Authoritative",
    "Witty / Humorous",
    "Empathetic",
    "Formal",
    "Inspirational",
    "Technical",
    "Bold / Confident",
    "Neutral / Balanced",
]

# §6 — 11 conversation style options (distinct from tone — the structural register
# and storytelling approach, not the emotional quality)
ConversationStyle = Literal[
    "Thought Leadership",
    "Storytelling / Narrative",
    "Educational / Tutorial",
    "Persuasive / Sales",
    "Investigative / Journalistic",
    "Interview / Q&A",
    "Opinionated / Editorial",
    "Step-by-Step Guide",
    "Analytical / Data-Driven",
    "Casual / Blog",
    "Expert Commentary",
]

# §7 — 5 depth levels (different labeling from the legacy ContentDepth)
BriefContentDepth = Literal[
    "Basic",
    "Standard",
    "In-Depth",
    "Comprehensive",
    "Ultimate Guide",
]

# §9 — 5 search intent options (adds "Local" vs. the legacy 4-option set)
BriefSearchIntent = Literal[
    "Informational",
    "Navigational",
    "Commercial",
    "Transactional",
    "Local",
]

# §11 — Content Optimization checkboxes (see CONTENT_CONFIGURATION_PANEL_PLAN.md §0.3
# and §4.3 for the exact compilation design — each option becomes ONE falsifiable
# instruction line in the OPTIMIZATION RULES layer, never a "mode" block)
ContentOptimizationOption = Literal[
    "SEO",
    "AEO (Answer Engine Optimization)",
    "GEO (Generative Engine Optimization)",
    "EEAT",
    "Featured Snippet Optimization",
    "Voice Search Optimization",
]

# §12 — Include Data & Research checkboxes (same falsifiable-line pattern as §11)
DataResearchOption = Literal[
    "Statistics",
    "Case Studies",
    "Expert Quotes",
    "Research Studies",
    "Industry Reports",
    "Real-World Examples",
]

# §13 — Readability level (6 options spanning general public to academic)
ReadabilityLevel = Literal[
    "General Public (8th Grade)",
    "Casual Reader",
    "Informed Reader",
    "Professional Audience",
    "Technical Expert",
    "Academic",
]

# §14 — Brand personality checkboxes (9 options — a subset of the legacy trait set,
# rationalized for the new surface)
BriefBrandPersonality = Literal[
    "Trustworthy",
    "Innovative",
    "Bold",
    "Friendly",
    "Premium / Luxury",
    "Playful",
    "Authoritative",
    "Minimalist",
    "Empathetic",
]

# §15 — Content structure checkboxes (which named sections to include)
ContentStructureOption = Literal[
    "Introduction",
    "Quick Answer / TL;DR",
    "Table of Contents",
    "Key Takeaways",
    "Pros and Cons",
    "Step-by-Step Breakdown",
    "FAQs",
    "CTA (Call to Action)",
    "Summary / Conclusion",
]


# ===========================================================================
# ── ContentBrief — the 19-section structured input for guided generation
# ===========================================================================


class ContentBrief(BaseModel):
    """19-section structured brief consumed by PromptBuilderService.compile().

    Wire format uses camelCase JSON (alias_generator below) — the Pydantic model
    internally uses snake_case consistent with the rest of app.schemas.*.

    Required fields: content_type (§1), primary_keyword (§2).
    All others are optional with sensible defaults so a partially-filled brief
    is still valid at commit time — the UI enforces the required fields.
    """

    model_config = {
        "populate_by_name": True,
    }

    # §1 Content Type — required
    content_type: BriefContentType = Field(description="§1 Content Type")

    # §2 Primary Keyword — required
    primary_keyword: str = Field(min_length=1, max_length=200, description="§2 Primary Keyword")

    # §3 Secondary Keywords — optional list, up to 20 items of ≤100 chars each
    secondary_keywords: list[str] = Field(
        default_factory=list,
        max_length=20,
        description="§3 Secondary Keywords",
    )

    # §4 Target Audience — optional closed dropdown
    target_audience: BriefTargetAudience | None = Field(default=None, description="§4 Target Audience")

    # §5 Tone of Voice — optional
    tone_of_voice: BriefToneOfVoice | None = Field(default=None, description="§5 Tone of Voice")

    # §6 Conversation Style — optional
    conversation_style: ConversationStyle | None = Field(default=None, description="§6 Conversation Style")

    # §7 Content Depth — optional, default "Standard"
    content_depth: BriefContentDepth = Field(default="Standard", description="§7 Content Depth")

    # §8 Content Length — integer word-count target (500–5000), default 2000
    content_length: int = Field(default=2000, ge=500, le=5000, description="§8 Content Length (words)")

    # §9 Search Intent — optional
    search_intent: BriefSearchIntent | None = Field(default=None, description="§9 Search Intent")

    # §10 FAQ Generation — boolean toggle, default true
    faq_generation: bool = Field(default=True, description="§10 FAQ Generation")

    # §11 Content Optimization — up to 6 checked options (see §0.3 and §4.3 of the plan
    # for the falsifiable-line compilation design that makes this safe to re-introduce)
    content_optimization: list[ContentOptimizationOption] = Field(
        default_factory=list,
        max_length=len(ContentOptimizationOption.__args__),
        description="§11 Content Optimization",
    )

    # §12 Include Data & Research — up to 6 checked options
    data_research: list[DataResearchOption] = Field(
        default_factory=list,
        max_length=len(DataResearchOption.__args__),
        description="§12 Include Data & Research",
    )

    # §13 Readability Level — optional
    readability_level: ReadabilityLevel | None = Field(default=None, description="§13 Readability Level")

    # §14 Brand Personality — up to 9 checked options
    brand_personality: list[BriefBrandPersonality] = Field(
        default_factory=list,
        max_length=len(BriefBrandPersonality.__args__),
        description="§14 Brand Personality",
    )

    # §15 Content Structure — which named sections to include
    content_structure: list[ContentStructureOption] = Field(
        default_factory=list,
        max_length=len(ContentStructureOption.__args__),
        description="§15 Content Structure",
    )

    # §16 AI Humanization Level — 0–100, default 80 (drives post-generation
    # execute_structural_humanization() params; never enters the prompt as text)
    humanization_level: int = Field(default=80, ge=0, le=100, description="§16 AI Humanization Level")

    # §17 Creativity Level — 0–100, default 60 (compiles to a creative-range
    # note in the prompt; NOT the OpenAI temperature param — gpt-5.5 ignores it)
    creativity_level: int = Field(default=60, ge=0, le=100, description="§17 Creativity Level")

    # §18 Use Website Data — gates injection of brand identity / site / product context
    use_website_data: bool = Field(default=True, description="§18 Use Website Data")

    # §19 Custom Instructions — THE ONLY free-text, imperative-register field.
    # Compiled last with USER PROMPT AUTHORITY framing — uncontested because every
    # other layer is factual statements, parameterized requirements, or checklist lines.
    custom_instructions: str = Field(default="", max_length=20_000, description="§19 Custom Instructions")


# ===========================================================================
# ── ContentBriefDraft — loosely-typed autosave shape for in-progress edits
# ===========================================================================


class ContentBriefDraft(BaseModel):
    """Permissive autosave container — every field optional, no enum enforcement.

    Stored separately from the committed brief (content_brief_draft vs.
    content_brief on the article document) so mid-panel edits never clobber
    the last generation-ready brief.  Full validation only happens at commit
    (PUT .../content-brief via ContentBrief).
    """

    model_config = {"extra": "allow"}

    values: dict = Field(default_factory=dict, description="Partial field values keyed by ContentBrief field name")
    saved_at: str = Field(default="", max_length=64)


# ===========================================================================
# ── GET response shape
# ===========================================================================


class ContentBriefResponse(BaseModel):
    brief: ContentBrief | None = None
    draft: ContentBriefDraft | None = None


# ===========================================================================
# ── Brief templates — reusable presets (parallel to project writing prompts)
# ===========================================================================


class ContentBriefTemplate(BaseModel):
    id: str
    name: str
    brief: ContentBrief


class ContentBriefTemplateListResponse(BaseModel):
    items: list[ContentBriefTemplate]
    default_id: str | None = None


class ContentBriefTemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    brief: ContentBrief


class ContentBriefTemplateUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    brief: ContentBrief | None = None


class SetDefaultBriefTemplateRequest(BaseModel):
    id: str = Field(min_length=1, max_length=100)


# ===========================================================================
# ── PromptTemplateOptions — LIVE: used by the Prompts-tab guided builder
#    (app.services.ai.prompt_template_builder + app.api.routes.prompts).
#    Do NOT alter this class or the legacy type aliases it depends on above.
# ===========================================================================


class PromptTemplateOptions(BaseModel):
    """Structured options for the Prompts module's guided 'Add new prompt' builder.

    A deliberately *separate, slimmer* sibling of ``ContentBrief`` — not a
    reuse — because this compiles a reusable **prompt template** rather than
    a per-article brief.  The fields that vary per article in ``ContentBrief``
    (``primary_keyword``, ``secondary_keywords``, ``search_intent``,
    ``faq_generation``) have no place here: the compiled template represents
    them with the standard ``{article_title}`` / ``{focus_keyphrase}`` /
    ``{targeting_keywords}`` placeholder tokens instead, so one template stays
    reusable across any article.
    """

    content_type: ContentType = Field(description="Content type")
    target_audience: str = Field(default="", max_length=300, description="Target audience")
    industry: Industry = Field(default="Other / general", description="Industry")
    tone_of_voice: ToneOfVoice = Field(description="Tone of voice")
    writing_style: WritingStyle = Field(description="Writing style")
    brand_personality: list[BrandPersonalityTrait] = Field(
        default_factory=list, max_length=len(BrandPersonalityTrait.__args__),
        description="Brand personality traits",
    )
    content_depth: ContentDepth = Field(description="Content depth")
    article_length: ArticleLength = Field(description="Article length")
    eeat_settings: list[EEATOption] = Field(
        default_factory=list, max_length=len(EEATOption.__args__), description="EEAT additions"
    )
    seo_settings: list[SEOOption] = Field(
        default_factory=list, max_length=len(SEOOption.__args__), description="SEO additions"
    )
    content_restrictions: list[ContentRestriction] = Field(
        default_factory=list, max_length=len(ContentRestriction.__args__), description="Content restrictions"
    )
    use_website_data: bool = Field(default=True, description="Fold in brand identity / site / product context")
    additional_instructions: str = Field(default="", max_length=20_000, description="Additional instructions")
