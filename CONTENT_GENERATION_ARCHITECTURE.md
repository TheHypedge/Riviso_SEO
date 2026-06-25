# Content Generation Architecture

Status: **read-only audit — no code changed.** Companion to [`CURRENT_CONTENT_ENGINE_AUDIT.md`](./CURRENT_CONTENT_ENGINE_AUDIT.md). This document answers: **which AI provider is used, what APIs are called, and which services are involved.**

---

## Q: Which AI provider is used?

**OpenAI, exclusively** — accessed through one thin wrapper, `backend/app/services/openai_client.py` (`OpenAIClient`). Three distinct OpenAI capabilities are used, each for a distinct purpose:

| Capability | Model (from `backend/app/core/config.py`) | Used for | Called from |
|---|---|---|---|
| Chat completions (JSON mode) | `openai_text_model = "gpt-5.5"` | Generating the article JSON bundle (article body, meta title, meta description) | `OpenAIClient.chat_json()` ← `article_generation.generate_article_bundle()` |
| Image generation | `gpt-image-1` | Featured images (initial generation + on-demand regeneration) | `article_generation.generate_featured_image_only()` / the bundle's image step |
| Embeddings | `text-embedding-3-small` | Semantic similarity scoring (used in research/clustering and the humanization engine's `seo_preservation_score`) | various — outside the core generation path |

**A specific, load-bearing detail for any future "creativity" control:** `OpenAIClient.chat_json()` (lines 77–93) explicitly **does not send a custom `temperature`** when the model name starts with `gpt-5` — the comment states "GPT-5.x only accepts the default temperature (1)". For older model families it sends a hardcoded `temperature=0.6`. Since the configured production model is `gpt-5.5`, **temperature is currently not a controllable axis in production at all.** Any design that wants a user-facing "creativity" dial must route around the `temperature` parameter — see the V2 plan's risk section for the recommended alternative (a compiled prompt instruction about creative range, not an API parameter).

No other AI provider (Anthropic, Google, etc.) appears anywhere in the generation path.

## Q: What APIs are called?

### External (third-party)
| API | Purpose | Caller |
|---|---|---|
| `POST https://api.openai.com/v1/chat/completions` (JSON mode) | Article JSON generation | `OpenAIClient.chat_json()` |
| OpenAI image generation endpoint (`gpt-image-1`) | Featured image generation | `OpenAIClient` image methods |
| OpenAI embeddings endpoint (`text-embedding-3-small`) | Semantic similarity | `OpenAIClient` embedding methods |
| WordPress REST API | Publishing/updating posts, uploading featured media | `wordpress_publish.py` |
| Shopify Admin API | Publishing/updating product/blog content | `shopify_product_pipeline.py` (and related Shopify services) |
| Google Search Console API | Indexing requests, search analytics | `gsc.py`, `gsc_actions.py`, `google_console_service.py` |

### Internal (frontend ⇄ backend, all proxied through Next.js per the project's `/api/*` rule)
| Route | Purpose |
|---|---|
| `POST /projects/{id}/articles/{article_id}/generate` | Kick off generation (enqueues a job, returns 202) |
| `POST /projects/{id}/articles/{article_id}/regenerate-image` | On-demand featured-image regeneration |
| `GET/POST/PATCH/DELETE /projects/{id}/prompts` (+ `/set-default`) | Writing-prompt CRUD — `backend/app/api/routes/prompts.py` |
| `GET/POST/PATCH/DELETE /projects/{id}/image-prompts` | Image-prompt CRUD (same router/shape) |
| SSE pipeline-status stream | Live "Dispatching to OpenAI… / Verifying integrity… / Complete" updates to the editor UI — `pipeline_streamer.py` |
| Article CRUD / listing routes | `articles.py` and friends — outside the generation path itself but the persistence target |

## Q: Which services are involved?

A map of every backend service that participates in (or sits beside) the generation pipeline, grouped by role:

### Orchestration
- **`article_pipeline.py`** (554 lines) — `execute_article_generation()` and `execute_featured_image_regeneration()`. The single exit point for all generation paths: resolves prompts, validates them, checks quota/budget, calls the bundle generator, runs the integrity audit, applies context links, persists, and streams status. Explicitly extracted from the API routes "so topic-cluster fan-out and the `POST .../generate` route stay behaviour-identical."
- **`generation_queue.py`** (230 lines) — Redis-backed job queue (`GenerationJob`, `GenerationJobKind.ARTICLE_GENERATE`) with an in-process `asyncio.Queue` fallback, dedup keys, and a bounded semaphore. Listed in the project's "files not to modify without understanding" — dedup TTL and semaphore bounds are load-bearing.

### Prompt construction & generation
- **`article_generation.py`** (481 lines) — THE prompt-assembly module. `build_generation_messages()` (the single source of truth for prompt text), `generate_article_bundle()` / `generate_article_bundle_safe()` (calls OpenAI, runs sanitizers, handles Shopify/WordPress injection and image generation), `generate_featured_image_only()`, `estimate_bundle_tokens()`.
- **`openai_client.py`** — thin OpenAI HTTP wrapper (`chat_json`, image, embeddings). Owns the temperature/model-family logic noted above.
- **`human_writing_guardrail.py`** — supplies `HUMAN_FIRST_SYSTEM_ANCHOR`, the per-article guardrail text, and the AI-detector banned-phrase list injected into the system prompt.
- **`generation_blocklist.py`** — `format_banned_phrases_for_prompt()`, a general banned-phrase formatter used alongside the AI-detector list.
- **`prompt_validation.py`** — `assert_writing_prompt_allowed()` / `assert_image_prompt_allowed()`: regex-based jailbreak/harmful/off-topic screening plus length bounds (5–100,000 chars for writing prompts). The boundary-validation gate every saved or submitted prompt passes through.
- **`seo_guardrails.py`** — `enforce_strict_article_json`, `build_programmatic_image_prompt`, `estimate_generation_token_budget` — output-shape and token-budget helpers used by the bundle generator.
- **`content_sanitizer.py`** — `sanitize_article_body`, `sanitize_meta_title`, `sanitize_meta_description` — post-generation cleanup of the model's raw output.

### Post-generation processing
- **`integrity_engine.py`** (166 lines) — `AIDetectionAuditor` (runs on *every* generation, read-only — stores `integrity_ai_percentage`/`integrity_flagged_paragraphs`, never rewrites) and `execute_structural_humanization()` (only reachable from the on-demand editor "Humanize" button; fixed defaults of 6 max passes / 6% AI-detection target / 0.78 initial strength, though the function signature already supports per-call overrides — a dormant capability with no UI). Listed in "files not to modify without understanding": "called only from the on-demand editor humanize route; not in auto-generation flow."
- **`context_links.py`** (161 lines) — `apply_context_links_markdown()`: injects the project's `{label, url}` context links into generated Markdown as the final mandatory step before persistence ("All generation workflow paths… reach this point, so this is the single mandatory application site").
- **`riviso_grammar_engine.py` / `riviso_human_profile.py` / `riviso_linguistics.py` / `riviso_paraphrase_engine.py`** — the linguistic engines underneath `integrity_engine` (grammar pipeline, natural-language polishing, AI-marker detection/scrubbing, paraphrasing).

### Platform integration
- **`platform_generation.py`** — `resolve_platform_generation_extras()`: resolves Shopify/WordPress mapped products/pages into `product_context` and `reference_image_url` for the prompt.
- **`shopify_product_pipeline.py`**, **`wordpress_content_pipeline.py`**, **`wordpress_publish.py`** — platform-specific resolution and publishing.
- **`cluster_internal_link_service.py`** — resolves cluster-sibling pages for auto-linking when the client doesn't supply an explicit page list.

### Streaming & quota
- **`pipeline_streamer.py`** — SSE status publishing (`publish_pipeline_status`, `publish_pipeline_error`) with named stage/message constants (`STAGE_OPENAI_DISPATCH`, `STAGE_INTEGRITY_VERIFY`, `STAGE_FEATURED_IMAGE`, `STAGE_COMPLETE`, etc.).
- Quota/budget logic lives directly in `article_pipeline.py` (`st.check_llm_token_budget`, `st.consume_article_usage`, `st.consume_llm_generation_tokens`, `st.refund_article_usage`) — backed by `storage.py` / plan documents (`st.load_plans()`).

### Present but disconnected (dead/dormant)
- **`content_optimization.py`** (82 lines) — SEO/AEO/GEO/E-E-A-T "mode" blocks. Confirmed unimported anywhere; explicitly listed as "not used… do not re-import without explicit user request."
- **`integrity_engine`'s tunable humanization parameters** — present in the function signature, unreachable from any UI.

### Persistence
- **`storage.py`** (repo root) — canonical MongoDB write interface. `_normalize_article_dict()` / `_apply_article_updates_dict()` define the article schema and merge rules. `patch_article_fields` (`$set`, partial merge) vs. `update_article_fields` (`replace_one`, full overwrite) — the pipeline prefers the former.
- **`storage_db.py`** — `call_storage()`, the thread-pool wrapper that keeps blocking Mongo calls off the asyncio event loop (per the project's `run_sync` convention).
- **`mongo_listings_async.py`** — Motor async reads for hot paths (listing/search), separate from the write path above.

## Architecture diagram (data flow)

```
┌─────────────┐     POST /generate      ┌──────────────┐
│  Frontend    │ ──────────────────────▶ │ articles.py  │
│ (Prompts tab,│                         │   route      │
│  Generate btn)│                        └──────┬───────┘
└─────────────┘                                 │ enqueue GenerationJob
                                                 ▼
                                         ┌──────────────────┐
                                         │ generation_queue │ (Redis / in-proc fallback)
                                         └────────┬─────────┘
                                                  │ dequeue
                                                  ▼
                                  ┌────────────────────────────────┐
                                  │   execute_article_generation() │  ◀── article_pipeline.py
                                  │  (resolve · validate · quota · │      (single exit point)
                                  │   platform extras · audit ·    │
                                  │   context links · persist ·    │
                                  │   SSE status)                  │
                                  └───────────────┬────────────────┘
                                                  │
                         ┌────────────────────────┼─────────────────────────┐
                         ▼                        ▼                         ▼
              ┌────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
              │ generate_article_  │   │ AIDetectionAuditor  │   │ apply_context_links_│
              │ bundle_safe()      │   │ (read-only audit)   │   │ markdown()          │
              │  build_generation_ │   └─────────────────────┘   └─────────────────────┘
              │  messages()  ──┐   │
              │                │   │
              │      ┌─────────▼─┐ │
              │      │ OpenAI    │ │   chat-completions (gpt-5.5, JSON mode)
              │      │ chat_json │─┼──▶ image gen (gpt-image-1) ──▶ embeddings
              │      └───────────┘ │
              │  sanitizers ───────┘
              └────────────────────┘
                         │
                         ▼
                 ┌───────────────┐        ┌──────────────────┐
                 │  storage.py   │ ─────▶ │     MongoDB       │
                 │ patch_article_│        │ (single source    │
                 │ fields ($set) │        │  of truth)        │
                 └───────────────┘        └──────────────────┘
```

See [`PROMPT_FLOW_ANALYSIS.md`](./PROMPT_FLOW_ANALYSIS.md) for what happens *inside* the `build_generation_messages()` box.
