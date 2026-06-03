# REPO_MAP

Auto Articles / **Riviso** — AI-driven article generation and publishing platform.

---

## Process Topology

Three independent process types (Procfile + docker-compose):

| Process | Command | Role |
|---------|---------|------|
| `web` | `uvicorn app.main:app` | FastAPI HTTP API |
| `worker` | `python -m app.run_background` (ENABLE_GENERATION_WORKER=1) | Drains Redis generation queue |
| `scheduler` | `python -m app.run_background` (ENABLE_SCHEDULER=1) | Scheduled publishing + subscription resets |

Infrastructure: **MongoDB** (primary datastore) · **Redis** (queue + SSE pub/sub) · **PostgreSQL** (declared in docker-compose but unused — Alembic migration raises RuntimeError; data is in Mongo) · **Nginx** (reverse proxy: `/api` → backend:8000, all else → frontend:3000).

---

## Entry Points

| File | Type | Notes |
|------|------|-------|
| [backend/app/main.py](backend/app/main.py) | FastAPI ASGI app | Middleware stack, lifespan hooks, mounts `api_router` at `/api` |
| [backend/app/run_background.py](backend/app/run_background.py) | Background runner | Starts worker or scheduler depending on env flags |
| [app.py](app.py) | **Legacy Flask monolith** (~212 KB) | Still present; disabled in production (S0.5) |
| [storage.py](storage.py) | **Legacy storage monolith** (~198 KB) | Root-level flat-function Mongo access; still called by all backend code via bridge |
| [database.py](database.py) | MongoDB client | pymongo connection, index setup |
| [wsgi.py](wsgi.py) | WSGI shim | Wraps Flask app for gunicorn |

---

## API Layer

### Router aggregation
[backend/app/api/router.py](backend/app/api/router.py) — imports and includes every sub-router under `/api`.

### Route modules (`backend/app/api/routes/`)

| Module | Responsibility |
|--------|----------------|
| [auth.py](backend/app/api/routes/auth.py) | Login, register, verify-email, refresh, logout |
| [articles.py](backend/app/api/routes/articles.py) | CRUD, generate, stream pipeline events (SSE) |
| [projects.py](backend/app/api/routes/projects.py) | Project CRUD, settings |
| [scheduled_jobs.py](backend/app/api/routes/scheduled_jobs.py) | Schedule / cancel article publishing jobs |
| [research.py](backend/app/api/routes/research.py) | Research ideas and scraping jobs |
| [wordpress.py](backend/app/api/routes/wordpress.py) | WP connection, publish, page mapping |
| [shopify.py](backend/app/api/routes/shopify.py) | Shopify OAuth install/callback (workspace-level) |
| [project_shopify.py](backend/app/api/routes/project_shopify.py) | Per-project Shopify connect + settings |
| [gsc.py](backend/app/api/routes/gsc.py) | Google Search Console OAuth + data |
| [project_gsc.py](backend/app/api/routes/project_gsc.py) | Per-project GSC queries |
| [project_topic_cluster.py](backend/app/api/routes/project_topic_cluster.py) | Topic cluster generation |
| [project_cluster_validation.py](backend/app/api/routes/project_cluster_validation.py) | Cluster URL validation |
| [project_site_map.py](backend/app/api/routes/project_site_map.py) | Sitemap fetch + parse |
| [profile.py](backend/app/api/routes/profile.py) | User profile read/write |
| [user_subscription.py](backend/app/api/routes/user_subscription.py) | Subscription status, plan queries |
| [workspace.py](backend/app/api/routes/workspace.py) | Workspace-level views |
| [prompts.py](backend/app/api/routes/prompts.py) | Writing prompt templates |
| [image_prompts.py](backend/app/api/routes/image_prompts.py) | Image prompt templates |
| [context_links.py](backend/app/api/routes/context_links.py) | Internal link context rules |
| [admin.py](backend/app/api/routes/admin.py) | Admin-only user/project management |
| [health.py](backend/app/api/routes/health.py) | `GET /api/health` liveness + readiness |

### Middleware (applied in main.py)

| Middleware | Source |
|-----------|--------|
| CORS | FastAPI CORSMiddleware |
| GZip | Starlette GZipMiddleware |
| Rate limiting | SlowAPIMiddleware ([core/ratelimit.py](backend/app/core/ratelimit.py)) |
| Request ID | [middleware/request_id.py](backend/app/middleware/request_id.py) |
| Plan / trial gate | [middleware/plan_limits.py](backend/app/middleware/plan_limits.py) |
| Metrics | [core/metrics.py](backend/app/core/metrics.py) (Prometheus) |

---

## Core Modules (`backend/app/core/`)

| File | Purpose |
|------|---------|
| [config.py](backend/app/core/config.py) | `Settings` — pydantic-settings, loads `.env`; all secrets, URLs, feature flags |
| [security.py](backend/app/core/security.py) | JWT create/decode (JOSE HS256), access + refresh tokens |
| [deps.py](backend/app/core/deps.py) | FastAPI `Depends` — resolves current user from Bearer or `aa_access` cookie |
| [ratelimit.py](backend/app/core/ratelimit.py) | SlowAPI limiter instance |
| [production.py](backend/app/core/production.py) | Startup checks (env vars, connectivity) |
| [logging.py](backend/app/core/logging.py) | Structured logging config |
| [metrics.py](backend/app/core/metrics.py) | Prometheus counters/histograms, MetricsMiddleware |
| [observability.py](backend/app/core/observability.py) | Sentry SDK init |
| [request_cache.py](backend/app/core/request_cache.py) | Per-request user/subscription cache (avoids re-fetching Mongo per middleware hop) |
| [request_context.py](backend/app/core/request_context.py) | Request-scoped context var |
| [ids.py](backend/app/core/ids.py) | ID generation helpers |
| [article_duplicates.py](backend/app/core/article_duplicates.py) | Duplicate article detection |
| [project_lookup.py](backend/app/core/project_lookup.py) | Project fetch helper |

---

## Database Layer

### Primary: MongoDB

| File | Role |
|------|------|
| [database.py](database.py) | `MongoClient` init, database handle, index setup |
| [storage.py](storage.py) | **Monolithic flat-function CRUD** (~198 KB) — authoritative data access layer |
| [backend/app/legacy/storage.py](backend/app/legacy/storage.py) | Shim: resolves and re-exports root `storage.py` module |
| [backend/app/services/storage_db.py](backend/app/services/storage_db.py) | Resilient bridge — adds `sys.path` resolution + transient-error detection |
| [backend/app/services/mongo_listings_async.py](backend/app/services/mongo_listings_async.py) | Motor async queries for dashboard/workspace hot paths |
| [backend/app/repositories/base.py](backend/app/repositories/base.py) | `_Repo` base class — typed facade over storage functions |
| [backend/app/repositories/models.py](backend/app/repositories/models.py) | `ArticleRef`, `ProjectRef` — light/heavy domain model split |

### Secondary: Redis

Used for:
- **Generation queue** ([services/generation_queue.py](backend/app/services/generation_queue.py)) — `asyncio.Queue` with Redis fallback; dedup by article ID
- **Pipeline SSE streaming** ([services/pipeline_streamer.py](backend/app/services/pipeline_streamer.py)) — pub/sub channel per article for live progress events

---

## Services (`backend/app/services/`)

### Article Generation Pipeline

```
Route POST .../generate
  → generation_queue.py        enqueue job
  → generation_worker.py       dequeues, calls execute_article_generation()
  → article_pipeline.py        orchestrates: internal links → OpenAI → integrity → humanize → image → publish
  → article_generation.py      OpenAI bundle: title + body + image prompt + featured image
  → openai_client.py           raw OpenAI HTTP client (chat completions + DALL-E)
  → integrity_engine.py        AI-detection audit + structural humanization
  → human_writing_guardrail.py post-humanization guardrail checks
  → platform_generation.py     platform-specific extras (Shopify product context injection)
  → pipeline_streamer.py       publishes Redis SSE events to frontend
```

| File | Role |
|------|------|
| [generation_queue.py](backend/app/services/generation_queue.py) | Redis-backed job queue with in-process fallback; concurrency slot |
| [generation_worker.py](backend/app/services/generation_worker.py) | Async worker loop; drains queue with bounded concurrency |
| [article_pipeline.py](backend/app/services/article_pipeline.py) | Shared generation + image-regen orchestrator |
| [article_generation.py](backend/app/services/article_generation.py) | OpenAI prompt bundle assembly and execution |
| [openai_client.py](backend/app/services/openai_client.py) | HTTP client wrapping OpenAI (chat + DALL-E) |
| [pipeline_streamer.py](backend/app/services/pipeline_streamer.py) | Redis pub/sub → SSE stage events |
| [integrity_engine.py](backend/app/services/integrity_engine.py) | AI-detection audit; humanization execution |
| [human_writing_guardrail.py](backend/app/services/human_writing_guardrail.py) | Post-humanization quality checks |
| [title_humanization_guardrail.py](backend/app/services/title_humanization_guardrail.py) | Title-specific humanization checks |
| [seo_guardrails.py](backend/app/services/seo_guardrails.py) | SEO rules enforcement |
| [platform_generation.py](backend/app/services/platform_generation.py) | Platform-specific generation extras |

### Humanization / Linguistics Engine

| File | Role |
|------|------|
| [riviso_linguistics.py](backend/app/services/riviso_linguistics.py) | Core linguistics transforms |
| [riviso_grammar_engine.py](backend/app/services/riviso_grammar_engine.py) | Grammar-level rewriting |
| [riviso_paraphrase_engine.py](backend/app/services/riviso_paraphrase_engine.py) | Paraphrase passes |
| [riviso_human_profile.py](backend/app/services/riviso_human_profile.py) | Human writing profile modeling |

### Scheduling & Publishing

| File | Role |
|------|------|
| [scheduler.py](backend/app/services/scheduler.py) | Async loop: checks due scheduled jobs, dispatches publish |
| [schedule_timing.py](backend/app/services/schedule_timing.py) | Next-run time calculation |
| [wordpress_publish.py](backend/app/services/wordpress_publish.py) | WP publish flow |
| [wordpress_sync.py](backend/app/services/wordpress_sync.py) | WP content sync |
| [shopify_sync.py](backend/app/services/shopify_sync.py) | Shopify article sync |
| [sitemap_ping.py](backend/app/services/sitemap_ping.py) | Ping sitemaps post-publish |

### Plan / Subscription

| File | Role |
|------|------|
| [plan_gatekeeper.py](backend/app/services/plan_gatekeeper.py) | Checks plan action allowance; trial expiry |
| [subscription_daily_reset.py](backend/app/services/subscription_daily_reset.py) | Resets daily quotas (runs in scheduler process) |
| [generation_blocklist.py](backend/app/services/generation_blocklist.py) | Blocks generation for flagged accounts |

### Research

| File | Role |
|------|------|
| [research_scraper.py](backend/app/services/research_scraper.py) | httpx + BeautifulSoup web scraping |
| [research_ideas.py](backend/app/services/research_ideas.py) | Research idea generation |
| [research_job_runner.py](backend/app/services/research_job_runner.py) | Async research job execution |

### Topic Clusters

| File | Role |
|------|------|
| [topic_cluster_service.py](backend/app/services/topic_cluster_service.py) | Cluster CRUD + orchestration |
| [topic_cluster_llm.py](backend/app/services/topic_cluster_llm.py) | LLM-powered cluster generation |
| [cluster_validation.py](backend/app/services/cluster_validation.py) | URL / content validation |
| [cluster_internal_link_service.py](backend/app/services/cluster_internal_link_service.py) | Cluster-aware internal linking |
| [internal_link_service.py](backend/app/services/internal_link_service.py) | General internal link injection |
| [context_links.py](backend/app/services/context_links.py) | Context link rules |

---

## External Integrations

| Integration | Files | Notes |
|-------------|-------|-------|
| **OpenAI** | [services/openai_client.py](backend/app/services/openai_client.py) | Chat completions (gpt-4o) + DALL-E 3 image generation |
| **WordPress** | [services/wordpress_client.py](backend/app/services/wordpress_client.py), [wordpress_content_pipeline.py](backend/app/services/wordpress_content_pipeline.py), [wordpress_publish.py](backend/app/services/wordpress_publish.py), [wordpress_sync.py](backend/app/services/wordpress_sync.py), [wordpress_plugin_packager.py](backend/app/services/wordpress_plugin_packager.py) | WP REST API; custom plugin packager |
| **Shopify** | [services/shopify_oauth.py](backend/app/services/shopify_oauth.py), [shopify_client.py](backend/app/services/shopify_client.py), [shopify_sync.py](backend/app/services/shopify_sync.py), [shopify_product_pipeline.py](backend/app/services/shopify_product_pipeline.py), [shopify_article_image.py](backend/app/services/shopify_article_image.py) | Custom app OAuth; Storefront API; product context injection |
| **Google Search Console** | [services/gsc.py](backend/app/services/gsc.py), [google_console_service.py](backend/app/services/google_console_service.py), [gsc_actions.py](backend/app/services/gsc_actions.py) | OAuth2; site/sitemap/inspect APIs |
| **Google Indexing API** | [services/google_indexing.py](backend/app/services/google_indexing.py) | Service account JWT; URL publish notifications |
| **Email** | [services/email_dispatch.py](backend/app/services/email_dispatch.py) | Nodemailer via `npx tsx backend/email/sendCli.ts` |
| **SSRF guard** | [services/url_guard.py](backend/app/services/url_guard.py) | Validates all outbound URLs against private-range blocklist |

---

## Frontend (`frontend/`)

Next.js App Router (TypeScript).

### Pages (`src/app/`)

| Route | File |
|-------|------|
| `/` | [page.tsx](frontend/src/app/page.tsx) — landing |
| `/login` | [login/page.tsx](frontend/src/app/login/page.tsx) |
| `/dashboard` | [dashboard/page.tsx](frontend/src/app/dashboard/page.tsx) |
| `/projects/[projectId]` | [projects/[projectId]/page.tsx](frontend/src/app/projects/[projectId]/page.tsx) |
| `/projects/[projectId]/articles/[articleId]` | article editor |
| `/projects/[projectId]/connect-shopify` | Shopify OAuth connect flow |

### Key Libraries (`src/lib/`)

| File | Role |
|------|------|
| [api.ts](frontend/src/lib/api.ts) | Typed fetch wrappers for every backend endpoint |
| [pipelineStream.ts](frontend/src/lib/pipelineStream.ts) | SSE client for live generation pipeline events |
| [articleEditorWordpress.ts](frontend/src/lib/articleEditorWordpress.ts) | WP-specific editor helpers |
| [articleMarkdown.ts](frontend/src/lib/articleMarkdown.ts) | Markdown ↔ editor conversion |
| [articlesOverview.ts](frontend/src/lib/articlesOverview.ts) | Dashboard overview aggregations |
| [overviewReadiness.ts](frontend/src/lib/overviewReadiness.ts) | Project readiness gate logic |
| [shopifyProductMapping.ts](frontend/src/lib/shopifyProductMapping.ts) | Shopify product ↔ article mapping |

### Key Components (`src/components/`)

| Component | Role |
|-----------|------|
| [ArticleRichEditor.tsx](frontend/src/components/ArticleRichEditor.tsx) | Main article editor |
| [ArticleIntegrityBody.tsx](frontend/src/components/ArticleIntegrityBody.tsx) | AI integrity audit display |
| [BulkScheduleModal.tsx](frontend/src/components/bulkSchedule/BulkScheduleModal.tsx) | Bulk schedule UI |
| [ShopifyConnectPanel.tsx](frontend/src/components/shopify/ShopifyConnectPanel.tsx) | Shopify OAuth connect UI |
| [SubscriptionProvider.tsx](frontend/src/components/subscription/SubscriptionProvider.tsx) | Subscription context |
| [TrialCountdownBanner.tsx](frontend/src/components/subscription/TrialCountdownBanner.tsx) | Trial expiry banner |

---

## Infrastructure & Config

| File/Dir | Purpose |
|----------|---------|
| [docker-compose.yml](docker-compose.yml) | postgres · redis · backend · worker · scheduler · frontend · nginx |
| [nginx/conf.d/default.conf](nginx/conf.d/default.conf) | Reverse proxy; HTTPS redirect; HSTS; gzip |
| [Procfile](Procfile) | Heroku/foreman process types (web/worker/scheduler) |
| [.github/workflows/](./github/workflows/) | CI (ci.yml) + security scan (security.yml) |
| [.gitleaks.toml](.gitleaks.toml) | Secret scanning config |
| [alembic/](alembic/) | SQL migration scaffold — not used (Mongo primary) |
| [backend/requirements.txt](backend/requirements.txt) | FastAPI · pydantic · pymongo · motor · redis · httpx · jose · slowapi · sentry-sdk |

---

## Schemas (`backend/app/schemas/`)

Pydantic request/response models for each domain: `articles`, `auth`, `projects`, `prompts`, `health`, `wordpress`, `shopify`, `scheduled_jobs`, `subscription`, `workspace`, `admin`, `profile`, `research`, `project_settings`.

---

## Tests (`backend/tests/`)

| File | Covers |
|------|--------|
| test_integration_security_paths.py | Auth + security integration |
| test_plan_gatekeeper.py | Subscription / trial gate |
| test_shopify_article_image.py | Shopify image pipeline |
| test_shopify_product_pipeline.py | Shopify product pipeline |
| test_wordpress_client.py | WP client |
| test_wordpress_content_pipeline.py | WP content pipeline |
| test_human_writing_guardrail.py | Humanization guardrail |
| test_title_humanization_guardrail.py | Title humanization |
| test_email_verification.py | Email verification flow |
