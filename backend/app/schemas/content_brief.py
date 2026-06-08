"""
Structured content brief — the V2 replacement input shape for article generation.

This schema defines the 19-section guided form described in the Content Engine V2
specification. It is consumed by ``app.services.ai.prompt_builder.PromptBuilderService``
to compile a hierarchically-ordered prompt (see CONTENT_ENGINE_V2_PLAN.md).

Design note — option sets: every ``Literal`` enum below that wasn't explicitly
enumerated in the V2 spec (Content Goal, Tone of Voice, Writing Style, Brand
Personality, Content Depth, Article Length, Content Restrictions) is a *proposed*
option set sized for a clean checkbox/dropdown UI. These are product decisions —
treat them as a starting point for review, not a final word; narrowing or renaming
them later is a schema change, not a redesign. The two sets the spec gave verbatim
(Content Type's 17 options, EEAT Settings, SEO Settings) are reproduced exactly.

Nothing in this module is imported by the live generation pipeline yet — see the
Migration Strategy section of CONTENT_ENGINE_V2_PLAN.md for how it gets wired in
without touching ``build_generation_messages()``.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Section 1 — Content Type (verbatim 17-option set from the V2 spec)
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Section 2 — Content Goal (proposed set — see module docstring)
# ---------------------------------------------------------------------------
ContentGoal = Literal[
    "Educate the reader",
    "Drive organic traffic / SEO ranking",
    "Generate leads",
    "Build brand authority",
    "Drive sales or conversions",
    "Support existing customers",
    "Engage and entertain",
]

# ---------------------------------------------------------------------------
# Section 4 — Industry (proposed closed set so industry_rules.py can map each
# value to a short factual context block; "Other / general" is the catch-all
# that compiles to no industry-specific block at all)
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Section 7 — Search Intent (the four standard SEO intent categories)
# ---------------------------------------------------------------------------
SearchIntent = Literal[
    "Informational",
    "Navigational",
    "Commercial",
    "Transactional",
]

# ---------------------------------------------------------------------------
# Section 8 — Tone of Voice (proposed set)
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Section 9 — Writing Style (proposed set)
# ---------------------------------------------------------------------------
WritingStyle = Literal[
    "Narrative / storytelling",
    "Descriptive",
    "Persuasive",
    "Expository / informative",
    "Technical / instructional",
    "Conversational / casual",
]

# ---------------------------------------------------------------------------
# Section 10 — Brand Personality (checkbox set; proposed options)
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Section 11 — Content Depth (proposed set)
# ---------------------------------------------------------------------------
ContentDepth = Literal[
    "Beginner-friendly overview",
    "Standard / balanced",
    "In-depth / comprehensive",
    "Expert-level / technical",
]

# ---------------------------------------------------------------------------
# Section 12 — Article Length (proposed set, with target word-count ranges
# the prompt builder can compile directly into the depth/word-count instruction)
# ---------------------------------------------------------------------------
ArticleLength = Literal[
    "Short (600-900 words)",
    "Medium (1,000-1,800 words)",
    "Long (1,800-3,000 words)",
    "Comprehensive (3,000+ words)",
]

# ---------------------------------------------------------------------------
# Section 13 — EEAT Settings (verbatim checkbox set from the V2 spec)
# ---------------------------------------------------------------------------
EEATOption = Literal[
    "Add Expert Opinions",
    "Add Statistics",
    "Add Research",
    "Add Case Studies",
    "Add Real Examples",
    "Add Industry Benchmarks",
    "Add FAQs",
]

# ---------------------------------------------------------------------------
# Section 14 — SEO Settings (verbatim checkbox set from the V2 spec)
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Section 17 — Content Restrictions (checkbox set; proposed options)
# ---------------------------------------------------------------------------
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


class ContentBrief(BaseModel):
    """The 19-section structured input for guided article generation.

    Field numbering in comments mirrors the V2 specification's section numbers
    so the mapping to the prompt-builder hierarchy (see prompt_sections.py and
    CONTENT_ENGINE_V2_PLAN.md §"How V2 avoids repeating the regression") stays
    traceable end to end.
    """

    # USER CONFIGURATION — sections 1-12 (+17 restrictions, §17)
    content_type: ContentType = Field(description="§1 Content Type")
    content_goal: ContentGoal = Field(description="§2 Content Goal")
    target_audience: str = Field(min_length=1, max_length=300, description="§3 Target Audience")
    industry: Industry = Field(description="§4 Industry")

    primary_keyword: str = Field(min_length=1, max_length=200, description="§5 Primary Keyword")
    secondary_keywords: list[str] = Field(
        default_factory=list, max_length=20, description="§6 Secondary Keywords"
    )
    search_intent: SearchIntent = Field(description="§7 Search Intent")

    tone_of_voice: ToneOfVoice = Field(description="§8 Tone of Voice")
    writing_style: WritingStyle = Field(description="§9 Writing Style")
    brand_personality: list[BrandPersonalityTrait] = Field(
        default_factory=list, max_length=len(BrandPersonalityTrait.__args__),
        description="§10 Brand Personality",
    )

    content_depth: ContentDepth = Field(description="§11 Content Depth")
    article_length: ArticleLength = Field(description="§12 Article Length")

    # SEO RULES — sections 13-14 (compiled to factual lines, never "mode" blocks)
    eeat_settings: list[EEATOption] = Field(
        default_factory=list, max_length=len(EEATOption.__args__), description="§13 EEAT Settings"
    )
    seo_settings: list[SEOOption] = Field(
        default_factory=list, max_length=len(SEOOption.__args__), description="§14 SEO Settings"
    )

    # GENERATION PARAMETERS — sections 15-16 (never enter the prompt as competing
    # instructions; §15 drives post-generation humanization parameters, §16 drives
    # a compiled creative-range note — NOT the OpenAI `temperature` field, which
    # gpt-5.5 ignores; see CONTENT_GENERATION_ARCHITECTURE.md)
    humanization_level: int = Field(default=80, ge=0, le=100, description="§15 Humanization Level")
    creativity_level: int = Field(default=60, ge=0, le=100, description="§16 Creativity Level")

    # SYSTEM RULES (negative constraints) — section 17
    content_restrictions: list[ContentRestriction] = Field(
        default_factory=list, max_length=len(ContentRestriction.__args__),
        description="§17 Content Restrictions",
    )

    # WEBSITE DATA — section 18 (pure data-inclusion gate; never an instruction)
    use_website_data: bool = Field(default=True, description="§18 Use Website Data")

    # ADDITIONAL INSTRUCTIONS — section 19, the ONLY free-text layer, placed last
    # in the compiled prompt and given USER PROMPT AUTHORITY framing. Optional —
    # an empty value is meaningful (the user has nothing to add beyond the
    # structured choices above) and must not be padded with filler.
    additional_instructions: str = Field(default="", max_length=20_000, description="§19 Additional Instructions")


class ContentBriefDraft(BaseModel):
    """Loosely-typed autosave shape for in-progress wizard edits.

    Intentionally permissive — every field optional, no enum/range enforcement —
    because a draft can be partially filled mid-wizard. Validation happens only
    when the draft is committed via ``ContentBrief`` (PUT .../content-brief).
    Stored separately from the committed brief (``content_brief_draft`` vs.
    ``content_brief`` on the article document) so in-progress edits never
    clobber the last generation-ready brief — see storage.py schema notes.
    """

    model_config = {"extra": "allow"}

    step: int | None = Field(default=None, ge=1, le=9, description="Last-active wizard step (1-8 + review)")
    values: dict = Field(default_factory=dict, description="Partial field values keyed by ContentBrief field name")
    saved_at: str = Field(default="", max_length=64)


class ContentBriefResponse(BaseModel):
    """GET .../content-brief response — committed brief plus any newer draft."""

    brief: ContentBrief | None = None
    draft: ContentBriefDraft | None = None


# ---------------------------------------------------------------------------
# Brief templates — the structured-era successor to the project's flat
# "writing prompts" list (see prompts.py for the CRUD shape this mirrors).
# ---------------------------------------------------------------------------


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
