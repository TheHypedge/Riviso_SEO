# Prompt Flow Analysis

Status: **read-only audit — no code changed.** Companion to [`CURRENT_CONTENT_ENGINE_AUDIT.md`](./CURRENT_CONTENT_ENGINE_AUDIT.md). This document answers two specific questions in depth: **where prompts are built**, and **why user prompts don't strongly influence the output**.

---

## Q: Where are prompts built?

**One function, one file: `build_generation_messages()` in `backend/app/services/article_generation.py`.**

It is explicitly documented as the *single source of truth* for prompt construction — every generation entry point (manual generate, scheduled jobs, topic-cluster fan-out) calls through `execute_article_generation()` → `generate_article_bundle_safe()` → this function, so prompt construction never diverges between paths. Nothing upstream or downstream builds or edits prompt text; this is the one and only assembly point.

It returns a `(system, user)` tuple that is sent directly to OpenAI's chat-completions endpoint via `OpenAIClient.chat_json()`.

### The SYSTEM message — nine concatenated blocks, in this order

| # | Block | What it says | Framing |
|---|---|---|---|
| 1 | `HUMAN_FIRST_SYSTEM_ANCHOR` | "PRIMARY DIRECTIVE: Write body copy that reads as human-written under AI detectors…" | Directive, labeled PRIMARY |
| 2 | `human_guardrail` | AI-tell / banned-phrase guardrail, parameterized by title & focus keyphrase | Directive |
| 3 | "CONTENT STRUCTURE REQUIREMENTS **(non-negotiable…)**" | fixed heading/paragraph/list-formatting rules | Labeled non-negotiable |
| 4 | "CONTENT DEPTH REQUIREMENTS (apply unless user's writing instructions specify otherwise)" | minimum 1,500 words, ≥4 H2 sections | Conditional, but specific & first |
| 5 | "FAQ SECTION (apply unless user's writing instructions specify otherwise)" | `## Frequently Asked Questions`, 4–6 Q&A pairs | Conditional, but specific & first |
| 6 | **"USER PROMPT AUTHORITY"** | "The writing instructions in the user message are the HIGHEST PRIORITY directive… All other system requirements… are subordinate to the user's prompt and should be adjusted or skipped if the user instructs it." | Meta-instruction, asserts supremacy *retroactively* |
| 7 | JSON output-schema instruction | "Return ONLY a JSON object with exactly these keys…" | Format spec |
| 8 | "STRICT OUTPUT RULES" + 35-item banned-phrase list | `format_ai_detector_banned_phrases_for_prompt()` | Directive list |
| 9 | Brand/niche "flavor" + Shopify/WordPress `product_rules` | only when applicable | Context + directive |

### The USER message — small and uniform

```text
Article title: {title}
Target keywords: {keywords joined by comma}
Focus keyphrase: {focus_keyphrase}

Writing instructions (MANDATORY — follow every requirement below):
{the user's selected writing-prompt text, with {article_title} / {targeting_keywords} /
 {focus_keyphrase} / {short_focus_keyphrase} placeholders substituted via _apply_placeholders()}

Output the JSON object now.
```
Plus, when relevant, an appended block of Shopify/WordPress mapped-page/product context.

### Where the user's prompt text itself comes from

It is **not** typed fresh at generation time. It is selected from a per-project library of saved "writing prompts" — a flat list of `{id, name, text}` records managed on the project's **Prompts** tab (`frontend/src/app/projects/[projectId]/page.tsx`, `tab === "prompts"`). Each prompt is a single free-text `<textarea>` (plan-gated 5–100,000 characters, screened by `prompt_validation.assert_writing_prompt_allowed()` for jailbreak/harmful/off-topic patterns), with one marked as the project default. New projects are seeded with a built-in `_DEFAULT_WRITING_PROMPT_TEXT` (`backend/app/api/routes/prompts.py`) requesting 1,500–2,500-word in-depth articles with an FAQ section.

So: **"where prompts are built" has two honest answers** — the *text the user supplies* is authored (or left at the default) in the Prompts tab's free-text editor; the *final prompt sent to the model* is assembled, every single time, by `build_generation_messages()`.

---

## Q: Why don't user prompts strongly influence the output?

This needs a precise answer, because the obvious assumption — "the system just overrides the user" — **does not match what the code shows**.

### The mechanism the question implies is missing... already exists

Block #6 above, **"USER PROMPT AUTHORITY,"** was added on **2026-06-05** for exactly this complaint. It states in plain language that the user's writing instructions are the highest-priority directive and that *all* other system requirements — including the depth and FAQ rules immediately above it — are subordinate and should be skipped if the user says so. This is recorded project history (`CLAUDE.md`, project memory): it was the fix for a prior regression where prompts were being ignored, and it directly replaced an older mechanism (`content_optimization.py`, see below) that had the opposite design.

So the literal thing being asked for — "make the system guarantee the user's instructions win" — **is already source code, present and running today**.

### Then why does the complaint persist? Two compounding, structural reasons

**1. Most user prompts don't cover enough surface area to *be* influential — and the system can't tell the difference between "the user is fine with the default" and "the user never thought to mention it."**

A typical writing prompt says something like "Write a comprehensive article about X, use H2/H3 headings, include an FAQ." That's roughly what the *system* already injects by default. It says nothing about tone, audience sophistication, brand personality, how much to lean on statistics vs. examples, what to avoid, how creative to be, etc. On every one of those un-mentioned axes, the system default simply governs — *correctly, by design, because nothing told it otherwise*. But the user doesn't experience "the parts I specified were honored" — they experience "the output doesn't sound like what I had in mind," because what they had in mind was never expressible in the one field they were given. The perceived failure is real; its cause is a **silence gap**, not an override.

**2. Where a prompt *does* try to steer something the system also governs, it has to win an argument, not just exist.**

Suppose a user writes "keep this short and conversational." That collides head-on with block #3 ("non-negotiable… 5 H2 sections, 3+ paragraphs each") and block #4 ("minimum 1,500 words"). The model now holds, in its context window:
- Five blocks of dense, specific, repeatedly-reinforced, "non-negotiable"/"MANDATORY"-labeled instruction, *textually first*, plus
- One paragraph, *textually sixth*, saying "actually, ignore some of the above if the user's much-shorter, much-vaguer instruction conflicts with it."

LLMs weight instructions heavily by specificity, repetition, and the strength of the language used to deliver them — not by a single late clause asking them to retroactively re-rank everything that came before. The "USER PROMPT AUTHORITY" directive is *true*, but it is fighting an uphill battle against five blocks that are individually more detailed and more emphatically worded than it is. The result is inconsistent: sometimes the model honors the user's override, sometimes it "compromises" by blending both (which satisfies neither), sometimes the system defaults simply win on raw textual weight.

### The historical contrast that proves the point

`content_optimization.py` — the subsystem this directive was added to neutralize — is even more revealing. Its own docstring states its blocks were designed to **"carry the same weight as other system-prompt rules so they are not overridden by the user's writing prompt."** That is the *opposite* design philosophy from "USER PROMPT AUTHORITY," written into the architecture on purpose. It is no longer imported anywhere (confirmed via grep) — it is dead code, left in place as a fossil of the exact failure mode the current directive exists to prevent. Its existence — and the fact that a corrective directive had to be written *against* it — is itself the clearest evidence that **the platform's prompt-construction philosophy has already had to course-correct once**, and the lesson from that course-correction (a competing-authority block dilutes user intent even when it's well-intentioned) is precisely the lesson the V2 redesign needs to internalize structurally, not just restate in prose.

### Bottom line

> **It's not that the user's prompt is ignored. It's that (a) most prompts don't say enough for "influence" to be observable across most dimensions, so the system fills the silence and gets blamed for the result; and (b) on the dimensions where prompts do try to steer, a single paragraph of meta-authority is structurally outgunned by five earlier, denser, more emphatically-worded system blocks it's being asked to retroactively subordinate.**

V2 (see [`CONTENT_ENGINE_V2_PLAN.md`](./CONTENT_ENGINE_V2_PLAN.md) §"How V2 avoids the regression") fixes both halves at once: the 19-section guided form closes the silence gap by guaranteeing every dimension is *expressed* somewhere, and the new compilation hierarchy makes user authority **true by construction** — every non-user layer is rewritten as short, factual, non-competing statements, leaving the user's own free-text section (§19, "Additional Instructions") as the *only* prose-register, authority-claiming block left in the entire prompt. At that point "the user wins" stops being something the model has to be persuaded of, and becomes something the structure simply makes true.

## Weaknesses (prompt-construction specific)

1. **Single free-text field as the only instrument** — one textarea must carry tone, audience, structure, depth, goal, restrictions, and emphasis simultaneously; most users can't (and shouldn't have to) write prose precise enough to do that.
2. **Authority asserted late and once, not built in** — block #6 is one paragraph among nine, asking the model to re-rank five more-specific blocks that came before it.
3. **No adherence signal** — the pipeline audits AI-detection percentage post-hoc but has no equivalent check for "did the model follow what the user asked."
4. **A philosophically opposite subsystem still exists in the codebase** (`content_optimization.py`) — not imported, but a live demonstration of the failure mode any new structured-input design must avoid repeating.
5. **The default seed prompt overlaps the system defaults** — `_DEFAULT_WRITING_PROMPT_TEXT` largely restates what blocks #3–#5 already enforce, meaning a brand-new project's "user prompt" adds almost no new signal over the system baseline — the silence gap starts on day one.
