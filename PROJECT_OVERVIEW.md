# PROJECT_OVERVIEW — Riviso

**Riviso** (formerly "Auto Articles") is a SaaS platform that generates SEO-optimised blog articles with OpenAI, humanizes them with a proprietary linguistics engine, and publishes them to WordPress or Shopify on a schedule. It is built as a FastAPI backend + Next.js frontend, backed by MongoDB and Redis, with a legacy Flask monolith being phased out.

---

## Table of Contents

1. [High-Level Architecture](#high-level-architecture)
2. [Process Topology](#process-topology)
3. [Authentication & Security](#authentication--security)
4. [Configuration & Env Vars](#configuration--env-vars)
5. [Data Layer](#data-layer)
6. [API Layer](#api-layer)
7. [Middleware Stack](#middleware-stack)
8. [Domain Models](#domain-models)
9. [Generation Pipeline](#generation-pipeline)
10. [Humanization Engine (RIVISO)](#humanization-engine-riviso)
11. [Scheduling & Publishing](#scheduling--publishing)
12. [Plan & Subscription System](#plan--subscription-system)
13. [External Integrations](#external-integrations)
14. [Frontend](#frontend)
15. [Infrastructure](#infrastructure)
16. [Dev vs Production Differences](#dev-vs-production-differences)

---

## High-Level Architecture

```
Browser (Next.js)
    │ REST + SSE
    ▼
Nginx (reverse proxy)
    ├─ /api/* ──► FastAPI (uvicorn)
    │                 │
    │                 ├── MongoDB (primary data store)
    │                 ├── Redis  (generation queue + SSE pub/sub)
    │                 └── Legacy storage.py (root monolith, reached via bridge)
    └─ /*     ──► Next.js (frontend:3000)

Background processes (separate containers / dynos):
    worker    ── drains Redis generation queue
    scheduler ── polls scheduled_jobs, dispatches publish + subscription resets
```

**Two codebases in one repo:**

| Layer | Path | Status |
|-------|------|--------|
| New FastAPI backend | `backend/` | Active — receives all new features |
| Legacy Flask monolith | `app.py` + `storage.py` | Still running locally; disabled in production (S0.5) |

The FastAPI backend calls all data access functions from the legacy `storage.py` via a bridge layer (`backend/app/services/storage_db.py` → `backend/app/legacy/storage.py` → root `storage.py`). This means the new backend has zero independent MongoDB logic of its own; it delegates every read/write to the ~198 KB flat-function legacy module.

---

## Process Topology

Three independent OS-level process types, controlled by environment flags:

| Process | Env flags | What it runs |
|---------|-----------|-------------|
| `web` | `ENABLE_SCHEDULER=0 ENABLE_GENERATION_WORKER=0` | `uvicorn app.main:app` — pure HTTP API |
| `worker` | `ENABLE_GENERATION_WORKER=1 ENABLE_SCHEDULER=0` | `python -m app.run_background` — drains Redis queue |
| `scheduler` | `ENABLE_SCHEDULER=1 ENABLE_GENERATION_WORKER=0` | `python -m app.run_background` — scheduler loop + subscription daily reset |

In development (single process), all three are combined unless you set the flags. In production (docker-compose), they are separate containers.

**Why separate processes?** A long OpenAI call (up to 3 min) or a WordPress publish must not block HTTP request handling. The Redis queue decouples request acceptance from generation execution.

### Scheduler loop

Runs every 10 seconds (`poll_seconds=10.0`). On each tick:
1. Loads all `scheduled` / `ready_to_post` / `failed` jobs due before `now`.
2. Atomically claims each job (`claim_scheduled_job_for_posting`, CAS on state field in Mongo).
3. Runs prep (generate content/image if missing) then publishes to WordPress.
4. Runs `_heal_premature_generating_jobs` — resets jobs stuck in `content_generating` state for far-future publish times.
5. Runs `_dispatch_due_prep_jobs` — enqueues content prep for jobs within the lead window (default 45 min).
6. Runs `subscription_daily_reset_loop` — resets daily article quotas at midnight UTC.

---

## Authentication & Security

### Token model

- JWT (HS256 via `python-jose`), signed with `SECRET_KEY`
- **Access token**: 1 hour TTL, delivered as `aa_access` httpOnly cookie
- **Refresh token**: 30-day TTL, delivered as `aa_refresh` httpOnly cookie
- Bearer header (`Authorization: Bearer <token>`) also accepted for API clients

### Auth flow

1. `POST /api/auth/login` → validates credentials, issues access + refresh tokens as cookies
2. `POST /api/auth/register` → creates user, sends verification email, returns `requires_verification: true`
3. `POST /api/auth/verify-email` → marks user verified, optionally issues tokens
4. Refresh: `POST /api/auth/refresh` → issues new access token from valid refresh token

### CSRF protection

Implemented as a pure-ASGI middleware (`CsrfProtectMiddleware`):
- Only triggers on `POST/PUT/PATCH/DELETE` to `/api/*`
- Exempts `/auth/`, `/oauth/`, `/webhook` paths
- Only applies to **cookie-authenticated** requests **without** a Bearer token
- Requires `X-Requested-With` header; rejects with 403 if missing

### Security headers

Applied via `SecurityHeadersASGIMiddleware` on every response:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'`
- `Permissions-Policy: geolocation=(), microphone=(), camera=()`

### SSRF guard

`backend/app/services/url_guard.py` — all outbound HTTP calls (WordPress, Shopify, reference image downloads) go through `assert_public_http_url()` which blocks private IP ranges, loopback, and cloud metadata endpoints (169.254.169.254, etc.).

### Production boot checks (`core/production.py`)

- Refuses to start if `SECRET_KEY` is placeholder/empty/< 32 chars
- Refuses to start if `MONGODB_TLS_INSECURE` or `OAUTHLIB_INSECURE_TRANSPORT` are set
- Warns if `COOKIE_SECURE=false` or `OPENAI_API_KEY` is missing

---

## Configuration & Env Vars

Loaded via pydantic-settings (`Settings` class in `backend/app/core/config.py`). Resolution order: process env → `backend/.env` → repo-root `.env`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SECRET_KEY` | `dev-insecure-change-me` | JWT signing secret |
| `ENVIRONMENT` | `development` | Controls docs, startup checks; `production` enables guards |
| `MONGODB_URI` | — | Mongo connection string (read by root `database.py`) |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis for queue + SSE |
| `POSTGRES_DSN` | `postgresql+asyncpg://...` | Declared; not used (Mongo is primary) |
| `OPENAI_API_KEY` | — | Required for generation |
| `OPENAI_TEXT_MODEL` | `gpt-4.1-mini` | Chat completions model |
| `OPENAI_IMAGE_MODEL` | `gpt-image-1` | DALL-E / GPT-image model |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | For cluster validation cosine similarity |
| `GOOGLE_OAUTH_CLIENT_ID/SECRET` | — | Google Search Console OAuth |
| `GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON` | — | Google Indexing API service account (raw JSON or base64) |
| `SHOPIFY_API_KEY/SECRET` | — | Shopify OAuth app credentials |
| `CORS_ORIGINS` | `riviso.com,riviso.cloud,...` | Comma-separated allowed origins |
| `MAX_CONCURRENT_GENERATIONS` | `3` | Semaphore on generation queue |
| `SCHEDULE_PREP_LEAD_MINUTES` | `45` | Prep window before publish time |
| `GENERATION_BANNED_PHRASES` | — | Extra banned terms for AI generation |
| `METRICS_ENABLED` | `1` | Enable `/metrics` Prometheus endpoint |
| `METRICS_TOKEN` | — | Bearer token to protect `/metrics` |
| `SENTRY_DSN` | — | Sentry error tracking |
| `COOKIE_SECURE` | `false` | Must be `true` in production (HTTPS) |

---

## Data Layer

### Primary store: MongoDB

All data lives in MongoDB. Access follows this call chain:

```
API route / service
  → asyncio.to_thread(call_storage, fn, ...)     [storage_db.py — adds retry + sys.path setup]
  → legacy/storage.py shim
  → root storage.py (flat functions, ~198 KB)
  → pymongo MongoClient                           [database.py]
```

For dashboard/listing hot paths, Motor (async MongoDB) is used directly via `mongo_listings_async.py`, bypassing the synchronous bridge.

**Key collections** (inferred from storage functions):
- `users` — user accounts, subscription, usage counters
- `projects` — project config, platform credentials, prompt templates
- `articles` — article content, metadata, WP/Shopify publish state
- `scheduled_jobs` — scheduling queue with state machine
- `subscriptions` — trial dates, usage snapshots
- `plans` — plan definitions (`load_plans()`)
- `topic_clusters` — cluster definitions and slot mappings

### Redis

| Key pattern | Purpose |
|-------------|---------|
| `aa:generation:queue` | RPUSH/BLPOP Redis list — generation job queue |
| `aa:generation:dedup:<id>` | Dedup TTL key (6h) — prevents double-enqueueing the same article |
| `channel:article:<article_id>` | Pub/sub channel per article for SSE pipeline events |

Redis unavailability degrades gracefully: queue falls back to an in-process `asyncio.Queue`, SSE events are dropped.

### Typed repository layer (in progress)

`backend/app/repositories/` provides typed facades:

| Class | Wraps |
|-------|-------|
| `ArticleRepository` | `get_article`, `get_article_editor_shell`, `get_article_body_text`, `get_article_image_url`, ... |
| `ProjectRepository` | (not yet shown but follows same pattern) |

Domain models: `ArticleRef` (light — id/title/status/has_body, no body bytes) and `ProjectRef` (light — id/owner/name/platform, no credentials).

---

## API Layer

All routes are mounted under `/api` via `backend/app/api/router.py`.

### Route inventory

| Router | Key endpoints |
|--------|--------------|
| `auth` | `POST /auth/login`, `/auth/register`, `/auth/verify-email`, `/auth/refresh`, `/auth/logout` |
| `articles` | `GET/POST /projects/{id}/articles`, `GET/DELETE /{article_id}`, `POST /{id}/generate`, `GET /{id}/stream` (SSE), `POST /{id}/regenerate-image`, `POST /{id}/schedule`, `POST /bulk-upload`, `POST /bulk-schedule` |
| `projects` | CRUD `/projects`, `GET /projects/{id}/settings` |
| `scheduled_jobs` | `GET/POST /projects/{id}/scheduled-jobs`, `POST /{job_id}/post-now`, `DELETE /{job_id}` |
| `wordpress` | `POST /projects/{id}/wordpress/connect`, `/verify`, `/publish`, `/sync` |
| `shopify` | OAuth install/callback at workspace level |
| `project_shopify` | Per-project Shopify connect, blog/product sync |
| `gsc` | Google Search Console OAuth + site list |
| `project_gsc` | Per-project GSC query, URL inspection |
| `project_topic_cluster` | Cluster CRUD + fan-out article generation |
| `project_cluster_validation` | Validate proposed cluster topics for overlap |
| `project_site_map` | Fetch + parse site sitemap |
| `research` | Research ideas, custom scrape jobs |
| `user_subscription` | `GET /subscription/status`, plan features/usage |
| `workspace` | Workspace-level project overview |
| `prompts` / `image_prompts` | Writing + image prompt template CRUD |
| `context_links` | Context link rule CRUD |
| `profile` | User profile read/write |
| `admin` | Admin-only: user list, deactivate, impersonate |
| `health` | `GET /api/health` — liveness + storage mode + GSC/Shopify config fingerprints |

### Live streaming (SSE)

`GET /projects/{id}/articles/{article_id}/stream` — returns `text/event-stream`. The route subscribes to `channel:article:{article_id}` on Redis pub/sub and forwards JSON stage messages to the browser. The frontend (`pipelineStream.ts`) maps stage keys to human-readable labels and a progress bar.

---

## Middleware Stack

Middleware is added in innermost-first order (last `add_middleware` call = outermost):

```
RequestIdMiddleware          ← outermost: stamps X-Request-ID on every request/log
MetricsMiddleware            ← Prometheus request counter + latency histogram
EnsureCorsASGIMiddleware     ← fallback ACAO header for uncaught exception paths
CORSMiddleware               ← main CORS (FastAPI built-in)
GZipMiddleware               ← compress responses ≥ 1000 bytes
CsrfProtectMiddleware        ← CSRF guard (cookie-auth without Bearer)
SecurityHeadersASGIMiddleware← X-Content-Type-Options, X-Frame-Options, CSP, etc.
SlowAPIMiddleware            ← rate limiting (SlowAPI / limits library)
PlanLimitsMiddleware         ← trial expiry gate on mutating requests (innermost)
```

`PlanLimitsMiddleware` caches the user + subscription objects onto the request state so that subsequent FastAPI dependencies (`Depends(get_current_user)`, `require_plan_action`) re-use them without additional Mongo reads (`core/request_cache.py`).

---

## Domain Models

### Article status lifecycle

```
pending → draft → scheduled → published
                ↘ (cancel)  ↗ (post now)
```

- `pending` — created, not yet generated
- `draft` — content generated, not published
- `scheduled` — has a `wp_scheduled_at` datetime and a `scheduled_job`
- `published` — `wp_post_id` set, `posted_at` set

### Article fields (key subset)

| Field | Purpose |
|-------|---------|
| `title`, `keywords[]`, `focus_keyphrase` | SEO inputs |
| `article` | Markdown body (stored as-is, converted to HTML on publish) |
| `meta_title`, `meta_description` | Yoast-compatible SEO meta |
| `image_url` | Data URL or HTTPS URL for featured image |
| `integrity_ai_percentage` | Last AI-detection audit score (0–100) |
| `integrity_flagged_paragraphs` | Per-paragraph audit flags |
| `wp_post_id`, `wp_link`, `wp_rest_base` | WordPress publish state |
| `shopify_article_id`, `shopify_blog_id`, `shopify_link` | Shopify publish state |
| `gsc_status`, `gsc_inspection_url` | Search Console state |
| `monitor_status` | Rank monitor: `fresh` / `stale` / `unknown` |
| `topic_cluster_id`, `topic_slot_id`, `topic_role` | Cluster membership |

### Project fields (key subset)

| Field | Purpose |
|-------|---------|
| `platform` | `wordpress` or `shopify` |
| `brand_identity` | Legacy free-text brand description (auto-derived from structured fields) |
| `brand_voice`, `brand_tones[]`, `brand_rules` | Structured brand identity |
| `niche_identifier` | Legacy free-text niche description |
| `niche_topic`, `audience[]`, `target_countries[]`, `target_cities[]` | Structured niche |
| `target_countries_all`, `target_cities_all` | "Global" flags — avoids enumerating 250 ISO codes |
| `prompts[]`, `image_prompts[]` | Per-project writing and image prompt templates |
| `default_prompt_id`, `default_image_prompt_id` | Active defaults |
| `wp_site_url`, `wp_username`, `wp_app_password`, `wp_verified_status` | WordPress credentials |
| `shopify_shop`, `shopify_verified_status`, `shopify_sync_status` | Shopify connection |
| `context_links[]` | Internal link rules applied on publish |

### Scheduled job state machine

```
scheduled
  → content_generating  (prep started)
  → image_generating    (image-only prep)
  → ready_to_post       (prep complete, waiting for run_at)
  → posting             (claimed by scheduler/post-now, publish in progress)
  → posted              (WordPress accepted the request)
  → failed              (error stored in last_error; retryable if < 5 attempts)
  → cancelled
```

Atomic claim via `claim_scheduled_job_for_posting` — MongoDB findAndModify on the state field prevents two workers from double-posting.

---

## Generation Pipeline

Full sequence for `execute_article_generation()`:

```
1. Resolve prompts
   └─ writing_prompt_id → project.prompts[]  (or project default_prompt_id)
   └─ image_prompt_id   → project.image_prompts[]  (or project default_image_prompt_id)

2. Validate prompts
   └─ assert_writing_prompt_allowed()  — banned phrases, safety
   └─ assert_image_prompt_allowed()    — banned phrases

3. Resolve platform extras
   └─ WordPress: resolve_cluster_mapped_pages() → internal link targets
   └─ Shopify:   product context from mapped_products[]

4. Estimate token budget
   └─ estimate_bundle_tokens()  → plan.max_llm_tokens_per_month check

5. Consume quotas (pre-generation)
   └─ check_llm_token_budget()
   └─ consume_article_usage()  (day + month limits)

6. SSE: publish "internal_links" stage (if WP with mapped pages)

7. SSE: publish "openai_dispatch" stage

8. Generate bundle (OpenAI)
   └─ generate_article_bundle_safe()
      ├─ Chat completion (gpt-4.1-mini): article body (Markdown) + meta_title + meta_description
      └─ Image generation (gpt-image-1): DALL-E or img2img with Shopify product reference

9. SSE: publish "integrity_verify" stage

10. Humanization pass
    └─ execute_structural_humanization()  — up to 6 passes targeting < 6% AI-detection score
       ├─ split_markdown_paragraphs()
       ├─ per-paragraph: scrub_ai_markers() → polish_paragraph_natural() → run_grammar_pipeline()
       └─ join_markdown_paragraphs()

11. AI detection audit
    └─ AIDetectionAuditor.audit_markdown()  → integrity_ai_percentage + flagged_paragraphs

12. Persist to MongoDB
    └─ patch_article_fields(article_id, updates)

13. SSE: publish "complete" stage

14. Return JSON payload
```

### Generation job kinds (Redis queue)

| Kind | Triggered by |
|------|-------------|
| `ARTICLE_GENERATE` | `POST .../generate` route |
| `IMAGE_REGENERATE` | `POST .../regenerate-image` route |
| `SCHEDULED_PREP` | Scheduler lead-window dispatch |
| `SCHEDULED_POST_NOW` | `POST .../post-now` route |
| `CLUSTER_GENERATE_ALL` | Topic cluster fan-out |
| `TOPIC_CLUSTER_PLAN` | Cluster plan generation |
| `RESEARCH_IDEAS` | Custom research job |

Concurrency is bounded by `asyncio.Semaphore(MAX_CONCURRENT_GENERATIONS)`. A dedup key (`aa:generation:dedup:<article_id>`, TTL 6h) prevents the same article from being enqueued twice.

---

## Humanization Engine (RIVISO)

A proprietary multi-pass linguistics pipeline to reduce AI-detection scores. Target: < 6% AI percentage.

| Module | Role |
|--------|------|
| `riviso_linguistics.py` | Markdown paragraph splitter/joiner, `AIDetectionAuditor` (pattern-matching), `humanize_markdown_blocks()` |
| `riviso_paraphrase_engine.py` | `scrub_ai_markers()` — removes high-signal AI phrases and sentence templates |
| `riviso_grammar_engine.py` | `run_grammar_pipeline()` — grammar normalisation, comma splicing, rhythm variation |
| `riviso_human_profile.py` | `polish_paragraph_natural()` — adds natural human-writing traits (asides, hedging, varied sentence length) |
| `integrity_engine.py` | Orchestrator: `execute_structural_humanization()` — full-document or flagged-paragraph mode, up to `max_passes=6` |

The `AIDetectionAuditor` is also used standalone after publishing to record `integrity_ai_percentage` and `integrity_flagged_paragraphs` on the article document.

Protected terms (title, focus keyphrase, keywords) are excluded from paraphrase to preserve SEO signals.

---

## Scheduling & Publishing

### WordPress publish flow

```
scheduler_loop  (or post-now route)
  → prepare_article_for_scheduled_job()   — generate content/image if missing
  → publish_article_to_wordpress()
       ├─ Markdown → HTML (markdown library, extensions: extra, sane_lists, smarty)
       ├─ apply_context_links_html()       — inject project context links
       ├─ WordpressClient.create_post()    — POST wp/v2/posts (or pages)
       ├─ resolve_featured_media_id()      — upload image to wp/v2/media, get ID
       ├─ wp.ensure_tag_ids()             — create tags from keywords if missing
       └─ POST with Yoast meta fields
  → update_article_fields(wp_post_id, wp_link, status)
  → maybe_request_url_inspection()        — GSC URL Inspection API
  → ping_sitemap()                        — notify sitemap URL
```

**Post Now vs Scheduler**: both use `execute_scheduled_job_post_now()`. The scheduler polls `run_at <= now`; Post Now is triggered manually. Both paths use the same atomic claim mechanism to prevent duplicate posts.

**Double-post guard**: before publishing, the scheduler checks `art.get("wp_post_id")`. If already set, it marks the job `posted` and skips the WP API call.

---

## Plan & Subscription System

### Plan keys

Plans are stored in MongoDB (`load_plans()`). Default plan key is `beta`. Admins bypass all limits.

### Plan actions (`PlanAction` enum)

| Action | Quota type |
|--------|-----------|
| `CREATE_PROJECT` | `max_projects` per user |
| `GENERATE_CONTENT` | `max_articles_per_day` + `max_articles_per_month` |
| `REGENERATE_IMAGE` | `max_article_image_regenerations` per article |
| `HUMANIZE` | no quota (feature flag) |
| `SCHEDULE_POST` | `max_scheduled_per_month` |
| `BULK_UPLOAD` | `allow_bulk_upload` flag |
| `BULK_EXPORT` | `allow_export` flag + `max_export_per_month` |
| `CLUSTER_PLAN` | `max_cluster_plans_per_month` |
| `CUSTOM_RESEARCH` | `max_custom_research_per_month` |

Additionally: `max_llm_tokens_per_month` — tracked via `check_llm_token_budget()` / `consume_llm_generation_tokens()`.

### Trial expiry

`PlanLimitsMiddleware` reads the subscription on every mutating request and caches it on `request.state`. `is_trial_expired()` compares `subscription.trial_end_date` (UTC ISO) to now. Expired users get `403 { error: "trial_expired" }`.

### Subscription status response shape

```json
{
  "status": "active|trial_expired|no_trial",
  "plan_key": "beta",
  "plan_name": "Beta",
  "trial_end_date": "2026-06-30T00:00:00",
  "remaining_days": 28,
  "usage": { "articlesGeneratedToday": 2, "articlesGeneratedThisMonth": 15, ... },
  "features": { "projectsMax": 5, "articlesPerMonth": 50, "allowBulkUpload": true, ... }
}
```

---

## External Integrations

### OpenAI

- **Client**: `OpenAIClient` (`services/openai_client.py`) — raw httpx, no SDK
- **Chat completions** (`chat_json`): `POST /v1/chat/completions`, temperature 0.6, JSON response mode, 180s read timeout
- **Image generation** (`generate_image_url`): `POST /v1/images/generations` (text-to-image) with fallback to `POST /v1/images/edits` (img2img) when a Shopify product reference image URL is provided
- **Embeddings** (`embed_batch`): `POST /v1/embeddings` — used by cluster validation for cosine-similarity overlap detection (text-embedding-3-small, 1536 dims)

### WordPress

- **Auth**: Application Passwords (stored per-project)
- **Client** (`wordpress_client.py`): httpx, custom User-Agent `Riviso/1.0 WordPress-Connector` (WAF bypass for Hostinger)
- **Plugin discovery**: pings `riviso/v1` and `auto-articles/v1` namespaces
- **Publish**: `POST wp/v2/posts` or `wp/v2/pages` depending on `post_type`
- **Media**: `POST wp/v2/media` with multipart binary upload
- **Tags**: `GET /wp/v2/tags?search=`, `POST /wp/v2/tags` if missing
- **Yoast fields**: written via `meta._yoast_wpseo_title`, `_yoast_wpseo_metadesc`, `_yoast_wpseo_focuskw`
- **Sync**: `wordpress_sync.py` pulls all published posts back into the article collection

### Shopify

- **Auth**: Custom app OAuth (`shopify_oauth.py`) — HMAC validation, JWT session tokens
- **Scopes**: `read_products`, `write_products`, `read_content`, `write_content`, `read_blogs`, `write_blogs`
- **Client** (`shopify_client.py`): REST Admin API (not GraphQL)
- **Product context**: `shopify_product_context.py` fetches product details injected into the generation prompt
- **Image**: `shopify_article_image.py` — uploads featured image to Shopify CDN
- **Catalog persistence**: `shopify_catalog_persistence.py` — caches product catalog in MongoDB
- **Sync**: `shopify_sync.py` — pulls blog articles back

### Google Search Console

- **Auth**: OAuth2 PKCE flow (`gsc.py`) — stores refresh token per user
- **APIs**: `webmasters/v3/sites`, `/sitemaps`, `searchconsole/v1/urlInspection/index:inspect`
- **Post-publish**: `gsc_actions.maybe_request_url_inspection()` — automatically requests URL inspection when an article is published live

### Google Indexing API

- **Auth**: Service account JWT (JSON or base64 env var)
- **API**: `indexing.googleapis.com/v3/urlNotifications:publish`
- **Use case**: Notifies Google of new/updated URLs after publish

### Email

- Dispatch via `email_dispatch.py`: invokes `npx tsx backend/email/sendCli.ts <kind> <to> <payload>` as a subprocess
- Nodemailer-based; CLI script isolates Node dependency from the Python runtime

### Research scraping

- `research_scraper.py`: httpx + BeautifulSoup, rotating User-Agent pool
- URL guard applied before each fetch

---

## Frontend

**Framework**: Next.js 14+ with App Router (TypeScript).

### Pages

| Route | Component |
|-------|-----------|
| `/` | Landing page |
| `/login` | `AuthPage` — login + register tabs |
| `/dashboard` | Workspace overview, project cards, stat carousel |
| `/projects/[projectId]` | Project hub — Articles tab, Settings, Clusters, Schedule |
| `/projects/[projectId]/articles/[articleId]` | Article editor with live generation pipeline |
| `/projects/[projectId]/connect-shopify` | Shopify OAuth connect flow |

### State & data fetching

- No React Query or SWR; raw `fetch` via typed wrappers in `lib/api.ts`
- `SubscriptionProvider` (context) — loads subscription status once, provides to all components
- `GlobalLoadingProvider` — app-wide loading state for navigations
- Request-scoped cache: the `api.ts` client sends `X-Requested-With: XMLHttpRequest` on every mutation to satisfy the CSRF middleware

### Pipeline streaming

`pipelineStream.ts` opens a fetch-based SSE connection to `/api/.../stream`. Maps stage keys to progress percentages:

```
init → queued → connected → worker_start → internal_links → openai_dispatch
    → integrity_verify → humanization → featured_image → publish_dispatch → complete
```

### Key lib files

| File | Role |
|------|------|
| `api.ts` | All typed API calls; `getApiBaseUrl()` reads `NEXT_PUBLIC_API_URL` |
| `articleMarkdown.ts` | Markdown ↔ editor format conversion |
| `articleEditorWordpress.ts` | WP-specific editor transforms (Gutenberg block handling) |
| `overviewReadiness.ts` | Determines when a project has enough config to generate |
| `shopifyProductMapping.ts` | Maps Shopify products to article generation context |
| `pipelineStream.ts` | SSE client; `PIPELINE_STAGE_LABELS`, `STAGE_PROGRESS_ORDER` |

---

## Infrastructure

### Docker Compose services

| Service | Image / Dockerfile | Notes |
|---------|-------------------|-------|
| `postgres` | `postgres:16` | Declared; unused (Mongo is primary) |
| `redis` | `redis:7` | AOF persistence; healthcheck via `redis-cli ping` |
| `backend` | `backend/Dockerfile` | 768 MB mem limit; `ENABLE_SCHEDULER=0 ENABLE_GENERATION_WORKER=0` |
| `worker` | same Dockerfile | 1 GB mem limit; `ENABLE_GENERATION_WORKER=1` |
| `scheduler` | same Dockerfile | `ENABLE_SCHEDULER=1` |
| `frontend` | `frontend/Dockerfile` | Next.js |
| `nginx` | Nginx | Reverse proxy; HTTPS redirect; HSTS; gzip |

### Nginx (`nginx/conf.d/default.conf`)

- `upstream backend_upstream` → `backend:8000`
- `upstream frontend_upstream` → `frontend:3000`
- HSTS: `max-age=63072000; includeSubDomains; preload` (only on HTTPS via `$http_x_forwarded_proto`)
- HTTP → HTTPS redirect when `X-Forwarded-Proto: http` (TLS terminates at Cloudflare/edge LB)
- gzip for JSON, JS, SVG, XML

### Observability

| Tool | Integration |
|------|-------------|
| Sentry | `core/observability.py` — `init_sentry("api")` no-op if `SENTRY_DSN` unset |
| Prometheus | `core/metrics.py` — `MetricsMiddleware` tracks request count + latency; `/metrics` endpoint |
| Structured logs | `core/logging.py` — JSON-structured, uvicorn access logs |
| Request IDs | `middleware/request_id.py` — stamps `X-Request-ID` on all requests/responses |

### CI / Security

- `.github/workflows/ci.yml` — automated tests
- `.github/workflows/security.yml` — security scanning
- `.gitleaks.toml` — secret leak detection
- `dependabot.yml` — automated dependency updates

---

## Dev vs Production Differences

| Behaviour | Development | Production |
|-----------|-------------|-----------|
| OpenAPI docs (`/docs`, `/redoc`) | Enabled | Disabled (`expose_docs = not is_production`) |
| Localhost in CORS | Allowed | Blocked |
| JWT weak key | Allowed (warning) | Refused (RuntimeError at boot) |
| MongoDB TLS verify | Optional | Enforced (MONGODB_TLS_INSECURE blocks boot) |
| Cookie Secure flag | Optional | Warning if false |
| Scheduler | In-process (combined) | Dedicated `scheduler` process |
| Generation worker | In-process (combined) | Dedicated `worker` process |
| Storage fallback | JSON file fallback if Mongo unavailable | Logs warning, continues with JSON fallback |

---

*Generated from source analysis on 2026-06-02.*
