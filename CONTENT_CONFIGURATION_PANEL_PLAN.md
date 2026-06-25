# Content Configuration Panel — Implementation Plan & Architecture

Status: **planning document only — no code changed in this pass.** This refines and *supersedes* the field-level design in [`CONTENT_ENGINE_V2_PLAN.md`](./CONTENT_ENGINE_V2_PLAN.md) — that document's **structural argument** (the authority-hierarchy compilation model, the "true by construction" guarantee, the migration strategy) still stands and is reused wholesale below; what changes is the **exact field set**, now pinned to the spec given in this request. Builds on [`CURRENT_CONTENT_ENGINE_AUDIT.md`](./CURRENT_CONTENT_ENGINE_AUDIT.md), [`PROMPT_FLOW_ANALYSIS.md`](./PROMPT_FLOW_ANALYSIS.md), [`CONTENT_GENERATION_ARCHITECTURE.md`](./CONTENT_GENERATION_ARCHITECTURE.md).

---

## 0. Audit of existing implementation (requested first)

### 0.1 The live generation pipeline — unchanged, fully reusable as orchestration

Nothing here changes. `execute_article_generation()` remains the single exit point; `build_generation_messages()` remains the legacy assembly's single source of truth; `patch_article_fields` / `_normalize_article_dict` / `_apply_article_updates_dict` remain the storage contract. See the three companion audits for the full inventory — none of it is repeated here because none of it needs to change.

### 0.2 What the *prior* pass in this session scaffolded — and why it now needs revision

Before this exact spec arrived, I scaffolded a first-draft scaffold against an earlier (less detailed, partly-guessed) reading of "the 19-section brief":

- `backend/app/schemas/content_brief.py` — a `ContentBrief` Pydantic model
- `backend/app/services/ai/{__init__,prompt_builder,prompt_sections,industry_rules,seo_rules}.py` — a `PromptBuilderService`
- Additive `content_brief` / `content_brief_draft` (articles) and `content_brief_templates` / `default_content_brief_template_id` (projects) fields in `storage.py`

**Honest finding: the field set in that scaffold does not match this spec.** Side by side:

| Scaffolded (earlier guess) | This spec (authoritative) | Verdict |
|---|---|---|
| Content Type — 17 options (How-To Guide, Listicle, Tutorial…) | Content Type — **12 different options** (Service Page, Location Page, Pillar Page, Topic Cluster, Category Page…) | Replace — different option set entirely |
| Content Goal (§2), Industry (§4) | *(not present in this spec)* | Drop — no longer in scope |
| Target Audience — free text | Target Audience — **closed dropdown**, 10 named segments | Replace — now an enum, not free text |
| Writing Style | Conversation Style — **different concept, different 11-option set** | Replace, don't rename-in-place |
| Content Depth — 4 options (Beginner-friendly…) | Content Depth — **5 differently-labeled options** (Basic…Ultimate Guide) | Replace |
| Article Length — 4 *categories* | Content Length — **numeric slider, 500–5000, live estimate** | Replace — categorical → continuous, different UX entirely |
| Search Intent — 4 options | Search Intent — **5 options, adds "Local"** | Extend |
| EEAT Settings + SEO Settings (two checkbox groups, spec-verbatim from the *old* brief) | Content Optimization (SEO/AEO/GEO/EEAT/Featured Snippet/Voice Search) **+** Include Data & Research (Statistics/Case Studies/…) — **two differently-scoped groups** | Replace — regroup along this spec's lines (see §0.3 — this is the one that needs care, not just relabeling) |
| Content Restrictions | *(not present in this spec)* | Drop — no longer in scope |
| *(not present in old spec)* | **Readability Level, Content Structure, FAQ Generation — three new sections** | Add — net-new |
| Humanization Level, Creativity Level, Use Website Data, Additional Instructions | Same four concepts, same defaults (80/60), same "only free-text field" framing | **Keep — these four map through unchanged** |

**Recommendation:** keep the *pattern* (Pydantic schema → `PromptBuilderService` → hierarchy-layer compilers → additive storage fields, all net-new and unwired) — it is sound and the new spec doesn't challenge any of it structurally. Revise the *content* of `content_brief.py` and the option tables in `industry_rules.py`/`seo_rules.py`'s successors to match §2 below exactly, rather than maintaining two parallel schemas. This is a rewrite-in-place of the option sets and section list, not a redesign of the approach — call it "pattern proven, content corrected before it ships," which is exactly what a plan-before-code pass is for.

### 0.3 ⚠️ Flag this before anything else is built: Section 11 ("Content Optimization") needs a specific, deliberate compilation design

This is the single most important finding in this audit, and it is **not a reason to drop the section** — it is a reason to build it *correctly*, because the naive implementation is the literal regression this codebase already lived through once.

**The collision:** `CLAUDE.md`'s critical rules state, verbatim: *"Never re-add Content Optimization Profile (SEO/AEO blocks) — removed intentionally; user prompt is highest priority."* The retired `content_optimization.py` had a field called `content_optimization_profile` whose values were exactly this family — SEO / AEO / GEO / EEAT "modes." Section 11 of this spec asks for a checkbox group named **"Content Optimization"** with options **SEO, AEO, GEO, EEAT, Featured Snippet Optimization, Voice Search Optimization** — i.e., the same conceptual surface, reappearing in a new spec.

**Why this isn't a contradiction to resolve by dropping the field — it's a contradiction to resolve by building it differently:**

The thing that was removed was never "the ability to ask for SEO/AEO/EEAT emphasis." Users plainly want that — it's why this spec re-proposes it. What was removed — and what `CLAUDE.md` is actually warning future-me away from — was a **compilation style**: `content_optimization.py`'s own docstring said its blocks were designed to *"carry the same weight as other system-prompt rules so they are not overridden by the user's writing prompt."* That is an authority claim baked into the compiled text. It is what made the feature fight the user's prompt instead of serving it, and it's what produced the 2026-06-05 regression that the "USER PROMPT AUTHORITY" directive had to be written specifically to neutralize (see `PROMPT_FLOW_ANALYSIS.md`).

**The resolution — stated as a hard design constraint for whoever builds §11, so it can't be missed mid-implementation:**

> Section 11 must be compiled using *exactly* the same falsifiable-single-line pattern as §12 (Include Data & Research) — the same pattern the existing scaffold already uses for EEAT/SEO settings (see `seo_rules.py`'s docstring contrast). Each checked box becomes **one short, factual, falsifiable instruction**, in the same register as every other OPTIMIZATION RULES line, with **zero "mode," "profile," "applies to this article," or "carries equal weight" language anywhere near it.** A worked example for all six options is in §4.3 below — that table *is* the thing that makes §11 safe to build. If anyone implements §11 by writing a paragraph that announces "SEO MODE is active for this article," they have rebuilt `content_optimization.py` under a new section number, and the regression returns. This sentence is the gate; §4.3 is the proof that the gate can be satisfied.

This is, in miniature, the entire thesis of `CONTENT_ENGINE_V2_PLAN.md` repeating itself at the level of one checkbox group: the feature isn't the problem, the *register it's written in* is — and that's a property of the compiler, not the UI control.

---

## 1. UI Architecture

### 1.1 Shape: a panel, not a wizard — the spec's own name is the signal

The earlier plan recommended an 8-step wizard. **This spec calls it a "Content Configuration Panel,"** and that naming choice is worth honoring rather than overriding: 19 fields of mostly small, fast controls (dropdowns, radios, checkboxes, two sliders, one toggle) suit a **single scrollable panel grouped into labeled sections**, not a click-through sequence — wizards earn their keep when each step needs focus and validation gates the next one; here, nothing in section 7 depends on what was chosen in section 3. A panel lets a returning user who only wants to bump the Creativity slider do that in one click instead of re-walking eight steps.

**Recommended structure — group the 19 fields into labeled, collapsible sections** (reusing the `.segmentGroup` stepper *visual* language from the Performance tab redesign for the section headers, without its click-through *behavior*):

| Group | Sections (spec §) | Control mix |
|---|---|---|
| **Foundations** | Content Type (1), Primary Keyword (2), Secondary Keywords (3) | dropdown, text, tag input |
| **Audience & Voice** | Target Audience (4), Tone of Voice (5), Conversation Style (6), Brand Personality (14) | 3 dropdowns + 1 checkbox group |
| **Depth & Format** | Content Depth (7), Content Length (8), Readability Level (13), Content Structure (15) | dropdown, slider+live estimate, dropdown, checkbox group |
| **Intent & Optimization** | Search Intent (9), FAQ Generation (10), Content Optimization (11), Include Data & Research (12) | radio, radio, 2 checkbox groups |
| **Generation Tuning** | AI Humanization Level (16), Creativity Level (17) | 2 sliders w/ descriptive labels |
| **Data & Instructions** | Use Website Data (18), Custom Instructions (19) | toggle, large textarea |

### 1.2 Field-type → component mapping

| Spec field type | Component | Notes |
|---|---|---|
| Dropdown | `<select>`-style accessible combobox (reuse existing project dropdown component) | Always has a "—" / placeholder state for optional fields |
| Single Line Text | `<input type="text">` w/ char counter | Primary Keyword — required, so inline validation on blur |
| Multi Select Text | Tag/chip input (type + Enter to add, click to remove) | Secondary Keywords — caps at the schema's list-length limit |
| Radio | Accessible radio-group (`role="radiogroup"`, arrow-key navigation) | Search Intent, FAQ Generation |
| Checkbox | Accessible checkbox group with a visible selection count ("3 of 6 selected") | Content Optimization, Data & Research, Brand Personality, Content Structure |
| Range Slider (Content Length) | Custom slider, **live word-count readout** ("≈ 2,500 words — about a 10–12 minute read") | Min 500 / Max 5000 / step 50 / default 2000 |
| Slider (Humanization, Creativity) | Same slider component, **descriptive label instead of bare number** ("80 — strongly human voice, minimal AI tells") | Per the existing plan's tooltip-accessibility note — labels render inline, not on hover |
| Toggle | Accessible switch (`role="switch"`) | Use Website Data — expands an inline note listing what gets injected when on (the spec's own bullet list) |
| Large Text Area | `<textarea>` w/ char counter, explicitly labeled "Your instructions always come first" | Custom Instructions — visually the most prominent field on the panel, not just the last one |

### 1.3 Cross-cutting requirements (carried over from the prior plan, still binding)

- **Live structured-JSON / prompt preview** — this spec explicitly frames the system as "convert selections → structured JSON → final prompt." A collapsible "Preview generated configuration" panel showing the live JSON (and, for power users, the compiled prompt text) makes that pipeline *visible*, which is good UX and a debugging aid in one. 
- **Autosave**: debounced `PATCH .../content-brief/draft`, "Saved / Saving… / Draft restored" affordance.
- **Recommended defaults pre-filled** (Content Length 2000, FAQ Generation = Yes, Humanization 80, Creativity 60) with "Reset to recommended."
- **Tooltips reachable without hover** (P2 finding from the Articles-tab audit — do not repeat it here).
- **Modals** (e.g., "discard draft?") use `useFocusTrap` — never `window.confirm`.
- **Responsive**: checkbox groups and the two-column dropdown groups collapse to single-column `<dl>/<dt>/<dd>` stacks below the project's mobile breakpoint.

---

## 2. Database Schema

Same storage location as already scaffolded and verified — **additive, nullable fields, no behavior change for existing documents**:

- Article: `content_brief: dict | None`, `content_brief_draft: dict | None`
- Project: `content_brief_templates: list[{id, name, brief}]`, `default_content_brief_template_id: str`

What changes is the **shape of `content_brief` itself** — revised to this spec's exact 19 fields:

| § | Section | Field name | Type | Constraint |
|---|---|---|---|---|
| 1 | Content Type | `content_type` | enum (12 values) | **required** |
| 2 | Primary Keyword | `primary_keyword` | string | **required**, 1–200 chars |
| 3 | Secondary Keywords | `secondary_keywords` | string[] | optional, ≤ 20 items, ≤ 100 chars each |
| 4 | Target Audience | `target_audience` | enum (10 values) | optional |
| 5 | Tone of Voice | `tone_of_voice` | enum (11 values) | optional |
| 6 | Conversation Style | `conversation_style` | enum (11 values) | optional |
| 7 | Content Depth | `content_depth` | enum (5 values) | optional, default `"Standard"` |
| 8 | Content Length | `content_length` | int | 500–5000, default 2000 |
| 9 | Search Intent | `search_intent` | enum (5 values incl. "Local") | optional |
| 10 | FAQ Generation | `faq_generation` | bool | default `true` |
| 11 | Content Optimization | `content_optimization` | enum[] (6 values) | optional, ≤ 6 items — **see §0.3 for compilation constraint** |
| 12 | Include Data & Research | `data_research` | enum[] (6 values) | optional, ≤ 6 items |
| 13 | Readability Level | `readability_level` | enum (6 values) | optional |
| 14 | Brand Personality | `brand_personality` | enum[] (9 values) | optional, ≤ 9 items |
| 15 | Content Structure | `content_structure` | enum[] (9 values) | optional, ≤ 9 items |
| 16 | AI Humanization Level | `humanization_level` | int | 0–100, default 80 |
| 17 | Creativity Level | `creativity_level` | int | 0–100, default 60 |
| 18 | Use Website Data | `use_website_data` | bool | default `true` |
| 19 | Custom Instructions | `custom_instructions` | string | optional, ≤ 20,000 chars — **the only free-text field** |

`ContentBriefDraft` / `ContentBriefTemplate*` / `ContentBriefResponse` shapes carry over unchanged from the existing scaffold (they're generic over "whatever `ContentBrief` contains," not coupled to its field list).

**Migration note:** since nothing has shipped yet (the scaffolded `content_brief` field has never been written by any code path), revising `content_brief.py`'s field set is a **pre-launch schema correction**, not a migration — there is no production data in this shape to migrate. This is the cheapest possible moment to get the field names right.

---

## 3. API Design

Unchanged in shape from the existing plan — reiterated here with this spec's field names:

- `GET /projects/{id}/articles/{article_id}/content-brief` → `{brief, draft}`
- `PUT /projects/{id}/articles/{article_id}/content-brief` → validate + commit (full enum/range/allow-list validation, see §5)
- `PATCH /projects/{id}/articles/{article_id}/content-brief/draft` → debounced partial autosave (`$set` semantics — `patch_article_fields`, deliberately, per Risk #6 in the prior plan)
- `GET/POST/PATCH/DELETE /projects/{id}/brief-templates` (+ `/set-default`) — reusable presets, parallel to `prompts.py`

**Wire format — camelCase JSON at the API boundary, matching the spec's own example exactly:**

```json
{
  "contentType": "Service Page",
  "primaryKeyword": "commercial roofing repair",
  "secondaryKeywords": ["roof leak repair", "flat roof maintenance"],
  "targetAudience": "Business Owners",
  "toneOfVoice": "Professional",
  "conversationStyle": "Thought Leadership",
  "contentDepth": "Comprehensive",
  "contentLength": 2500,
  "searchIntent": "Commercial",
  "faqGeneration": true,
  "contentOptimization": ["SEO", "AEO", "EEAT"],
  "dataResearch": ["Statistics", "Case Studies"],
  "readabilityLevel": "Professional Audience",
  "brandPersonality": ["Trustworthy", "Innovative"],
  "contentStructure": ["Introduction", "FAQs", "CTA"],
  "humanizationLevel": 80,
  "creativityLevel": 60,
  "useWebsiteData": true,
  "customInstructions": "Write from the perspective of a senior patent attorney."
}
```

Pydantic models use `snake_case` internally (consistent with `content_brief.py` and the rest of `app/schemas/`) with `alias_generator=to_camel` + `populate_by_name=True` for the wire format — this is the standard FastAPI/Pydantic v2 pattern for "Python snake_case in, JSON camelCase out" and requires no hand-written translation layer. `frontend/src/lib/contentBrief.ts` gets the typed camelCase client functions per the project's "all API calls go through `api.ts`-style modules" convention.

Pipeline change (later phase, not this one): `execute_article_generation()` gains `_resolve_content_brief()`, parallel to `_resolve_writing_prompt()` — see Migration Strategy in `CONTENT_ENGINE_V2_PLAN.md` §6, unchanged.

---

## 4. Prompt Builder Architecture

### 4.1 Location and contract — exactly as specified

`backend/app/services/ai/prompt_builder.py` → `PromptBuilderService` (already scaffolded at `/services/ai/` per the spec's named location). Contract:

```
compile(brief: ContentBrief, *, article_facts, project_context) -> CompiledPrompt
```

**"No hardcoded content templates"** — this is already how the scaffolded builder works and remains the binding constraint: there is no fixed prose block anywhere that gets dropped in verbatim. Every line of the compiled system prompt is *either* (a) parameterized by a brief value (e.g. the word-count line is built from `content_length`, not a fixed "1,500 words"), or (b) present *only because* a specific checkbox is checked (e.g. the EEAT line for "Statistics" exists in the output if and only if "Statistics" is in `data_research`). Delete every value from the brief and the compiled prompt shrinks to the bare SYSTEM RULES + OUTPUT FORMAT skeleton — nothing is "templated in" independent of user choices.

### 4.2 The structured intermediate JSON — already the scaffold's `ContentBrief.model_dump()`

The spec asks for "convert all user selections into structured JSON" as an explicit intermediate step before prompt assembly. **This already exists as a free side-effect of the Pydantic-model design** — `ContentBrief` *is* that structured JSON; `.model_dump(by_alias=True)` produces exactly the shape shown in §3 and in the spec's own example. No separate "conversion" step needs to be built; the schema *is* the conversion target. This is worth surfacing to the user-facing preview panel (§1.3) for free — the same `model_dump()` that gets persisted is what a "Preview generated configuration" UI would render.

### 4.3 Compilation hierarchy — the field-by-field authority map (the load-bearing table)

Same seven-layer hierarchy as `CONTENT_ENGINE_V2_PLAN.md` (SYSTEM RULES → OPTIMIZATION RULES → USER CONFIGURATION → WEBSITE DATA → CUSTOM INSTRUCTIONS → OUTPUT FORMAT — "INDUSTRY RULES" drops out since Industry is no longer in scope), remapped to this spec's exact fields:

| Spec field(s) | Layer | Compilation approach | Why it can't outrank §19 |
|---|---|---|---|
| Content Type, Primary/Secondary Keywords, Target Audience, Tone of Voice, Conversation Style, Search Intent, Readability Level, Brand Personality | USER CONFIGURATION | One factual line each: `"Target audience: Business Owners"`, `"Conversation style: Thought Leadership"` | Declarative restatement of the user's own choices — nothing to argue with |
| Content Length (8) | SYSTEM RULES, parameterized | `f"Write approximately {content_length} words (±10%)."` — **directly from the slider value**, never a fixed number | An instruction *derived from* what the user picked can't conflict with what the user picked |
| Content Depth, Content Structure | SYSTEM RULES | Depth → one descriptive line; Structure → a plain checklist: `"Include the following sections: Introduction, FAQs, CTA."` (a list of *what*, not a competing claim about *how*) | A structural checklist and a voice/tone instruction operate on different axes — they don't compete for the same authority |
| FAQ Generation (10) | SYSTEM RULES, binary | `true` → "Include a `## Frequently Asked Questions` section with 4–6 Q&A pairs."; `false` → simply *omit* that line entirely (not "do not include an FAQ" — silence is the cleaner instruction for "don't") | A presence/absence switch, not a directive that can be half-followed |
| **Content Optimization (11)** | **OPTIMIZATION RULES** — ⚠️ see §0.3 | **One falsifiable line per checked box — see the worked table immediately below.** | **This is the constraint that makes the whole section safe — see §0.3** |
| Include Data & Research (12) | OPTIMIZATION RULES | Same falsifiable-line pattern, e.g. `"Statistics"` → `"Include at least one specific, named statistic relevant to the topic."` (this is a straight reuse of the already-scaffolded `seo_rules.build_eeat_lines` pattern — only the option labels move) | Same reasoning — checklist lines, not authority claims |
| Humanization Level (16), Creativity Level (17) | Non-prompt parameters | Unchanged from the existing scaffold — `_map_humanization` → `HumanizationParams`; `_map_creativity` → compiled creative-range note (not `temperature` — `gpt-5.5` ignores it) | Neither is an instruction the model "follows" in the prose sense — neither competes |
| Use Website Data (18) | WEBSITE DATA | Gated inclusion of brand/site/product context — exactly the existing `PromptBuilderContext` design, **plus** this spec's explicit injection list (existing content, GSC data, website analysis, internal links, competitor insights, existing service pages) as additional optional context facts when available | Pure data supply — never an instruction about *how* to write |
| **Custom Instructions (19)** | CUSTOM INSTRUCTIONS — supreme, last | Verbatim user text, "USER PROMPT AUTHORITY" framing — **the only free-prose, imperative-register block in the entire prompt** | Nothing else in the prompt is written in a register that could compete with it — see `CONTENT_ENGINE_V2_PLAN.md` §"How V2 avoids the regression" for the full argument; it applies here unchanged |

**Worked example — the §11 falsifiable-line table that resolves the §0.3 flag concretely** (six options, six lines, zero "mode" framing):

| Checked option | Compiled line |
|---|---|
| SEO | "Use the primary keyword naturally in the title, the opening paragraph, and at least one heading." |
| AEO (Answer Engine Optimization) | "Phrase at least one passage as a direct, self-contained answer to a question the target audience would plausibly ask." |
| GEO (Generative Engine Optimization) | "Write so that an AI system summarizing this content could extract accurate claims without ambiguity — define terms on first use and avoid unresolvable pronoun references." |
| EEAT | "Demonstrate expertise and trustworthiness through specific, checkable details rather than general claims of authority." |
| Featured Snippet Optimization | "Include one concise, 40–60 word passage that directly answers the primary keyword's implied question, positioned where a search engine could lift it as a featured snippet." |
| Voice Search Optimization | "Phrase at least one heading or passage as a natural spoken question and answer (e.g. 'How much does X cost?')." |

Each line is independently true-or-false against the finished draft — exactly the property `content_optimization.py`'s blocks lacked, and exactly the property that lets this section exist safely.

### 4.4 Folder structure — unchanged from the existing scaffold

```
backend/app/services/ai/
  __init__.py
  prompt_builder.py        # PromptBuilderService.compile()
  prompt_sections.py       # one compile_*() per hierarchy layer (SYSTEM/OPTIMIZATION/
                           #   USER CONFIG/WEBSITE DATA/CUSTOM INSTRUCTIONS/OUTPUT FORMAT)
  optimization_rules.py    # renamed from the scaffold's seo_rules.py — now covers BOTH
                           #   §11 Content Optimization and §12 Data & Research, since
                           #   both compile through the identical falsifiable-line pattern
backend/app/schemas/
  content_brief.py         # ContentBrief — revise field set to match §2 exactly
```

(`industry_rules.py` is dropped — Industry is no longer in the spec. `seo_rules.py` is renamed/widened to `optimization_rules.py` to honestly describe what it now compiles — both §11 and §12 are "checkbox → falsifiable line" groups, and giving them one well-named home keeps the pattern visibly singular rather than implying two different mechanisms exist.)

---

## 5. Validation Rules

| Rule | Applies to | Mechanism |
|---|---|---|
| Required fields | `content_type`, `primary_keyword` | Pydantic `Field(...)` (no default) — same as the spec's "Required" tags |
| Enum allow-lists | All 9 dropdown/radio fields + 4 checkbox-group option sets | `Literal[...]` server-side (source of truth) + generated TS union types client-side, so the two can never drift |
| Numeric ranges | `content_length` (500–5000), `humanization_level`/`creativity_level` (0–100) | `Field(ge=, le=)` — slider UI additionally clamps client-side for immediate feedback |
| String length caps | `primary_keyword` (≤200), each secondary keyword (≤100), `custom_instructions` (≤20,000) | `Field(max_length=)` |
| List-size caps | `secondary_keywords` (≤20), each checkbox group (≤ its own option-set size) | `Field(max_length=)` — self-documenting: a group literally cannot select more options than exist |
| **Boundary screening for the one free-text field** | `custom_instructions` | Route through `prompt_validation.assert_writing_prompt_allowed()` (or an equivalent sibling check) — **this field plays the exact role `writing_prompt` plays today** (the one place a user can type anything), so it inherits the same jailbreak/harmful/off-topic regex screen and the same length-bound philosophy. This is not new infrastructure — it's recognizing that §19 *is* the writing-prompt surface in the new shape, and must clear the same boundary gate. |
| Plan-tier gating | `custom_instructions` length, `content_brief_templates` count, possibly which `content_optimization` / `data_research` options are available on lower tiers | New decision, mirroring `writing_prompt_char_limit` / `max_writing_prompts` — flagged as Risk #7 in the prior plan; still open, now scoped to *this* field list |
| Draft vs. commit validation asymmetry | `ContentBriefDraft` (loose, `extra="allow"`) vs. `ContentBrief` (strict) | Already designed into the scaffold — drafts can be partially filled mid-edit; only the committed brief (PUT) is fully validated, exactly like `prompt_validation` only gates *saved* prompts, not every keystroke |

---

## 6. UX Flow

1. **Entry** — from the article editor (or "New Article" flow), a "Configure with guided panel" entry point alongside (not replacing, initially) the legacy free-text Prompts picker — per the additive Migration Strategy.
2. **Configure** — the grouped panel from §1.1. Defaults are pre-filled and visibly marked as defaults ("Recommended — change anytime"). Every change debounce-autosaves to the draft.
3. **Live feedback** — the Content Length slider shows a running word/read-time estimate; the two generation-tuning sliders show descriptive labels; the optimization/data checkboxes show a running "N selected" count; the optional "Preview generated configuration" panel shows the live structured JSON (§4.2) and, expandable, the compiled prompt text — turning "what will the AI actually see" from a mystery into something the user can literally read before they commit.
4. **Commit** — "Save configuration" validates fully (§5) and calls `PUT .../content-brief`, converting the draft into the generation-ready brief. Validation errors surface inline, next to the offending field, in plain language ("Primary keyword is required").
5. **Generate** — the existing "Generate" action now resolves a brief if one is committed (branch point in `_resolve_content_brief`, per the unchanged Migration Strategy) — zero change to the button the user already knows.
6. **Iterate** — after generation, the panel remains editable; changing a value and regenerating is the same loop, not a new one. "Save as template" persists the current configuration to `content_brief_templates` for reuse on future articles.

---

## 7. Future Expansion Strategy

- **Per-content-type smart defaults** — "Service Page" and "Press Release" plausibly want different default `content_depth` / `content_structure` / `tone_of_voice` starting points; the schema already supports per-template defaults via `content_brief_templates`, and a future pass could seed type-aware starting templates rather than one universal default.
- **Conversion assist from legacy prompts** — "Convert this writing prompt into a configuration" (best-effort field matching, always lands in the *draft*, always user-reviewed) — carried over from the prior plan's Migration Strategy, unchanged.
- **Plan-tier feature gating** — which `content_optimization` / `data_research` options, how many `content_brief_templates`, and what `custom_instructions` length ceiling apply per plan tier (Risk #7, still open).
- **Adherence scoring** — the prior plan flagged "no equivalent of the AI-detection audit for *did the model follow the configuration*"; once §11's falsifiable-line design is in place, each line is — by construction — independently checkable post-hoc (a programmatic or LLM-graded pass could verify "was the featured-snippet passage actually 40–60 words and positioned early?"). This was previously hard to build because the old directives weren't falsifiable; the new design makes it a natural next step rather than a research problem.
- **A/B prompt-variant testing** — because the compiled prompt is now a pure function of structured input (§4.1's "no hardcoded templates" guarantee), two configurations can be diffed, replayed, and compared on output quality in a way a free-text prompt never could be.
- **Localization** — `readability_level` / `tone_of_voice` / `conversation_style` option sets are language- and culture-specific; a future pass could make these option sets project-locale-aware rather than fixed English labels.
- **Slider-mapping refinement from real data** — Risk #5 from the prior plan (humanization/creativity mappings need empirical tuning) applies identically to the new `content_length` slider's word-count→instruction mapping; all three are "principled starting point, not final word," and all three should be revisited once real generation runs exist to tune against.

---

## Closing note

The field set changed substantially between the earlier scaffold and this spec — that's a normal, healthy outcome of "plan before code," not a setback; revising twelve option lists in a schema file before anything depends on them costs nothing, while revising them after a UI and a prompt compiler are both built against the wrong names costs a great deal. The one finding that *does* carry real weight is §0.3: Section 11 reuses a name and a concept that this codebase has explicit, hard-won, written-down scar tissue about. The resolution isn't to refuse the section — it's the worked table in §4.3, which demonstrates concretely that the *capability* the spec wants and the *architectural mistake* `CLAUDE.md` warns against are separable, and that this plan separates them before a single line of the new compiler gets written.
