# ARCHITECTURE.md — Riviso System Design

## High-Level Overview

```
Browser (app.riviso.com)
    │
    ├── /api/* → Next.js rewrite → api.riviso.cloud (FastAPI)
    └── /* → Next.js pages
                              │
                    ┌─────────┴──────────┐
                    │   FastAPI (API)     │   port 8000
                    │   ENABLE_SCHEDULER=0│
                    │   ENABLE_WORKER=0   │
                    └─────────┬──────────┘
                              │ Redis queue
                    ┌─────────┴──────────────────────┐
                    │                                 │
              ┌─────┴──────┐               ┌──────────┴──────┐
              │   Worker    │               │   Scheduler      │
              │ (consume    │               │ (APScheduler +  │
              │  queue)     │               │  daily reset)   │
              └─────┬──────┘               └────────┬────────┘
                    │                               │
              ┌─────┴───────────────────────────────┴────┐
              │            MongoDB Atlas                  │
              │   collections: users, projects, articles  │
              │   scheduled_jobs, subscriptions, plans    │
              └───────────────────────────────────────────┘
```

---

## Frontend Architecture

### Framework
- **Next.js 16** (App Router) with **React 19** and **TypeScript 5**
- Deployed as a standalone container (`frontend/Dockerfile`) in Docker Compose
- In production: served on port 3000 behind Nginx reverse proxy

### Routing
App Router pages under `frontend/src/app/`:
```
/                           → landing / redirect to dashboard
/login                      → AuthPage (login + register + email verify)
/dashboard                  → WorkspaceProjectOverview
/projects/[projectId]       → project tabs (Articles / Prompts / Settings / Research / Schedule / Cluster)
/projects/[projectId]/articles/[articleId]  → ArticleRichEditor
/projects/[projectId]/connect-shopify       → Shopify OAuth callback
/reset-password             → password reset flow
/terms, /privacy-policy     → legal pages
```

### Key Components
| Component | Purpose |
|-----------|---------|
| `AuthPage.tsx` | Unified auth form (login / register / verify email / forgot password) |
| `ArticleRichEditor.tsx` | Tiptap-based rich editor with generation + humanize controls |
| `ArticleIntegrityBody.tsx` | Before/after humanization diff viewer |
| `BulkScheduleModal.tsx` | Bulk schedule dialog for topic clusters |
| `TutorialStepperModal.tsx` | Onboarding stepper for new projects |
| `SubscriptionProvider.tsx` | Trial countdown context provider |
| `ShopifyConnectPanel.tsx` | Shopify OAuth connection flow |
| `WordPressPageMapPicker.tsx` | WordPress page → article URL mapper |

### State Management
- **No global state library** — React `useState` + `useEffect` per page
- Article editor uses `articleEditorCache.ts` (localStorage) for draft persistence
- Projects list cached in `projectsCache.ts` (in-memory within session)

### API Client
All backend calls go through `frontend/src/lib/api.ts`:
- `getApiBaseUrl()` — returns empty string on `RIVISO_APP_HOSTS` domains (uses same-origin proxy), full URL elsewhere
- `LONG_API_TIMEOUT_MS = 600_000` — used for generation, research, bulk operations
- `pollWithBackoff()` — exponential backoff poller for generation status; throws on `generation_error`
- All mutating requests include `X-Requested-With: XMLHttpRequest` (CSRF)

### Build
- `next build` produces standalone output
- `BACKEND_URL` env var controls rewrite target (falls back to `http://127.0.0.1:8000`)
- Sentry wrapped via `withSentryConfig` when `@sentry/nextjs` and `SENTRY_DSN` are present

---

## Backend Architecture

### Framework
- **FastAPI 0.116** — ASGI, async-first
- Entry point: `backend/app/main.py` → `create_app()` → `app`
- Uvicorn ASGI server

### Middleware Stack (outermost → innermost)
1. `RequestIdMiddleware` — attaches `X-Request-ID` correlation id to every request
2. `MetricsMiddleware` — Prometheus request latency + count
3. `EnsureCorsASGIMiddleware` — CORS fallback for uncaught errors that bypass Starlette CORS
4. `CORSMiddleware` — standard CORS with per-request origin validation
5. `GZipMiddleware` — gzip responses > 1KB
6. `CsrfProtectMiddleware` — rejects cookie-auth mutations without `X-Requested-With`
7. `SecurityHeadersASGIMiddleware` — CSP, X-Frame-Options, Referrer-Policy, etc.
8. `SlowAPIMiddleware` — rate limiting (300/min per user or IP)
9. `PlanLimitsMiddleware` — trial expiry gate; preloads user + subscription into request cache

### Route Modules (`backend/app/api/routes/`)
| Module | Prefix | Purpose |
|--------|--------|---------|
| `auth.py` | `/auth` | Login, register, verify email, refresh, reset password |
| `articles.py` | `/projects/{id}/articles` | CRUD, generate, humanize, integrity, bulk |
| `wordpress.py` | `/projects/{id}/settings` | Project settings GET/PATCH; WP verify, publish |
| `projects.py` | `/projects` | Project CRUD |
| `prompts.py` | `/projects/{id}/prompts` | Writing prompts CRUD |
| `image_prompts.py` | `/projects/{id}/image-prompts` | Image prompts CRUD |
| `scheduled_jobs.py` | `/projects/{id}/schedule` | Schedule create/list/delete |
| `research.py` | `/projects/{id}/research` | Custom research ideas (synchronous) |
| `project_topic_cluster.py` | `/projects/{id}/cluster` | Cluster planning + generation |
| `gsc.py` | `/gsc` | Google Search Console OAuth |
| `project_gsc.py` | `/projects/{id}/gsc` | GSC URL inspection + indexing per article |
| `shopify.py` | `/shopify` | Shopify global OAuth |
| `project_shopify.py` | `/projects/{id}/shopify` | Shopify per-project OAuth + sync |
| `admin.py` | `/admin` | Admin-only user/plan management |
| `profile.py` | `/user/profile` | User profile read/update |
| `user_subscription.py` | `/user/subscription-status` | Trial status check |
| `workspace.py` | `/workspace` | Cross-project dashboard feed |
| `health.py` | `/health` | Liveness + readiness |
| `context_links.py` | `/projects/{id}/context-links` | Context link config |
| `project_site_map.py` | `/projects/{id}/sitemap` | WordPress site-map pages |
| `project_cluster_validation.py` | `/projects/{id}/cluster/validate` | Cluster conflict detection |

### Service Layer (`backend/app/services/`)
Services own business logic and have no FastAPI imports:

**Generation pipeline:**
- `article_generation.py` — builds OpenAI prompts, calls GPT-4.1-mini, parses JSON response
- `article_pipeline.py` — orchestrates: quota check → generate → humanize → persist → SSE stream
- `integrity_engine.py` — multi-pass humanization via `execute_structural_humanization()`
- `content_optimization.py` — injects SEO/AEO/GEO/E-E-A-T system-prompt blocks
- `generation_queue.py` — Redis-backed job queue with dedup + in-process fallback
- `generation_worker.py` — async worker consuming the queue
- `pipeline_streamer.py` — publishes SSE pipeline stage events

**Humanization sub-services:**
- `riviso_linguistics.py` — AI detection scoring, block-level humanization
- `riviso_human_profile.py` — natural paragraph polishing
- `riviso_paraphrase_engine.py` — AI marker scrubbing
- `riviso_grammar_engine.py` — grammar pipeline
- `human_writing_guardrail.py` — system prompt anchors + banned phrase lists
- `generation_blocklist.py` — filters AI-generated labels from headings

**Publishing:**
- `wordpress_client.py` — WP REST API client (posts, media upload)
- `wordpress_publish.py` — full publish flow (media + post + GSC ping)
- `shopify_client.py` — Shopify Admin API client
- `shopify_sync.py` — Shopify article sync
- `sitemap_ping.py` — ping sitemap after publish

**Research:**
- `research_ideas.py` — LLM-driven research with web scraping
- `research_scraper.py` — web content scraper
- `gsc.py` / `gsc_actions.py` — GSC query data

**Scheduling:**
- `scheduler.py` — APScheduler loop: prep scheduled articles, handle publish jobs
- `schedule_timing.py` — user-timezone-aware publish time computation

**Platform integrations:**
- `shopify_oauth.py`, `shopify_project_oauth.py` — OAuth flows
- `google_console_service.py`, `google_indexing.py` — Google APIs
- `topic_cluster_service.py`, `topic_cluster_llm.py` — topic cluster LLM

**Core utilities:**
- `storage_db.py` — wraps repo-root `database.py` with retry logic
- `mongo_listings_async.py` — Motor async reads for hot paths (dashboard, workspace)
- `plan_gatekeeper.py` — plan limit enforcement
- `email_dispatch.py`, `email_smtp.py` — transactional email
- `url_guard.py` — SSRF protection

### Repository Layer (`backend/app/repositories/`)
Thin typed facades over raw `storage.py` functions:
- `ArticleRepository` — light listings vs heavy document reads
- `ProjectRepository` — full vs generation/access projections
- `UserRepository` — user reads/writes
- `ScheduledJobRepository` — scheduled job operations

### Schemas (`backend/app/schemas/`)
Pydantic v2 models for request/response validation. Never use raw dicts in route signatures.

---

## Database Architecture

### Primary: MongoDB Atlas
Collections (all in `auto_articles` database):
```
users           — email, role, subscription_type, account_status, timezone
projects        — owner_user_id, name, platform, brand/niche prompts, WP/Shopify credentials
                  content_optimization_profile, humanization_settings
articles        — project_id, title, keywords, focus_keyphrase, article (body), image_url
                  status, wp_post_id, wp_link, generation_error, listing_status
scheduled_jobs  — project_id, article_id, state, scheduled_at (UTC ISO), user_timezone
subscriptions   — user_id, trial_end_date, plan_key
plans           — key, max_projects, max_articles, allow_scheduling, etc.
```

### Connection
- `database.py` (repo root) — pymongo client with pool config (max 50, min 2, idle 120s)
- Motor async client for listing hot paths
- `run_with_retry()` — 2-attempt retry with pool reset on transient errors
- `MONGODB_URI`, `MONGODB_DB_NAME` env vars required

### Legacy fallback
- `storage.py` (repo root) — flat dict functions over raw MongoDB collections
- `FORCE_JSON_STORAGE=1` — switches to JSON file fallback (CI only)
- `AUTO_IMPORT_JSON=1` — imports `data/projects.json` + `data/articles.json` on startup

### PostgreSQL (dormant)
- Schema defined in `backend/app/` SQLAlchemy models
- Alembic migrations configured
- `postgres` service in docker-compose.yml
- Currently not used as primary store; placeholder for future migration

---

## Authentication Flow

```
1. POST /api/auth/login
   → validate email + bcrypt password
   → create JWT access token (1h TTL) + refresh token (30d TTL)
   → set cookies: aa_access (httpOnly), aa_refresh (httpOnly)
   → return TokenPair JSON

2. Browser → next request
   → Next.js rewrite: /api/* → api.riviso.cloud/api/*
   → Cookie forwarded (same-origin from browser perspective)
   → deps.get_current_user() reads aa_access cookie OR Authorization: Bearer
   → JWT decode → user_id → MongoDB lookup
   → user cached in request-scope dict (avoid repeated DB reads)

3. Token refresh
   → POST /api/auth/refresh with aa_refresh cookie
   → new access token issued, cookie overwritten

4. CSRF protection
   → all cookie-auth mutations require X-Requested-With: XMLHttpRequest
   → Bearer token requests are exempt (attacker can't read/set that header cross-origin)

5. Plan limits check (PlanLimitsMiddleware)
   → runs before route handler on all mutating /api/* requests
   → loads user + subscription into request cache
   → returns 403 {"error": "trial_expired"} if trial has ended
```

Cookie names: `aa_access` (access JWT), `aa_refresh` (refresh JWT)
JWT algorithm: HS256
Secret: `SECRET_KEY` env var

---

## External Integrations

| Service | Purpose | Config |
|---------|---------|--------|
| OpenAI | Article generation (GPT-4.1-mini), image generation (gpt-image-1), embeddings (text-embedding-3-small) | `OPENAI_API_KEY` |
| MongoDB Atlas | Primary database | `MONGODB_URI` |
| Google Search Console | URL inspection, indexing API | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON` |
| Shopify | Blog publishing, product context | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` |
| WordPress | Article publishing via REST API | Per-project: `wp_site_url`, `wp_username`, `wp_app_password` |
| Redis | Generation queue, rate limiter shared storage | `REDIS_URL` |
| SMTP | Transactional email (verify, reset) | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |
| Sentry | Error tracking | `SENTRY_DSN` (optional) |
| Prometheus | Metrics scraping | `METRICS_ENABLED`, `METRICS_TOKEN` |

---

## Deployment Architecture

### Production VPS (Hostinger)
- Single VPS node
- Docker Compose manages 4 service containers
- Nginx reverse proxy (port 80 → backend:8000, frontend:3000)
- Redis runs as 5th service in docker-compose (local, not Atlas)
- TLS termination at Cloudflare / host edge (nginx receives X-Forwarded-Proto)

### Docker Services
```yaml
backend:   FastAPI API  (ENABLE_SCHEDULER=0, ENABLE_GENERATION_WORKER=0)  768MB / 1 CPU
worker:    Queue worker (ENABLE_GENERATION_WORKER=1, ENABLE_SCHEDULER=0)  1024MB / 1 CPU
scheduler: APScheduler  (ENABLE_SCHEDULER=1, ENABLE_GENERATION_WORKER=0)  512MB / 0.5 CPU
redis:     Redis 7       (appendonly yes)                                  default
frontend:  Next.js 16   (profile: full)                                   512MB / 0.5 CPU
nginx:     Nginx 1.27   (profile: full)                                   default
```

Healthchecks:
- `backend`: HTTP GET `/api/health` → 200
- `worker`: sentinel file `/tmp/riviso_worker.heartbeat` (touched every loop ≤120s)
- `scheduler`: sentinel file `/tmp/riviso_scheduler.heartbeat`
- `redis`: `redis-cli ping`

### CI/CD
- **CI** (`.github/workflows/ci.yml`): pytest + ESLint + unit tests on every PR to `main` and push to `main`
- **Security** (`.github/workflows/security.yml`): pip-audit + npm audit + gitleaks on PRs + weekly schedule
- **Deployment**: manual — SSH to VPS, `git pull`, `docker compose build`, `docker compose up -d`

### Procfile (alternative to Docker Compose)
```
web:       uvicorn app.main:app (ENABLE_SCHEDULER=0, ENABLE_GENERATION_WORKER=0)
worker:    python -m app.run_background (ENABLE_GENERATION_WORKER=1, ENABLE_SCHEDULER=0)
scheduler: python -m app.run_background (ENABLE_SCHEDULER=1, ENABLE_GENERATION_WORKER=0)
```

### Environment Files
- `backend/.env` — loaded by pydantic-settings; contains secrets; gitignored in production
- `backend/.env.production` — production template; gitignored
- `backend/.env.example` — committed example with placeholder values only
