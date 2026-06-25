# Content Engine V2 — Implementation Plan

Status: **planning document only — no code changed.** Builds on the findings in [`CURRENT_CONTENT_ENGINE_AUDIT.md`](./CURRENT_CONTENT_ENGINE_AUDIT.md), [`PROMPT_FLOW_ANALYSIS.md`](./PROMPT_FLOW_ANALYSIS.md), and [`CONTENT_GENERATION_ARCHITECTURE.md`](./CONTENT_GENERATION_ARCHITECTURE.md). Read those first — this plan assumes their conclusions.

**One-line summary of what's changing:** replace the single free-text "writing prompt" with a 19-section guided form, compiled by a new Prompt Builder Service into a hierarchically-ordered prompt where every non-user layer is rendered as short factual statements — so user authority is **true by construction**, not asserted in a single competing paragraph (the failure mode the 2026-06-05 fix only partially solved — see `PROMPT_FLOW_ANALYSIS.md`).

---

## How V2 avoids repeating the 2026-06-05 regression

The spec requires that none of the new structured fields (EEAT Settings, SEO Settings, Humanization Level, Creativity Level, etc.) can outrank §19 Additional Instructions — mirroring (and strengthening) the existing USER PROMPT AUTHORITY guarantee. Mapping every new field to its place in the hierarchy (SYSTEM RULES → SEO RULES → INDUSTRY RULES → USER CONFIGURATION → WEBSITE DATA → ADDITIONAL INSTRUCTIONS → OUTPUT FORMAT):

| New V2 field(s) | Hierarchy layer | Why it cannot outrank §19 |
|---|---|---|
| Content Type, Content Goal, Target Audience, Industry, Primary/Secondary Keywords, Search Intent | USER CONFIGURATION | Compiled as **factual context** ("this article targets a beginner audience in the legal industry") — not imperative, not "non-negotiable." It already *is* the user's intent; it competes with nothing. |
| Tone of Voice, Writing Style, Brand Personality, Content Depth, Article Length | USER CONFIGURATION | Same — these *are* the user's own structured choices. They can only conflict with §19 if the same user contradicts themselves, in which case the model is told §19 (most specific, most recent) wins that internal tie. |
| EEAT Settings, SEO Settings | SEO RULES (parameterized lines, not "mode" blocks) | **The literal structural fix for `content_optimization.py`'s flaw.** Each checked box compiles to ONE short, factual, falsifiable line ("Include one named statistic with a source," "Generate FAQ schema markup") — never to a block claiming "applies to this article" or "carries the same weight as system rules." There is no authority language left to compete with. |
| Humanization Level, Creativity Level | Not prompt text — **generation/post-generation parameters** | Humanization Level drives `execute_structural_humanization()` parameters *after* generation — it never enters the prompt. Creativity Level compiles to an instruction about creative *range* (not the API `temperature` field — `gpt-5.5` ignores it, see Risk 1). Neither is an instruction the model "follows" the way it follows prose directives, so neither can compete for priority. |
| Content Restrictions | SYSTEM RULES — negative constraints | Phrased as hard "do not" boundaries — the same category as the existing banned-phrase list. Guardrails bound the *space* of acceptable output; a restriction and a creative direction operate on different axes by definition, so they don't compete with §19 over voice or structure. |
| "Use Website Data" toggle | WEBSITE DATA | A pure data-inclusion switch — supplies *context* (brand identity, niche, context links), exactly like today's `brand_identity`/`product_context`. It never instructs *how* to write. |
| Additional Instructions (§19) | ADDITIONAL INSTRUCTIONS — supreme, placed LAST | The **only** free-text, imperative-register layer in the entire prompt. Carries the same "USER PROMPT AUTHORITY" framing that exists today — but now genuinely uncontested, because every other layer has been deliberately demoted to a non-competing register (compiled facts, parameters, guardrails). |

**The structural guarantee, stated plainly:** authority in V2 doesn't come from a sentence *claiming* supremacy — it comes from making §19 the *only* section written in the one register (free prose, imperative, "follow these requirements") that could ever compete with another section in that register. Everywhere else, "competing for priority" stops being a coherent concept, because nothing else is phrased as a competing instruction. That is the actual fix; the restated authority sentence is just a courtesy — for the first time, it would be *true because of the shape of everything around it*, not merely asserted over it.

---

## 1. Architecture Plan

- New backend package `backend/app/services/ai/` housing the **Prompt Builder Service** — the canonical home for the spec's `/services/ai/prompt-builder`.
- `PromptBuilderService.compile(brief: ContentBrief, *, project_context) -> CompiledPrompt` becomes the new source of truth for prompt *assembly*. `build_generation_messages()` / `generate_article_bundle()` keep their orchestration role (calling OpenAI, sanitizing, persisting) — they gain a branch that delegates assembly to the new builder when a structured brief is present (see Migration Strategy — the legacy path is never modified).
- `CompiledPrompt = {system, user, humanization_params: {target_ai_pct, initial_strength} | None, creativity_note: str | None}` — everything the pipeline needs (prompt text *and* non-prompt generation parameters) from one call.

## 2. Database Schema Changes

Per the documented storage rule (new article fields go in **both** `_normalize_article_dict` and `_apply_article_updates_dict` in `storage.py`):

- New article field `content_brief: dict | None` — the committed, generation-ready 19-section structure.
- New article field `content_brief_draft: dict | None` — separate from `content_brief` so in-progress wizard edits autosave without mutating the last committed, generation-ready brief.
- New project field `content_brief_templates: list[{id, name, brief}]` + `default_content_brief_template_id` — reusable presets, the structured-era successor to the flat "writing prompts" list.
- All additive and nullable. `prompts` / `default_prompt_id` / `image_prompts` are untouched.

## 3. API Changes

New routes, parallel in shape to the existing `prompts.py` CRUD (registered alongside it):

- `GET    /projects/{id}/articles/{article_id}/content-brief` — fetch committed brief + draft
- `PUT    /projects/{id}/articles/{article_id}/content-brief` — save/commit (server-side validation: enums for dropdowns/radios, 0–100 ranges for sliders, allow-listed checkbox sets — same boundary-validation role `assert_writing_prompt_allowed` plays today)
- `PATCH  /projects/{id}/articles/{article_id}/content-brief/draft` — debounced autosave upsert (shape-only validation — it's a draft; use `$set` semantics deliberately, see Risk 6)
- `GET/POST/PATCH/DELETE /projects/{id}/brief-templates` (+ `/set-default`) — reusable presets

Pipeline change: `execute_article_generation()` gains `_resolve_content_brief()`, parallel to `_resolve_writing_prompt()`, resolving to a `ContentBrief | None` that decides which assembly branch runs (§ Migration Strategy).

`frontend/src/lib/api.ts` gains the corresponding typed client functions, per the project's "all API calls go through api.ts" rule.

## 4. UI Wireframe Plan

Multi-step wizard, replacing the content-creation portion of the flat "Prompts" tab (the prompt *library* concept survives — it now manages brief templates instead of free-text blobs).

**Suggested grouping — 19 sections → 8 digestible steps + review:**

1. **Foundations** — Content Type, Content Goal, Target Audience, Industry
2. **Keywords & Intent** — Primary/Secondary Keywords, Search Intent
3. **Voice** — Tone of Voice, Writing Style, Brand Personality
4. **Depth & Format** — Content Depth, Article Length
5. **Trust & SEO** — EEAT Settings, SEO Settings
6. **Generation Tuning** — Humanization Level (slider, default 80), Creativity Level (slider, default 60) — each shows a live *descriptive* label ("80 — strongly human voice, minimal AI tells"), never a bare number
7. **Guardrails & Data** — Content Restrictions, "Use Website Data" toggle
8. **Final word** — Additional Instructions: large, prominent, explicitly framed as "Your instructions always come first"

Cross-cutting requirements:
- **Persistent progress indicator** — reuse the `.segmentGroup` stepper language already shipped in the Performance tab redesign rather than inventing a new pattern.
- **Auto-save**: debounced `PATCH .../content-brief/draft`, with a small "Saved / Saving… / Draft restored" status affordance.
- **Recommended defaults pre-filled** (Humanization 80, Creativity 60, Content Depth = Standard…) with a one-click "Reset to recommended" per step.
- **Tooltips reachable without hover** — the Articles-tab critique flagged hover-only affordances (`data-tooltip`, P2) as a touch-accessibility gap; the flagship new surface must not repeat it.
- **Review step**: read-only summary of all 19 sections with inline "Edit" jumps, immediately before Generate.
- **Responsive**: reuse the `<dl>/<dt>/<dd>` semantic mobile-card pattern already proven for dense structured data in the Articles tab.
- **Modals** (e.g., "discard draft?") use `useFocusTrap` — never `window.confirm`, per the project's accessible-modal rule.

## 5. Prompt Builder Architecture

```
backend/app/services/ai/prompt_builder.py
  compile(brief, context) -> CompiledPrompt
    system = (
        _system_rules(brief)           # today's anchor/structure/depth/FAQ defaults — now
                                        # PARAMETERIZED: Article Length feeds the word-count
                                        # instruction directly instead of a fixed "1,500 minimum"
      + _seo_rules(brief.seo_settings, brief.eeat_settings)  # one factual line per checked box —
                                        # the structural replacement for content_optimization.py
      + _industry_rules(brief.industry) # short factual context, never "mode" framing
      + _user_configuration(brief)      # sections 1–12 + 17 → factual statements
      + _website_data(brief, context)   # gated by the "Use Website Data" toggle
      + _additional_instructions(brief) # verbatim user text — the ONE free-prose layer,
                                        # placed last, carrying USER PROMPT AUTHORITY framing
      + _output_format()                # JSON schema instruction — unchanged
    )
    user = <title, keywords, focus keyphrase — unchanged shape>
    return CompiledPrompt(system, user,
                          humanization_params=_map_humanization(brief.humanization_level),
                          creativity_note=_map_creativity(brief.creativity_level))
```

Two mappings need explicit design (not "slider → number"):

- **Humanization Level (0–100) → `{target_ai_pct, initial_strength}`**, consumed by a *post-generation* `execute_structural_humanization()` call. This finally gives the dormant tunability in `integrity_engine.py` a UI. Recommend: **wire it through to the existing on-demand "Humanize" button first** (zero pipeline-behavior change, immediate value); treat "auto-run humanization as part of generation" as a separate later decision — it changes default latency and cost, and today it's deliberately disabled by default.
- **Creativity Level (0–100) → a compiled instruction about creative range**, *not* the OpenAI `temperature` parameter — `gpt-5.5` rejects custom temperature (`openai_client.py:86-89`, confirmed in `CONTENT_GENERATION_ARCHITECTURE.md`). E.g., low end → "favor conventional structure and well-established framings"; high end → "use unconventional analogies, varied sentence rhythm, and less predictable framing — while keeping every fact accurate." If the model ever changes to one that accepts `temperature`, the same mapping can additionally feed that parameter — the compiled-instruction version still does useful work either way.

## 6. Migration Strategy

- **Additive, not destructive.** `prompts` / `default_prompt_id` / `image_prompts` remain fully intact through the transition.
- **Branch at the resolution point**, not deep in the pipeline:
  ```
  if article.content_brief:
      compiled = PromptBuilderService.compile(brief, context)
  else:
      resolved = _resolve_writing_prompt(...)    # unchanged legacy path
      compiled = build_generation_messages(...)  # unchanged legacy assembly
  ```
  This keeps `build_generation_messages()` — documented as behaviour-identical across every generation entry point — completely untouched for every existing project.
- New projects/articles default to the V2 guided-brief flow. Existing projects keep generating exactly as today, with no forced conversion and no risk to in-flight schedules.
- **Optional, explicitly opt-in conversion assist**: "Convert this writing prompt to a guided brief" — best-effort field-matching that always lands in the *draft*, never silently replaces the committed prompt, always user-reviewed before save.
- **Deprecating the legacy Prompts tab is a separate, later decision**, gated on adoption data — not part of this rollout (mirroring the project's own practice of treating removals as deliberate, recorded decisions).

## 7. What can be reused (and what can't)

**Reusable as-is — no changes needed:**
- `execute_article_generation()`'s entire orchestration: quota/budget checks, platform-extras resolution, sanitizers, image generation, integrity audit, context-link injection, SSE status streaming, persistence. Only the prompt-*assembly* sub-step gets a new branch.
- The storage layer's merge semantics (`patch_article_fields` / `$set`) and the `_normalize_article_dict` / `_apply_article_updates_dict` extension pattern.
- The existing prompt-CRUD shape (`prompts.py`: routes, plan-based limits, validation) — directly templatable for "brief template" CRUD.
- `integrity_engine.execute_structural_humanization()` — already accepts `target_ai_pct`/`initial_strength`; needs a UI, not an engine change.
- `pipeline_streamer.py`'s SSE infrastructure — the new path emits the same status events, unchanged.

**Not reusable, on purpose:**
- `content_optimization.py`'s *compilation style* — "MODE" blocks claiming equal-or-greater weight than system rules is the exact failure pattern this redesign exists to retire. Its *coverage* (which SEO/AEO/GEO/EEAT concepts matter) is a useful checklist reference for populating the new SEO/EEAT Settings checkboxes — but the blocks themselves should not be revived or imported.

## 8. Risks

1. **The spec's literal "Creativity Level → temperature" mapping isn't implementable against the current model.** `gpt-5.5` ignores custom `temperature`. Designed around in §5 — flagged here so it's a known decision, not a mid-build surprise.
2. **Prompt-length / token-budget growth.** A fully-populated 19-section brief could compile longer than today's average free-text prompt. Re-run `estimate_bundle_tokens()` against a worst-case brief and confirm plan-tier `max_llm_tokens_per_month` budgets still hold.
3. **Shared-code temptation could regress the legacy path.** `build_generation_messages` is documented as behaviour-identical across every entry point. Keep the new builder fully separate (§5/§6) — duplication here is the *safer* choice, not a smell.
4. **The wizard itself could become the next "11 same-weight controls" critique.** The Articles-tab audit (2026-06-07) flagged exactly this pattern. A 19-field form is *more* surface than that toolbar; the spec's "more advanced than Jasper/Copy.ai/Surfer" bar is only met if grouping, progressive disclosure, and non-hover affordances get the same care as the field list.
5. **Slider semantics need empirical tuning, not a guess.** Both Humanization Level and Creativity Level need real generation runs to find mappings where, say, 40 vs. 70 actually feels different — a naive linear map risks a "dead zone" that becomes its own "why doesn't my setting do anything" complaint, the very class of problem this redesign exists to fix.
6. **Autosave race conditions.** Debounced `PATCH .../draft` plus possible multi-tab editing needs at minimum a last-write-wins-with-timestamp guard. Use `patch_article_fields` (`$set`, partial merge) deliberately for the draft endpoint — not `update_article_fields` (`replace_one`).
7. **Plan-tier interaction is currently undefined for the new surface.** Today's `writing_prompt_char_limit` / `max_writing_prompts` are plan-gated. V2 needs an equivalent decision for EEAT/SEO checkbox availability, industry-rule packs, or template counts — made deliberately, not left to fall through the cracks.

## 9. Recommended Folder Structure

**Backend:**
```
backend/app/services/ai/
  __init__.py
  prompt_builder.py        # PromptBuilderService.compile() — assembly + parameter mapping
  prompt_sections.py       # one _compile_xxx() per hierarchy layer
  industry_rules.py        # short factual per-industry context (NOT "mode" framing —
                           #   the structural replacement for content_optimization.py)
  seo_rules.py             # EEAT/SEO checkbox → single falsifiable line, one compiler per group
backend/app/schemas/
  content_brief.py         # ContentBrief Pydantic model — 19 sections, validated enums/ranges
backend/app/api/routes/
  content_briefs.py        # CRUD + draft autosave + brief-template management
```

**Frontend:**
```
frontend/src/components/ContentBrief/
  ContentBriefWizard.tsx        # shell: stepper, progress indicator, autosave, review step
  ContentBriefWizard.module.css
  steps/
    FoundationsStep.tsx
    KeywordsIntentStep.tsx
    VoiceStep.tsx
    DepthFormatStep.tsx
    TrustSeoStep.tsx
    GenerationTuningStep.tsx     # Humanization / Creativity sliders w/ descriptive labels
    GuardrailsDataStep.tsx
    AdditionalInstructionsStep.tsx
  ReviewStep.tsx
frontend/src/lib/
  contentBrief.ts                # types + typed API client functions (mirrors api.ts conventions)
```

---

## Closing note

The audit reframes the spec's premise in a way that should change how V2 is judged: the platform does **not** lack a "user wins" mechanism — it shipped one on 2026-06-05, named exactly that, as a corrective to `content_optimization.py`'s opposite design. What's missing is (a) enough structured surface for users to *express* intent across every dimension that matters, and (b) an assembly design where "user wins" is true by construction rather than true by assertion next to five blocks of denser, earlier, "non-negotiable" prose. This plan delivers both as a strictly additive change that never touches the documented-stable legacy path — and identifies the one place the spec's literal mechanism doesn't fit the current model (temperature-based creativity) with a working alternative already designed in, rather than left to surface mid-implementation.
