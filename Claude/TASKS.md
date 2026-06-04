# TASKS.md — Current Work Items

_Last updated: 2026-06-04_

---

## Active / In-Progress

| # | Task | File(s) | Priority |
|---|------|---------|----------|
| T-01 | Restore admin MongoDB account `iamakhileshsoni@gmail.com` | Atlas console (external) | High |
| T-02 | Deploy latest `development` branch to VPS | VPS: `git pull && docker compose build && docker compose up -d` | High |
| T-03 | Monitor featured image regeneration after permissions fix | `backend/app/services/shopify_article_image.py`, worker logs | Medium |
| T-04 | Wire `generation_error` display in article list UI | `frontend/src/app/projects/[projectId]/page.tsx` | Medium |

---

## Technical Debt

| # | Item | Notes |
|---|------|-------|
| TD-01 | PostgreSQL is configured but unused | `docker-compose.yml` runs postgres; Alembic migrations exist; MongoDB is primary. Plan: either migrate or remove the dead service |
| TD-02 | `storage.py` (repo root) is 4,800+ lines of flat dict functions | Repository layer (`backend/app/repositories/`) started as typed facade. Migrate route handlers to use repositories over time |
| TD-03 | No `from __future__ import annotations` in route files | Already removed. Enforce via linter rule or code comment to prevent accidental re-addition |
| TD-04 | `backend/app/legacy/storage.py` re-exports repo-root `storage.py` | `get_legacy_storage_module()` pattern is a workaround for circular imports. Should be cleaned up as part of repository migration |
| TD-05 | In-process asyncio fallback for generation queue | When Redis is down, queue falls back to in-process `asyncio.Queue`. This means jobs are lost on process restart. Production should always have Redis running |
| TD-06 | Blocking pymongo reads in async context | Many route handlers use `await run_sync(call_storage, fn, ...)`. Motor is partially adopted for hot paths. Full Motor migration would remove thread-pool overhead |
| TD-07 | Low test coverage | CI runs pytest but most service logic is untested. No E2E tests. Priority: integrity_engine.py, article_pipeline.py, generation_queue.py |
| TD-08 | `data/projects.json` and `data/articles.json` still in repo | Legacy JSON fallback files. Should be removed after confirming no dev environment depends on them |

---

## Known Bugs

| # | Bug | Status | Notes |
|---|-----|--------|-------|
| B-01 | Generation stuck at "queued" (no worker logs) | Fixed (worker now persists `generation_error`; `_ensure_project_prompt_defaults` added) | Monitor in production |
| B-02 | Featured image regeneration permission denied | Fixed (27f2262 — permissions + error propagation) | Monitor |
| B-03 | Research tab (custom curations) returned no output | Fixed (research now always synchronous; removed async queue branch in `research.py`) | |
| B-04 | Timezone scheduling used server UTC instead of user profile timezone | Fixed (`user_timezone` param added to all schedule API calls) | |
| B-05 | Auth loop in production (users logged out immediately after login) | Fixed (added `app.riviso.com`/`app.riviso.cloud` to `RIVISO_APP_HOSTS`; cookie domain left empty) | |
| B-06 | 422 "payload: Field required" on article generation | Fixed (removed `from __future__ import annotations` from `articles.py`, `auth.py`, `research.py`) | |
| B-07 | Custom prompts not followed (AEO/GEO labels but no structure) | Fixed (content_optimization_profile blocks injected into system prompt) | |
| B-08 | Humanization always at hardcoded 6% target / 6 passes | Fixed (configurable per project via `humanization_settings`) | |
| B-09 | Generic content with no H2/H3/bullets; custom writing prompt ignored | Fixed (commit 4e4896c) — `HUMAN_FIRST_SYSTEM_ANCHOR` declared "SEO structure secondary" as PRIMARY DIRECTIVE overriding everything; removed. Added explicit structural requirements (min 3 H2, bullets, numbered lists) + USER PROMPT AUTHORITY declaration. Default writing prompt also updated. | Deploy to VPS to activate |
| B-10 | Regenerate modal had no prompt selectors; user couldn't change writing/image prompt before regenerating | Fixed (commit 45ab143) — Writing prompt, image prompt, and generate image selectors added directly inside the regeneration confirmation modal. | Deploy to VPS |
| B-11 | Curation "Generate selected" froze UI for 50+ min (serial loop, no skipGlobalLoading, 10-min wait per article) | Fixed (commit 45ab143) — Parallel `Promise.allSettled()` with `noWait:true`; modal closes immediately with "queued" message. Added `noWait` option to `api.generateArticle()`. | Deploy to VPS |
| B-12 | Cluster generate modal stayed open showing "Generating…" for entire batch duration | Fixed (commit 45ab143) — Modal closes immediately after dispatching; generation continues in background. | Deploy to VPS |

---

## Prioritized Next Actions

1. **[T-01]** Recreate admin account in MongoDB Atlas — required for platform management
2. **[T-02]** Deploy to VPS — current `development` branch has all latest fixes
3. **[T-04]** Show `generation_error` in article list — users need visibility when generation fails
4. **[TD-07]** Write service tests — `integrity_engine`, `article_pipeline`, `content_optimization`
5. **[TD-01]** Remove PostgreSQL from docker-compose or commit to migration
6. Payment integration — Stripe/Paddle; this is the critical blocker for post-beta revenue

---

## Completed (Recent)

- [x] Content Optimization Profiles (SEO/AEO/GEO/E-E-A-T) — commit `0a556a2`
- [x] Configurable Humanization Guardrails — same commit
- [x] `generation_error` persistence on worker failure — same commit
- [x] `_ensure_project_prompt_defaults` prevents nil-prompt generation errors — same commit
- [x] `ENABLE_GENERATION_WORKER` / `ENABLE_SCHEDULER` read from pydantic Settings — same commit
- [x] Featured image regeneration fix — commit `27f2262`
- [x] Auth loop fix — added production hostnames to `RIVISO_APP_HOSTS`
- [x] 422 fix — removed `from __future__ import annotations` from route files
- [x] Research synchronous fix — removed async branch from research route
- [x] Timezone scheduling fix — `user_timezone` in all schedule calls
