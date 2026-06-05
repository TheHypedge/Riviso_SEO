# CLAUDE.md — Riviso AI Content Platform
## AI Assistant Operating Instructions

This file is the authoritative operating guide for Claude sessions working on this repository.
Read it before making any change. Keep it synchronized with the codebase at all times.

---

## Project Identity

**Riviso** is a multi-tenant SaaS platform for AI-powered SEO/AEO/GEO content generation,
published to WordPress and Shopify. Users create projects, configure brand/niche prompts,
generate articles with AI, humanize them, and schedule publication.

**Production URLs**
- Frontend: `https://app.riviso.com`
- Backend API (direct): `https://api.riviso.cloud`
- Backend API (via Next.js proxy): `https://app.riviso.com/api/*`

**GitHub repo**: `TheHypedge/Riviso_SEO`
**Active branch**: `development` → merges to `main`

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16 / React 19 / TypeScript 5 |
| Backend | FastAPI 0.116 / Python 3.12 / Pydantic v2 |
| Primary DB | MongoDB (Atlas) via pymongo + Motor (async) |
| Queue | Redis 7 (Redis-backed generation queue; in-process fallback) |
| Background | APScheduler in dedicated Docker container |
| AI | OpenAI GPT-4.1-mini (text), gpt-image-1 (images), text-embedding-3-small (embeddings) |
| Deployment | Docker Compose on Hostinger VPS + Nginx reverse proxy |
| Auth | JWT (HS256) — `aa_access` cookie + `Authorization: Bearer` |
| Email | SMTP (configurable host/port/TLS) via `email_dispatch.py` |
| Monitoring | Prometheus metrics endpoint, Sentry (optional) |

---

## Architectural Constraints

### 1. Never add `from __future__ import annotations` to route files
**Why**: Python 3.13 supports native `X | Y` union syntax. In route files, this import
makes Pydantic v2 + SlowAPI `@limiter.limit` fail at runtime with `ForwardRef` errors
causing 422 "payload: Field required" on every request. Already removed from:
`articles.py`, `auth.py`, `research.py`. Do not add it back.

### 2. Cookie domain must stay empty in production
`COOKIE_DOMAIN` must be unset (empty string). An explicit domain makes browser reject
cookies when requests route through the Next.js proxy (`app.riviso.com/api → api.riviso.cloud`).

### 3. Always proxy through Next.js in production
Frontend requests must go to `/api/*` (same-origin), which Next.js rewrites to the backend.
Direct backend calls from the browser break SameSite=Lax cookies and CORS. The set
`RIVISO_APP_HOSTS` in `frontend/src/lib/api.ts` controls which hostnames use the proxy path.

### 4. MongoDB is the single source of truth
Do not read from `data/projects.json` / `data/articles.json` in production routes.
Legacy JSON files exist only for dev/import fallback (`AUTO_IMPORT_JSON=1`). The repo-root
`storage.py` provides the write interface; `backend/app/services/mongo_listings_async.py`
provides Motor async reads for hot paths.

### 5. Process topology: one scheduler replica
Docker Compose runs 4 containers: `backend` (API, no scheduler/worker), `worker`
(generation queue consumer), `scheduler` (cron + daily reset), `redis`. Never run
scheduler in more than one process — it double-fires scheduled jobs. The `backend`
container always has `ENABLE_SCHEDULER=0` and `ENABLE_GENERATION_WORKER=0`.

### 6. Never mock MongoDB in production tests
Use `FORCE_JSON_STORAGE=1` for CI tests that don't need a real database. Don't add
pymongo mocks — they hide real schema/index issues.

### 7. Pydantic Settings wins over os.environ
`backend/app/core/config.py` uses `pydantic-settings`. Values from `backend/.env` take
precedence over environment variables injected by docker-compose `environment:` blocks.
Always verify `settings.enable_generation_worker` and `settings.enable_scheduler` rather
than reading `os.environ` directly.

---

## Coding Standards

### Python (backend)
- Python 3.12 target; no `from __future__ import annotations` in route files
- Pydantic v2 models for all request/response schemas in `backend/app/schemas/`
- All blocking MongoDB/storage calls go through `run_sync(call_storage, fn, ...)` to
  stay off the asyncio event loop
- `async def` for all route handlers; blocking calls use `app.services.to_thread.run_sync`
- Route handlers: no business logic — delegate to service modules under `app/services/`
- Services: no FastAPI imports, no `HTTPException` (except where explicitly needed)
- Validation at boundaries only; trust internal typed data
- No `print()` — use `logging.getLogger(__name__)`
- No bare `except:` — always catch specific exceptions or `Exception`

### TypeScript (frontend)
- Strict TypeScript; no `any` without justification
- All API calls go through `frontend/src/lib/api.ts` — never `fetch()` raw in components
- Long-running API calls (generation, research) use `LONG_API_TIMEOUT_MS` (600s)
- Add `X-Requested-With: XMLHttpRequest` header on all mutating API calls (CSRF protection)
- `pollWithBackoff` for generation status polling; throw immediately when `generation_error` set
- State management: React `useState` + `useEffect` — no Redux or Zustand

### CSS / Styling
- CSS Modules (`.module.css`) per page/component — no global utility classes
- No inline `style=` on JSX except for dynamic values (colors, widths driven by state)
- No Tailwind; no styled-components

---

## Security Requirements

- `SECRET_KEY` must be a long random string in production; app refuses to start if `ENVIRONMENT=production` and key is the default
- Never commit `.env` files, API keys, or OAuth secrets — `.env.production` is in `.gitignore`
- SMTP passwords containing `#` must be double-quoted in `.env`: `SMTP_PASS="pass#word"`
- Rate limiting: `300/minute` per authenticated user (by JWT `sub`), per IP for anonymous
- CSRF protection: `X-Requested-With` header required on all cookie-authed mutations
- Security headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `CSP`, `Permissions-Policy` on all responses
- HSTS emitted only on HTTPS (`x-forwarded-proto: https`) — never on local HTTP
- SSRF guard in `app.services.url_guard` — use `assert_public_http_url()` before any user-supplied URL fetch
- Never expose `/docs`, `/redoc`, `/openapi.json` when `ENVIRONMENT=production`

---

## Preferred Patterns

### Adding a new API endpoint
1. Create/update Pydantic schema in `backend/app/schemas/`
2. Create/update route in `backend/app/api/routes/`
3. Register router in `backend/app/api/router.py` if new file
4. Add corresponding function to `frontend/src/lib/api.ts`
5. Never add `from __future__ import annotations` to route files

### Adding a per-project setting
1. Add field to `ProjectSettingsPublic` and `ProjectSettingsUpdate` in `backend/app/schemas/project_settings.py`
2. Add GET/PATCH handling in `backend/app/api/routes/wordpress.py`
3. Wire through all 4 call sites: `articles.py`, `scheduler.py`, `topic_cluster_service.py`, `generation_worker.py`
4. Add field to `ProjectSettings` type in `frontend/src/lib/api.ts`
5. Add UI control to project Prompts tab in `frontend/src/app/projects/[projectId]/page.tsx`

### Generation pipeline flow
```
HTTP POST /generate
  → articles.py route
  → enqueue GenerationJob (ARTICLE_GENERATE) to Redis
  → 202 response with article_id
  → worker picks up job
  → execute_article_generation() in article_pipeline.py
  → generate_article_bundle_safe() in article_generation.py
  → AI-score audit (integrity_engine.py) — stored, no rewriting
  → persist to MongoDB
  → pipeline SSE stream updated at each stage
```

**Key generation design decisions (2026-06-05):**
- Content Optimization Profile (SEO/AEO/GEO/E-E-A-T) has been **removed** from the pipeline.
  `content_optimization.py` still exists but is no longer imported or called anywhere.
- Post-generation auto-humanization pass is **disabled by default**. The on-demand humanize
  button in the article editor still calls `execute_structural_humanization()` at fixed defaults
  (5 passes, 6% target, medium strength).
- **User writing prompt is the highest-priority directive.** The system prompt in
  `build_generation_messages()` explicitly states all other requirements are subordinate to it.
  Do not re-add optimization profile injections or mark any block as higher priority than
  the user prompt — that was the root cause of prompts being ignored.
- **Depth + FAQ/AEO/GEO are system-level defaults** injected into every generation via
  `build_generation_messages()`. System prompt requires: minimum 1,500 words, minimum 4 H2 sections,
  a `## Frequently Asked Questions` section (4–6 Q&A pairs written for AI answer engines).
  These defaults are overridable by the user's writing prompt (USER PROMPT AUTHORITY).
  Default writing prompt (`_DEFAULT_WRITING_PROMPT_TEXT` in `prompts.py`) also requests
  1,500–2,500 word in-depth content with FAQ — applied to new projects on first load.

---

## Files Not to Modify Without Understanding

| File | Why |
|------|-----|
| `backend/app/core/deps.py` | JWT auth resolution — wrong change breaks all protected routes |
| `backend/app/core/security.py` | JWT sign/verify — changing algorithm invalidates all sessions |
| `backend/app/services/generation_queue.py` | Redis queue semantics — dedup TTL and semaphore bounds |
| `backend/app/services/integrity_engine.py` | Humanization pipeline — called only from the on-demand editor humanize route; not in auto-generation flow |
| `backend/app/services/content_optimization.py` | Optimization profile blocks — **not used** in generation. Do not re-import into article_generation.py without explicit user request |
| `database.py` (repo root) | Pymongo pool config — pool size / idle timeout tuned for Atlas tier |
| `frontend/src/lib/api.ts` | RIVISO_APP_HOSTS set — wrong values cause auth loop in production |

---

## Environment Variables (Critical)

| Variable | Notes |
|----------|-------|
| `MONGODB_URI` | Required; Atlas connection string |
| `MONGODB_DB_NAME` | Default: `auto_articles` |
| `SECRET_KEY` | Must be random + long in production |
| `OPENAI_API_KEY` | Required for generation |
| `ENVIRONMENT` | `development` or `production` |
| `COOKIE_DOMAIN` | Leave empty in production (proxy cookie fix) |
| `REDIS_URL` | `redis://127.0.0.1:6379/0` on VPS |
| `ENABLE_GENERATION_WORKER` | `1` for worker container only |
| `ENABLE_SCHEDULER` | `1` for scheduler container only |
| `SMTP_PASS` | Wrap in double quotes if contains `#` |

---

## Architecture: Frontend on Vercel, Backend on VPS

- **Frontend** (`app.riviso.com`) → Vercel. Set `BACKEND_URL=https://api.riviso.cloud` in Vercel env vars.
- **Backend** (`api.riviso.cloud`) → Hostinger VPS. Docker Compose runs: backend, worker, scheduler, redis.
- Next.js on Vercel proxies `/api/*` → `api.riviso.cloud/api/*` server-side — cookies work correctly.
- `COOKIE_DOMAIN` must stay empty on VPS (proxy-cookie rule, see constraint #2).

### VPS Nginx (host-level, not Docker)
The **host-level nginx** (`/etc/nginx/sites-enabled/api.riviso.cloud`) is the actual TLS gateway:
- Certbot manages SSL on port 443
- Proxies to `http://127.0.0.1:8000` (Docker backend's exposed port)
- The Docker `nginx` container in `docker-compose.yml` is **orphaned/unused** — port 80 is held
  by host nginx. Do not attempt to start or fix it; it is not in the traffic path.

## Deploy Checklist

```bash
# Working directory is /var/www/riviso (we are on the VPS)
git add <files>
git commit -m "..."
git push origin main

# Rebuild and restart affected containers
docker compose build --no-cache backend worker scheduler
docker compose up -d
docker compose ps          # backend / worker / scheduler / redis should be healthy
docker compose logs --tail=30 backend
docker compose logs --tail=30 worker
# nginx container will show as restarting — this is expected and harmless (host nginx is the gateway)
```
