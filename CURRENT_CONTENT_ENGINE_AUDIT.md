# Current Content Engine — Audit

Status: **read-only audit — no code changed.** This is the top-level summary; two companion documents go deeper on specific angles:
- [`PROMPT_FLOW_ANALYSIS.md`](./PROMPT_FLOW_ANALYSIS.md) — where prompts are built, and why user prompts under-influence output
- [`CONTENT_GENERATION_ARCHITECTURE.md`](./CONTENT_GENERATION_ARCHITECTURE.md) — AI provider, services, APIs, data flow
- [`CONTENT_ENGINE_V2_PLAN.md`](./CONTENT_ENGINE_V2_PLAN.md) — the redesign plan

---

## Q: How does article generation currently work, end to end?

```
1. User selects/edits a "writing prompt" (free-text) on the project's Prompts tab,
   then clicks Generate on an article (or a schedule/topic-cluster job fires).

2. POST /projects/{id}/articles/{article_id}/generate   (articles.py route)
     → builds a GenerationJob(kind=ARTICLE_GENERATE) and enqueues it to Redis
       (generation_queue.py — falls back to an in-process asyncio.Queue if Redis
       is unavailable; dedup'd by key, bounded by a semaphore)
     → returns 202 immediately with the article_id

3. The worker container (ENABLE_GENERATION_WORKER=1) dequeues the job and calls
   execute_article_generation()  [article_pipeline.py]
     a. resolves the writing prompt (and image prompt, if requested) from the
        project's stored prompt list
     b. validates the prompt text against jailbreak/harmful/off-topic patterns
        (prompt_validation.assert_writing_prompt_allowed)
     c. resolves platform extras — Shopify product mapping or WordPress page
        mapping → product_context / reference_image_url
     d. estimates token cost and checks the user's plan budget & daily/monthly
        article quota (consumes quota up front; refunds it if generation throws)
     e. calls generate_article_bundle_safe() [article_generation.py], which:
          - builds the (system, user) chat messages — see PROMPT_FLOW_ANALYSIS.md
          - calls OpenAI's chat-completions API for the article JSON
          - runs sanitizers (strict-JSON enforcement, body/meta sanitization)
          - optionally generates a featured image (gpt-image-1)
     f. runs a read-only AI-detection audit (integrity_engine.AIDetectionAuditor)
        and stores the resulting percentage — it does NOT rewrite anything
     g. injects the project's "context links" into the generated Markdown
        (context_links.apply_context_links_markdown)
     h. persists everything to MongoDB (patch_article_fields / update_article_fields)
     i. publishes SSE pipeline-status events at each stage so the editor UI can
        show live progress ("Dispatching to OpenAI…", "Verifying integrity…", etc.)

4. The article record now has status "draft" (or keeps "published" if it was
   already live), with article/meta_title/meta_description/image_url/integrity_*
   fields populated, ready for review, scheduling, or direct publish.
```

This is the **single, unified pipeline** for every entry point — manual "Generate" clicks, scheduled jobs, and topic-cluster fan-out all converge on `execute_article_generation()`, which is explicitly documented as running "the same steps as `POST .../generate`" so behavior never diverges between paths.

## Q: How is content stored?

**MongoDB is the single source of truth** (legacy `data/*.json` files exist only for dev/import fallback under `AUTO_IMPORT_JSON=1` — production routes never read them). The repo-root `storage.py` is the canonical write interface; `_normalize_article_dict()` defines the article schema and `_apply_article_updates_dict()` defines how partial updates merge.

Article documents carry (non-exhaustive — grouped by purpose):

| Group | Fields |
|---|---|
| Identity | `id`, `project_id`, `title`, `keywords`, `focus_keyphrase`, `status`, `created_at`, `updated_at` |
| Generated content | `article` (Markdown body), `meta_title`, `meta_description`, `generated_at` |
| Featured image | `image_url`, `featured_image_source`, `featured_image_model`, `featured_image_prompt_id`, `featured_image_prompt_raw/final`, `featured_image_optimizer_model`, `featured_image_regeneration_count`, `featured_image_quality/size/storage` |
| Integrity / freshness | `integrity_ai_percentage`, `integrity_flagged_paragraphs`, `integrity_last_audited_at`, `fresh`, `stale`, `monitor_status/score/signature/last_checked_at` |
| Platform sync | `wp_post_id`, `wp_link`, `wp_synced_at`, `wp_scheduled_at`, `wp_schedule_*`, `shopify_article_id`, `shopify_blog_id`, `shopify_link`, `shopify_published_at` |
| Topic clusters | `topic_cluster_id`, `topic_role`, `topic_slot_id` |
| GSC | `gsc_status`, `gsc_inspection_url/requested_at/last_attempt_at/error` |

Two persistence semantics matter (and are load-bearing for any new fields, including future content-brief fields — see V2 plan):
- **`update_article_fields`** = full `replace_one` (overwrites the whole document)
- **`patch_article_fields`** = `$set` (merges only the given keys)

The generation pipeline prefers `patch_article_fields` (falls back to `update_article_fields` if unavailable) — i.e. it merges rather than replaces, so concurrent unrelated edits (e.g. a user editing the title while generation runs) aren't clobbered.

**Project documents** store the prompt library (`prompts: [{id, name, text}]`, `default_prompt_id`; same shape for `image_prompts`/`default_image_prompt_id`), brand/niche identity (`brand_identity`, `niche_identifier`), and `context_links: [{label, url}]`.

**Generation jobs** are transient — they live in Redis (or an in-process queue fallback), not MongoDB; only their *results* are persisted.

## Q: What can be reused for V2? *(short answer — full reuse strategy in the V2 plan)*

Almost the entire pipeline is reusable as-is:
- `execute_article_generation()`'s orchestration (quota checks, platform extras, sanitizers, image generation, integrity audit, context-link injection, SSE status, persistence) — **none of this needs to change**; only the *prompt-assembly* sub-step needs a new branch.
- The storage layer's merge semantics (`patch_article_fields`) and schema-extension pattern (`_normalize_article_dict` / `_apply_article_updates_dict`) — the exact mechanism for adding the new `content_brief` field.
- The existing prompt CRUD shape (`prompts.py` routes, plan-based limits, validation pattern) — directly reusable as the template for the new "brief template" CRUD.
- `integrity_engine.execute_structural_humanization()` — already supports tunable `target_ai_pct`/`initial_strength`; it just has no UI today. V2's Humanization Level slider can drive these existing parameters without touching the engine.
- The SSE pipeline-status streaming infrastructure (`pipeline_streamer.py`) — no changes needed; the new path emits the same status events.

What is **not** reusable, and why: `content_optimization.py` — its blocks were designed to "carry the same weight as system rules so they are not overridden by the user's writing prompt," which is the exact failure pattern V2 must avoid. Its *coverage* (SEO/AEO/GEO/EEAT concepts) is a useful reference for which checkboxes V2's SEO/EEAT Settings should include — but its *compilation style* (authority-claiming "MODE" blocks) must not be reused. See `PROMPT_FLOW_ANALYSIS.md` for the full explanation of why that mattered, and `CONTENT_ENGINE_V2_PLAN.md` for how the new design replaces it.

## Weaknesses summary *(detail in companion docs)*

1. One free-text field carries every dimension of user intent — most prompts are short/vague and leave most dimensions unspecified, so system defaults silently govern and get blamed.
2. "USER PROMPT AUTHORITY" is asserted in prose, one paragraph among nine, rather than guaranteed by the structure of the prompt itself.
3. No machine-checkable signal exists for "did the model honor what the user asked for" — only AI-detection percentage is audited.
4. Two fully-built subsystems (`content_optimization.py`, tunable humanization) sit dormant beside the pipeline — one because its design was the literal root cause of a regression, one for lack of a UI.
5. The prompt-management UI is a flat CRUD list with no scaffolding, drafts, or guidance.

Full detail: [`PROMPT_FLOW_ANALYSIS.md`](./PROMPT_FLOW_ANALYSIS.md) §"Weaknesses" and §"Why user prompts don't strongly influence outputs".
