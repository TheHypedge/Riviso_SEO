# Riviso — Performance Optimization Audit

> **Scope:** Full-stack call/API optimization review of the active workspace.
> **Backend:** FastAPI + synchronous PyMongo (`backend/app/`, repo-root `storage.py`, `database.py`).
> **Frontend:** Next.js 16 / React 19 (`frontend/src/`).
> **Lens requested:** (1) Data structures, (2) OOP concepts, (3) Structuring of API calls.
> **Companion doc:** `RIVISO_BACKEND_ARCHITECTURE_BLUEPRINT.md` (architecture reference).

Every finding below cites a real `file:line` so you can jump straight to it. Findings are grouped by the three lenses, then a prioritized roadmap is given at the end.

---

## 0. How to read this document

| Severity | Meaning |
|----------|---------|
| 🔴 **High** | Scales with data/traffic; user-visible latency or DB load today |
| 🟠 **Medium** | Wasteful but bounded; fix during related work |
| 🟢 **Low** | Cleanup / future-proofing |

Each item has: **Where**, **Now** (current behavior), **Why it's slow**, **Fix** (one concrete change).

The single biggest structural fact driving most issues: **the data layer is 100 module-level functions over ~4,760 lines (`storage.py`) that pass raw `dict[str, Any]` everywhere (120 such annotations), with synchronous PyMongo run on a thread pool.** That choice ripples into the data-structure, OOP, and API-structuring problems below.

---

## 1. DATA STRUCTURES

### 1.1 🔴 Linear scans where a dict/set index belongs

**A. Validate bulk IDs by loading 20k rows and scanning**
**Where:** `backend/app/api/routes/articles.py:1028-1037`
**Now:** To check whether ≤500 submitted article IDs belong to a project, the handler loads up to 20,000 listing rows and linearly scans them building an `allowed` set.
**Why slow:** O(project size) work + full listing transfer to validate a tiny set.
**Fix:** Add `storage.load_articles_by_ids_for_project(project_id, ids)` backed by a Mongo `{"id": {"$in": ids}}` existence query; build the set from that.

**B. Find one article by scanning the whole project**
**Where:** `backend/app/api/routes/scheduled_jobs.py:246-256` (`_find_article_for_job`)
**Now:** `load_articles_listing_for_project(pid, limit=20000)` then `for a in rows: if a["id"] == aid`.
**Why slow:** O(n) per lookup, and this is called inside loops (heal, retry-all).
**Fix:** Use the existing `storage.get_article(project_id, article_id)` single-doc indexed read.

**C. WordPress routes scan all projects in Python**
**Where:** `backend/app/api/routes/wordpress.py:470-472`
**Now:** `next((p for p in (st.load_projects() or []) if p["id"] == pid), None)` on every WP settings/verify/categories call.
**Why slow:** Full owner project list pulled + linearly scanned for one project, synchronously, on the event loop.
**Fix:** Route through `app.core.project_lookup.require_project_access` (indexed `find_one` + cache).

**D. JSON-mode article lookups re-load and scan the whole file**
**Where:** `storage.py:2531-2536`, `2805-2818`, `3035-3037`
**Now:** Each single-article read reloads `articles.json` and scans every row for a matching id.
**Why slow:** O(n) file parse per request in JSON fallback mode.
**Fix:** Build a `{id: row}` index once on load (or use SQLite for JSON mode).

> **Principle:** Any time the code shape is `for x in big_list: if x[key] == needle`, replace the list with a `dict`/`set` keyed by `key`, or push the filter into Mongo (`$in` / `find_one`).

### 1.2 🔴 Loading whole documents (and whole collections) when a projection suffices

**A. `load_articles()` — unbounded `find({})`**
**Where:** `storage.py:2506-2510`
**Now:** `find({})` returns every article including multi-MB `article` body and `image_url` blobs; called from several routes/services.
**Why slow:** O(all articles) memory + wire transfer.
**Fix:** Deprecate; replace callers with scoped `project_id` / `$in` queries + projections.

**B. `get_project_by_id` / `load_projects` — no projection**
**Where:** `storage.py:2323-2326`, `2490-2503`
**Now:** Pulls embedded `shopify_catalog`, `prompts[]`, `image_prompts[]`, OAuth tokens for every fetch — including in the generation worker on a hot loop.
**Why slow:** The Shopify catalog alone can be multi-MB; fetched repeatedly.
**Fix:** Use existing `_PROJECT_*_PROJECTION` constants per call site; add a slim `_PROJECT_GENERATION_PROJECTION`.

**C. `get_user_by_id` / `list_users` — full docs every time**
**Where:** `storage.py:1515-1520`, `477-479`
**Now:** Loads password hashes, GSC tokens, usage counters even when only a few fields are needed; `get_user_by_id` runs on *every* authenticated request.
**Why slow:** Full-doc read on the hottest path; the regex fallback at `1516` can't use the `id` index.
**Fix:** Pass an explicit projection; normalize id casing at write time to drop the regex fallback.

**D. Counting by materializing rows**
**Where:** `storage.py:3126-3150` (JSON `count_articles_listing_for_project`)
**Now:** Loads up to 20,000 listing rows then returns `len(out)`.
**Why slow:** Thousands of rows transferred to produce one integer.
**Fix:** Mirror the Mongo `count_documents` path; never materialize to count.

### 1.3 🟠 Read-modify-write of full documents to change one field

**Where:** `storage.py:4104-4113` (articles), `4006-4015` (projects), `4167-4177` (`bulk_update_articles`)
**Now:** `find_one(full doc)` → mutate dict in Python → `replace_one(full doc)`. `bulk_update_articles` does this per item (a classic N+1: K reads + K replaces, each carrying the body).
**Why slow:** 2× wire cost + full BSON re-encode of the body on every small update.
**Fix:** Route partial updates through `update_one(..., {"$set": fields})` (the `patch_article_fields` helper at `4117-4134` already does this — make it the default). For bulk: one `find({"id": {"$in": ids}}, projection)` + a single `bulk_write` of `$set` ops.

### 1.4 🟠 Recomputing derived values per element

**A. `hasBody` computed for every row before `$limit`**
**Where:** `storage.py:3045-3060` (also `3201-3207`, `3348-3391`)
**Now:** The listing `$project` runs `$strLenCP` over `$article` for **all** matched rows, *then* sorts and limits.
**Why slow:** A 10k-article project requesting 50 rows still scans 10k bodies.
**Fix:** Persist a `has_body: bool` flag on write, or reorder to `$sort` → `$limit` → compute `hasBody` only on the page (relies on `{project_id, created_at}` index).

**B. `_default_plans()` rebuilt inside a per-document loop**
**Where:** `storage.py:1205-1213`
**Now:** The default-plans dict is reconstructed for every plan document in the cursor.
**Fix:** Hoist `defaults = _default_plans()` above the loop.

### 1.5 🟠 Missing indexes for live query shapes

**Where:** `database.py:191-229` (index definitions) vs queries at `storage.py:4273-4276` (`site_maps`), `4523` (`content_monitors`)
**Now:** No index on `site_maps.project_id` or the monitor due-query shape; `research_cache` has no TTL on stale entries.
**Why slow:** Collection scans grow linearly as these collections fill.
**Fix:** Add `db.site_maps.create_index([("project_id",1),("post_modified_at",-1)])`, a monitor index matching the due filter, and a TTL index on `research_cache`.

---

## 2. OOP CONCEPTS

### 2.1 🔴 The domain is modeled as untyped dicts, not objects

**Evidence:** `storage.py` = ~4,760 lines, **100 top-level functions**, **120 `dict[str, Any]` annotations**, and **32** references to ad-hoc normalizers (`_mongo_doc_to_article`, `_normalize_article_dict`, `_apply_article_updates_dict`).
**Now:** An "Article", "Project", "User", "ScheduledJob" only exist as loose dicts. Access is `a.get("article")`, `proj.get("platform")`, etc., scattered across routes and services. Pydantic schemas exist (`backend/app/schemas/`) but are used **only at the HTTP boundary**, not internally.
**Why this hurts performance & correctness:**
- No single place owns "which fields are heavy" → the same body/image gets loaded on paths that don't need it (drives §1.2).
- Normalization logic is duplicated and re-run (`_mongo_doc_to_article` on every read, even for counts).
- `.get(key)` with silent defaults hides missing-field bugs and forces defensive re-reads.
**Fix (incremental):** Introduce lightweight domain dataclasses or Pydantic models (e.g. `ArticleRow`, `ArticleListItem`, `ProjectRef`) that explicitly separate **heavy** (`body`, `image_url`) from **light** fields. Construct them once from a projected Mongo doc. This makes "don't load the body here" a type-level guarantee, not a convention.

### 2.2 🟠 `storage.py` is a god-module mixing concerns

**Where:** `storage.py` (whole file), `app.py` (5,352-line legacy Flask monolith still present at repo root).
**Now:** Articles, projects, users, subscriptions, plans, scheduled jobs, research cache, site maps, JSON-fallback, Mongo access, and normalization all live in one flat namespace.
**Why it hurts:** No cohesion → hard to add a projection or cache without touching unrelated code; encourages copy-paste query variants (e.g. the multiple near-identical listing pipelines at `3045`, `3201`, `3348`).
**Fix:** Split into repository classes by aggregate: `ArticleRepository`, `ProjectRepository`, `UserRepository`, `ScheduledJobRepository`, each owning its collection handle, projections, and (de)serialization. This also gives a natural home for per-request caching (§3.3) and batch methods (§1.1/§1.3).

### 2.3 🟠 Service "classes" exist but stateless helpers dominate

**Where:** Only ~18 service files define a class (e.g. `openai_client.py:15 OpenAIClient`, `wordpress_client.py`, `shopify_client.py`); the rest are free functions taking the `st` storage module as a parameter (`plan_gatekeeper._plan_for_user(st, user)`, `cluster_internal_link_service`, etc.).
**Now:** Cross-cutting state (the resolved project, the current user, the plan) is re-fetched in each helper instead of being held by an object for the request's lifetime.
**Why it hurts:** Encourages the redundant reads in §3.3 (user fetched 2–3×, project fetched 2–3× per request).
**Fix:** Introduce a per-request `RequestContext` (or use FastAPI dependency caching) that lazily loads and memoizes `user`, `subscription`, `project`, `plan` once and passes that object to gatekeepers/services instead of re-querying.

### 2.4 🟢 Client objects are recreated instead of pooled/reused

**Where:** `openai_client.py:15-21`, `wordpress_client.py`, `shopify_client.py`
**Now:** HTTP clients are instantiated per operation in several call sites rather than reused, so connection pools and auth headers are rebuilt.
**Fix:** Reuse a single configured client per (process / project) where the SDK is thread/async-safe; keep `httpx.AsyncClient` connection pools warm.

---

## 3. STRUCTURING OF API CALLS

### 3.1 🔴 Independent awaits run sequentially (should be `asyncio.gather`)

| Where | Now | Fix |
|-------|-----|-----|
| `articles.py:1248-1262` (`editor-shell`) | article shell, then job overlay, serially | `asyncio.gather(...)` (already done at `1326-1335` for detail) |
| `scheduled_jobs.py:284-295` (board) | jobs+heal, then stubs, serially | gather jobs + stubs, then merge |
| `shopify_sync.py:196-250` | shop, products, 2× collections, blogs, pages — **6 serial REST calls** | gather the independent resources; keep only blogs→articles dependency |
| `dashboard/page.tsx:288-301` (frontend) | `await me()` then `await listProjects()` | `Promise.all([me, listProjects])` |
| `articles/[id]/page.tsx` editor | shell then body in some paths | `Promise.all` (already done in main load at `684-687`) |

**Why slow:** Wall-clock latency is the *sum* of round-trips instead of the *max*. The Shopify case (`shopify_sync.py:196-250`) is the worst — seconds of avoidable serial RTTs.

### 3.2 🔴 N+1 calls in loops (DB and external APIs)

| Where | Pattern | Fix |
|-------|---------|-----|
| `wordpress.py:960-977` (bulk sync) | per linked article: storage get → WP REST GET → storage update, **fully serial** (500 articles ≈ 1,500 serial I/O ops) | batch storage reads by `$in`; `asyncio.gather` WP calls with a bounded semaphore (5–10) |
| `scheduled_jobs.py:469-488` (retry-all) | per failed job: update → 20k article scan → reload **all** jobs | reuse the row already in hand; batch article fetch once; drop the reload |
| `scheduled_jobs.py:762-771`, `717-725` (clear/cancel) | one `await delete_scheduled_job` per job | bulk `delete_many` by project / `article_id` |
| `articles.py:2021-2037` (bulk_schedule) | `_persist_schedule_row` per article (each may re-query jobs) | one bulk upsert API for scheduled jobs |
| `cluster_internal_link_service.py:196-208` | one `get_article` per sibling slot | batch-load all sibling IDs in one `$in` query |
| `wordpress.py:79-90` (REST path probe) | tries candidate paths serially on failure | parallel probe (`asyncio.wait(FIRST_COMPLETED)`) and cache the winning path per project |
| frontend `listArticlesAll` (`api.ts:1963-1975`) | up to **50 sequential** `page=N&per_page=500` requests for Overview/Tools/export | use `workspaceOverview()` aggregate, or true server-side pagination |

### 3.3 🔴 The same record is fetched multiple times per request

**Where:** `core/deps.py:58-60` + `middleware/plan_limits.py:79-90` + `services/plan_gatekeeper.py:92-97`
**Now:** On every mutating `/api/*` request:
1. `PlanLimitsMiddleware` loads `get_user_by_id` **and** `get_subscription_by_user_id` (and maybe `ensure_subscription_for_user`).
2. `get_current_user` loads `get_user_by_id` **again**.
3. `require_plan_action` loads the subscription **again** and re-runs `load_plans()`.

That's **3–5 blocking DB reads of full documents** before the handler body executes. The same shape repeats inside handlers: PATCH article fetches before *and* after the update (`articles.py:1462,1499`); WP sync re-fetches the article a third time just to build the response (`articles.py:2873-2874`); `update_scheduled_job` fetches the project twice and reloads all jobs three times (`scheduled_jobs.py:307-442`); Shopify `sync_catalog` re-runs the entire `status()` handler (`project_shopify.py:770`).
**Why slow:** Multiplies Mongo round-trips and thread-pool hops on the busiest endpoints; `load_plans()` re-queries + re-merges defaults each call.
**Fix:**
- Attach `user`/`subscription` to `request.state` in the middleware and have `get_current_user` / gatekeeper read from there (request-scoped memoization).
- Add a module-level TTL cache (≈60s) for `load_plans()` invalidated on `upsert_plan`.
- In handlers, apply `updates` to the in-memory row and skip the re-fetch; return the merged dict.

### 3.4 🔴 Blocking (sync) PyMongo on the event loop

**Where:** `core/deps.py:58-60` (`get_current_user`), `core/project_lookup.py:27-45` (`require_project_access`), `middleware/plan_limits.py:79-90`, several Shopify routes (`project_shopify.py:315-318,462,741-747`), `scheduled_jobs.py:78` (heal write).
**Now:** These run synchronous `storage`/`call_storage` calls directly inside `async def` without `run_sync`.
**Why slow:** Blocks the event loop, so unrelated concurrent requests stall during Mongo I/O — thread-pool benefits are bypassed.
**Fix:** Wrap every sync storage call in `await run_sync(...)`, or migrate these hot reads to the async Motor path (`mongo_listings_async.py` already proves the pattern for listings).

### 3.5 🟠 Heavy payloads where a light projection/endpoint exists

| Where | Now | Fix |
|-------|-----|-----|
| `articles.py:531`, `1314-1345` | `GET /articles/{id}` returns full `article` body even though `editor-shell` / `body` / `featured-image` split endpoints exist | trim body from detail or deprecate; frontend uses split endpoints |
| `articles.py:1398-1407` | `generation-status` **fallback** loads the full article just to compute `has_body` | always use the dedicated status projection; never fall back to full doc |
| `workspace.py:45-54,117` | feed embeds `image_url` for up to 1,500 articles (can be huge data URLs) | return `has_featured_image: bool`; lazy-load images |
| frontend `articles/[id]/page.tsx:1362,1411` | post-publish refetch uses full `getArticle` | merge publish response / use shell |
| frontend save (`page.tsx:955-962`, `api.ts:2192-2200`) | every PATCH uploads the whole markdown and downloads full `ArticleDetail` | split metadata vs body PATCH; return shell-only |

### 3.6 🟠 Filtered listings re-scan up to 20k rows twice

**Where:** `articles.py:731-751`, `774-795` (`_count_listing_with_derived_status`, `_listing_page_with_derived_status`)
**Now:** When a `status=` filter is applied, both count and page paginate through up to `_LISTING_MAX_SCAN` (20,000) rows in 200-row batches, merging job overlays per batch — worst case ≈100 round-trips, doubled.
**Fix:** Persist the derived listing status on the article document and `$match` on it directly in Mongo.

### 3.7 🟠 Polling design (frontend) — frequency, backoff, visibility

| Mechanism | Where | Interval | Backoff | Pauses when tab hidden |
|-----------|-------|----------|---------|------------------------|
| Article generation | `api.ts:788-844, 2379-2393` | 4s→12s | ✅ | ❌ |
| Topic cluster | `api.ts:2840-2855` | 2s fixed | ❌ | ❌ |
| Scheduled board | `page.tsx:1763-1774` | 6s fixed | ❌ | ❌ |
| Post-now settle | `page.tsx:3096-3120` | 2s–120s steps, up to 12× | partial | ❌ |
| Subscription | `SubscriptionProvider.tsx:67-68` | 5 min | — | ✅ (good) |
| Dashboard projects | `dashboard/page.tsx:391` | 90s | — | ✅ (good) |

**Why slow:** Background tabs keep hammering the API for up to 10 minutes; each generation poll *also* re-runs `require_project_access` + a storage read on the backend (§3.3/§3.4). The scheduled board poll re-runs heal-on-GET (`scheduled_jobs.py:38-78`) every 6s, doing write amplification on a read path.
**Fix:** Add a `document.hidden` guard + backoff to all poll loops; prefer the existing SSE channel (`pipelineStream.ts:73-117`) or a minimal single-job status endpoint over full-board refetches; move scheduler heal into the background worker, not the GET handler.

### 3.8 🟠 Frontend over-fetch / duplicate / cache issues

- **Duplicate GSC analytics** for the same 28-day window fetched in 3 places: `page.tsx:1369-1372`, `1290-1293`, `2508-2521` → fetch once per session, share via state/context.
- **Project shell refetches on every tab switch** because `tab` is in the effect deps: `page.tsx:1171-1218` → load shell once per `projectId`.
- **Shopify catalog double-fetch** due to `shopifyBlogId` in deps: `articles/[id]/page.tsx:444-470` → use a ref, drop from deps.
- **Duplicate `listArticleTitles`** after research import: `page.tsx:4538-4539` → reuse the result of `reloadArticleTitles()`.
- **Coarse cache invalidation**: generate/regen clears shell+body+image+detail together, and settings PATCH evicts unrelated WP type/category caches: `api.ts:1183-1198`, `1192-1198` → invalidate only the mutated slice.
- **`prefetchArticle` serial** shell→body on hover: `api.ts:1951-1957` → `Promise.all`.
- **`listProjects` has no inflight/TTL dedup** while dashboard refetches on focus+visibility+90s with cache-bust: `api.ts:1529`, `dashboard/page.tsx:373-393` → add inflight+TTL dedup, debounce focus refresh.

### 3.9 🟢 Main-thread work competing with network handling (frontend)

- **TipTap → Turndown → marked on every keystroke**: `ArticleRichEditor.tsx:92-96`, `articleMarkdown.ts:6-10` → debounce conversion 300–500ms or keep HTML internally and convert on blur/save.
- **XLSX parse/write synchronous**: `page.tsx:2805-2814` → move to a Web Worker or server-side export.
- **Full `ArticleDetail` (with body) JSON-serialized into sessionStorage**: `articleEditorCache.ts:22-25` → cache shell only; body in IndexedDB or not at all.

---

## 4. Cross-cutting root causes (fix these and many symptoms disappear)

1. **No typed domain model / heavy-vs-light field separation** (§2.1) → causes most over-fetching (§1.2, §3.5).
2. **No request-scoped memoization** (§2.3) → causes triple user/subscription/project reads (§3.3).
3. **Sync PyMongo on async routes** (§3.4) → caps concurrency regardless of query tuning.
4. **No batch storage methods** (`get_by_ids`, bulk `$set`, bulk delete) → forces N+1 (§1.1, §3.2).
5. **REST polling instead of SSE/events** for long-running work (§3.7) → steady avoidable load.

---

## 5. Prioritized roadmap

### Phase 1 — High ROI, low risk (do first)
1. **Request-scoped cache for user/subscription/plan** — eliminate 3–5 reads/request. (`deps.py`, `plan_limits.py`, `plan_gatekeeper.py`; §3.3)
2. **TTL cache for `load_plans()`.** (`storage.py:1205`, `plan_gatekeeper.py`; §1.4B/§3.3)
3. **Wrap all sync storage in `run_sync`** on hot async paths. (`deps.py`, `project_lookup.py`, `wordpress.py`, `project_shopify.py`; §3.4)
4. **Add `load_articles_by_ids_for_project` + use it** in `bulk_action`, `_find_article_for_job`. (§1.1A/B, §3.2)
5. **`asyncio.gather` the obvious serial pairs** (`editor-shell`, board, Shopify sync). (§3.1)
6. **Frontend: visibility guard + backoff on all poll loops.** (§3.7)
7. **Frontend: replace `listArticlesAll` on Overview/Tools with the aggregate endpoint.** (§3.2, §3.8)

### Phase 2 — Structural (medium effort)
8. **Projections everywhere**: split `get_project_by_id`, `get_user_by_id`, `load_projects`, scheduler queries into light vs full. (§1.2)
9. **Route all partial writes through `$set`**; batch `bulk_update_articles`. (§1.3)
10. **Persist `has_body` and derived listing status** to kill the pre-`$limit` body scans and double 20k scans. (§1.4A, §3.6)
11. **Bulk scheduled-job APIs** (upsert/delete) + move heal to the worker. (§3.2, §3.7)
12. **Add missing indexes / TTLs** (`site_maps`, monitors, `research_cache`). (§1.5)

### Phase 3 — Architecture (higher effort, compounding payoff)
13. **Introduce typed repositories + domain models** with explicit heavy/light fields. (§2.1, §2.2)
14. **`RequestContext` object** carrying memoized user/project/plan. (§2.3)
15. **Expand Motor async coverage** for hot reads; reduce thread-pool dependence. (§3.4)
16. **SSE/event-driven status** for generation, scheduled posting, and topic clusters; retire REST polling. (§3.7)
17. **Decompose `storage.py` / retire the legacy `app.py` monolith.** (§2.2)

---

## 6. Quick reference — top 20 findings by impact

| # | Lens | Location | Issue | Fix |
|---|------|----------|-------|-----|
| 1 | API | `deps.py`+`plan_limits.py`+`plan_gatekeeper.py` | 3–5× user/sub/plan reads per request | request-scoped cache |
| 2 | API | `wordpress.py:960-977` | serial WP sync per article (1,500 ops) | batch + bounded `gather` |
| 3 | Data | `storage.py:2506` | `load_articles()` full collection | scoped queries + projection |
| 4 | Data | `storage.py:3045-3060` | `hasBody` computed before `$limit` | persist flag / reorder |
| 5 | API | `articles.py:731-795` | double 20k scan for filtered list | persist derived status |
| 6 | API | `deps.py:60`,`project_lookup.py:27` | blocking PyMongo on event loop | `run_sync` / Motor |
| 7 | Data | `storage.py:4167-4177` | N+1 in `bulk_update_articles` | `$in` read + bulk `$set` |
| 8 | API | `shopify_sync.py:196-250` | 6 serial Shopify REST calls | `asyncio.gather` |
| 9 | Data | `articles.py:1028-1037` | 20k load to validate IDs | `$in` / `get_by_ids` |
| 10 | Data | `storage.py:2323,2490` | project/full-doc no projection | per-call projections |
| 11 | OOP | `storage.py` (whole) | dicts everywhere, no heavy/light typing | domain models/repos |
| 12 | API | `scheduled_jobs.py:469-488` | retry-all triple work per job | reuse row, batch fetch |
| 13 | FE | `api.ts:1963-1975` | 50-page waterfall for Overview | aggregate endpoint |
| 14 | FE | poll loops (`api.ts`,`page.tsx`) | no visibility guard / backoff | `document.hidden` + backoff |
| 15 | API | `articles.py:531,1314` | full body on detail GET | split endpoints |
| 16 | Data | `storage.py:1515` | full user doc + regex fallback every auth | projection + canonical ids |
| 17 | API | `scheduled_jobs.py:307-442` | 3× job reload + 2× project fetch | reuse in-memory row |
| 18 | FE | `page.tsx:1171-1218` | shell refetch on every tab switch | drop `tab` from deps |
| 19 | Data | `database.py` | missing `site_maps`/monitor indexes | add indexes + TTL |
| 20 | FE | `page.tsx:1290-1372` | GSC analytics fetched 3× | fetch once, share |

---

*End of audit. Pair with `RIVISO_BACKEND_ARCHITECTURE_BLUEPRINT.md` for system context. No source files were modified to produce this document.*
