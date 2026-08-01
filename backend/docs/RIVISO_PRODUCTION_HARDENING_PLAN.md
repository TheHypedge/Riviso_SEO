# Riviso — Production Hardening & Scale Plan (Target: ~50 users)

> **Goal:** Take the current app to a "full-blown, solid" production state — security-hardened, performance-optimized, and running on infrastructure sized for **~50 active users** (not over-engineered).
> **Inputs:** `RIVISO_SECURITY_AUDIT` (this plan, §A), `RIVISO_PERFORMANCE_OPTIMIZATION_AUDIT.md`, `RIVISO_BACKEND_ARCHITECTURE_BLUEPRINT.md`.
> **Companion:** `RIVISO_HARDENING_TRACKER.xlsx` (task tracker with the same IDs used here).
> **Rule:** No work item is "done" without a verification step (test, scan, or load check).

---

## 0. Sizing assumption — what "50 users" means

We size for **50 registered users, ~10–15 concurrent, a few hundred article generations/day**. This is a *modest* load, so the plan deliberately avoids over-engineering (no Kubernetes, no microservices, no sharding). The target topology is:

```
Cloudflare/Nginx (TLS, HSTS, WAF-lite)
        │
   ┌────┴─────┐
   │ FastAPI  │  (1–2 uvicorn instances, ENABLE_SCHEDULER=0)
   └────┬─────┘
        │
   ┌────┴──────────┬───────────────┐
   │ Worker proc   │  Scheduler proc │  (1 each, ENABLE_GENERATION_WORKER/SCHEDULER)
   └────┬──────────┴───────┬─────────┘
        │                  │
   MongoDB Atlas M10   Redis (managed, e.g. Upstash/Elasticache small)
```

Everything below is scoped to make *this* topology reliable, secure, and fast.

---

## Phase overview

| Phase | Theme | Duration (est.) | Exit criteria |
|-------|-------|-----------------|---------------|
| **P0** | Critical security stop-the-bleed | 3–5 days | No Critical/High secrets or credential-leak issues open |
| **P1** | Security hardening (auth, SSRF, CORS) | 1–1.5 weeks | All High security items closed + verified |
| **P2** | Performance quick wins | 1 week | Per-request DB reads cut; polling visibility-aware |
| **P3** | Infrastructure for 50 users | 1–1.5 weeks | Separate worker/scheduler, managed Mongo+Redis, backups, monitoring live |
| **P4** | Structural refactor (data/OOP layer) | 2–3 weeks | Typed repositories + request context; projections enforced |
| **P5** | Observability, testing & CI gates | 1 week | Metrics, error tracking, CI security+test gates |
| **P6** | Launch readiness & hardening review | 3–5 days | Load test @ 15 concurrent passes; runbook + DR documented |

> Durations assume 1–2 engineers. Phases P0→P1 are sequential; P2 can overlap P1; P3 can start once P1 is underway.

---

# A. SECURITY WORK (grounded in code audit)

> **✅ STATUS UPDATE 2026-08-01:** A full re-verification pass this session (see `RIVISO_ROADMAP_F0_F1_F2.md` note below and Claude memory `project_f0_hardening.md`) found **every P0 item and nearly every P1 item already shipped in code**, most from a prior commit (`618c424`) that predates this plan being actively tracked. Only S1.6a-c (SSRF) had two real remaining gaps, now closed. Four items **not in this plan at all** were found and fixed the same session — see the addendum after Phase P1.

### Phase P0 — Critical stop-the-bleed (do immediately) — ✅ ALL VERIFIED DONE 2026-08-01

| ID | Item | Evidence | Fix | Verify | Status |
|----|------|----------|-----|--------|--------|
| **S0.1** | Fail-fast on placeholder/short `SECRET_KEY` in production | `core/config.py:47-49`, `core/production.py:67-71` (warn-only) | Raise at startup if `ENVIRONMENT=production` and key is default or <32 chars | Boot with bad key → process exits non-zero | ✅ `core/production.py` raises `RuntimeError` on short/placeholder key in prod |
| **S0.2** | Remove hardcoded admin seed `Admin@2026` | `app.py:52-78` | Delete seed; replace with env-gated one-time bootstrap CLI | grep shows no literal password; fresh DB has no default admin | ✅ No literal seed found; moot as of F0.6 (`app.py` itself deleted, dead Flask code) |
| **S0.3** | Stop returning WordPress app password in API responses | `routes/wordpress.py:537,584-585`, `schemas/project_settings.py:34-36` | Return `wp_app_password_set: bool` only | Response JSON contains no secret value | ✅ `routes/wordpress.py` returns `wp_app_password_set=bool(app_pw)` only |
| **S0.4** | Disallow `MONGODB_TLS_INSECURE=1` and legacy `OAUTHLIB_INSECURE_TRANSPORT` in production | `database.py:88-93`, `app.py:33-36` | Startup check rejects insecure transport when production | Prod boot fails if flags set | ✅ Both checked and rejected in `core/production.py` |
| **S0.5** | Confirm legacy Flask `app.py` is NOT deployed/reachable | `app.py` (whole) | Remove from deploy target or gate behind disabled flag | No route on prod served by Flask | ✅ Confirmed unreachable (Procfile already routed `web:` to FastAPI, no process running it), then **deleted** (`app.py` + `wsgi.py`, F0.6, commit `639b1b7`) — stronger than the original "confirm" bar |

### Phase P1 — Security hardening — ✅ ALL VERIFIED DONE 2026-08-01 (S1.6 was the one real gap)

**Auth & sessions**
| ID | Item | Evidence | Fix | Status |
|----|------|----------|-----|--------|
| **S1.1** | Refresh-token rotation + server-side invalidation | `routes/auth.py:700-790` | Issue new RT each refresh; track jti allow/deny list | ✅ Shipped separately, commit `efaf6a7` (2026-07-05) — see Claude memory `project_auth_session_fix.md` |
| **S1.2** | Rate-limit `/auth/refresh` | `routes/auth.py:700` | `@limiter.limit("20/minute")` | ✅ Confirmed present |
| **S1.3** | Move tokens out of `localStorage` → httpOnly cookies only | `frontend/src/lib/api.ts:1038-1060,1282-1347` | Cookie-only auth; drop localStorage; add CSRF defense (S1.7) | ✅ Confirmed — only a non-sensitive session marker remains in localStorage, real tokens in httpOnly cookies |
| **S1.4** | Cookie `Secure` default true in prod + `max_age` aligned to TTL | `core/config.py:53`, `routes/auth.py:127-163,772-788` | Secure+SameSite+expiry | ✅ `_cookie_secure_flag()` + `samesite` wired |
| **S1.5** | Account lockout after N failed logins | `routes/auth.py:187` | Per-email backoff/lockout | ✅ `login_failed_count`/`login_lockout_until` implemented, explicitly commented `# S1.5` in code |

**SSRF (outbound HTTP to user-supplied URLs) — the one real gap, closed 2026-08-01**
| ID | Item | Evidence | Fix | Status |
|----|------|----------|-----|--------|
| **S1.6a** | Block private/link-local/metadata IPs on WordPress fetch | `routes/wordpress.py:140-146`, `services/wordpress_client.py:45-81` | URL allowlist + IP guard, restrict redirects | ✅ `services/url_guard.py` (`assert_public_http_url`, `ssrf_guarded_event_hooks`) already wired into `wordpress_client.py` from an earlier commit. One gap closed 2026-08-01 (F0.3, commit `857e7fb`): `wordpress_publish.py`'s `probe_publish_permission_on_client()` built its own raw unguarded `httpx.AsyncClient` — now uses the same guard. |
| **S1.6b** | SSRF guard on Shopify shop resolution | `services/shopify_oauth.py:132-137` | Require `*.myshopify.com` / Admin API only | ✅ Already wired (`url_guard.py` imported and used) |
| **S1.6c** | SSRF guard on featured-image + OpenAI ref-image download | `services/wordpress_client.py:231-237`, `services/shopify_article_image.py:47-61`, `services/openai_client.py:175-178` | HTTPS host allowlist / data-URL only | ✅ Already wired in `openai_client.py`/`shopify_article_image.py`. One gap closed 2026-08-01 (F0.3): `storage.py`'s `_download_and_persist_image_url()` had a stale "URL comes from OpenAI CDN" comment despite being reachable via the generic article-update write path — now validates before fetching. |

**CORS / CSRF / headers / abuse**
| ID | Item | Evidence | Fix | Status |
|----|------|----------|-----|--------|
| **S1.7** | CSRF protection for cookie auth | `core/deps.py:38-46` | Require `X-Requested-With` header on mutations or SameSite=Strict | ✅ Confirmed present |
| **S1.8** | Drop localhost origins from prod CORS | `main.py:72-87,234-240` | Env-only strict allowlist in production | ✅ `_effective_cors_origins()` explicitly excludes localhost/loopback in prod, commented `# S1.8` |
| **S1.9** | Rate-limit expensive endpoints (generate, bulk-upload, publish, research) | `core/ratelimit.py:13` | Per-user limits on OpenAI-backed routes | ✅ Confirmed on `articles.py`/`research.py` routes |
| **S1.10** | Trust-proxy config so rate-limit key isn't `X-Forwarded-For`-spoofable | `core/ratelimit.py:11-13` | Configure trusted proxy or key by user id | ✅ `rate_limit_key()` keys by authenticated user id (JWT subject), commented `# S1.10` |
| **S1.11** | Split public liveness from detailed readiness `/health` | `routes/health.py:49-60` | Public `{status:ok}`; detail behind auth | ✅ `/health` (public, no internals) vs `/health/ready` (authenticated, detailed), commented `# S1.11` |
| **S1.12** | Close plan bypasses: humanize + export-consume | `routes/articles.py:1723` (humanize no gate), `901-936` (client export) | Add `require_plan_action`; server-side export gating | ✅ Both routes depend on `require_plan_action_for_project(...)` |
| **S1.13** | Authenticate WordPress plugin ZIP download | `routes/wordpress.py:508-527` | Require auth or signed token | ✅ `download_plugin` depends on `get_current_user` |
| **S1.14** | Add Next.js security headers | `frontend/next.config.ts:15-27` | `headers()` with HSTS/CSP/X-Frame | ✅ X-Frame-Options/HSTS/Referrer-Policy/Permissions-Policy already present; **Content-Security-Policy added 2026-08-01** (F0.5, commit `ab3408b`) — the one piece that was actually missing. `script-src`/`style-src` still allow `'unsafe-inline'` (no nonce plumbing yet) — real follow-up, not closed. |

### Addendum — found and fixed 2026-08-01, not in the original plan

| ID | Item | Fix | Commit |
|----|------|-----|--------|
| **N1** | `wp_app_password`, `gsc_access_token`, `gsc_refresh_token`, `shopify_access_token`, `shopify_client_secret` stored **plaintext** in MongoDB — the original audit's Critical finding, not previously tracked here | Fernet encryption at the two Mongo boundaries in `storage.py` (`_mongo_doc_to_project` decrypts, `_encrypt_project_secrets` encrypts); `FIELD_ENCRYPTION_KEY` required in prod (fails boot without it, same pattern as S0.1); dual-read so old plaintext rows keep working; one-time migration script run against all 24 live projects (17 migrated, 0 failed) | `42da16c` (F0.2) |
| **N2** | `.gitignore` only matched exact `.env`, not `backend/.env.save` — a live-credential file sat outside its reach | Added `backend/.env.save`, `*.env.save`, `*.env.bak`; deleted the stale file (confirmed never committed) | `61d1181` (F0.1) |
| **N3** | AI-generated HTML rendered via `dangerouslySetInnerHTML` with no sanitization (stored-XSS path via `marked.parse()` passing through raw HTML in markdown source) | `isomorphic-dompurify` added at the single shared choke point, `markdownToArticleHtml()` in `frontend/src/lib/articleMarkdown.ts` | `ab66644` (F0.4) |
| **N4** | Password hashing was werkzeug `scrypt` (already memory-hard/OWASP-acceptable — **correction**: the original audit assumed PBKDF2, verified against the live DB to actually be scrypt) | Migrated to Argon2id (OWASP's #1 pick) via `backend/app/core/password_hashing.py`; opportunistic rehash on next successful login, no bulk migration | `b367b68` (F2.3) |

---

# B. PERFORMANCE WORK (from optimization audit)

### Phase P2 — Performance quick wins (high ROI, low risk) — ✅ ALL DONE, VERIFIED 2026-08-01

> **✅ STATUS UPDATE 2026-08-01:** 7 of 8 items were already shipped in earlier work (each carries its own `P2.x` code comment as a marker). Only P2.3 had a real gap: of the four files it names, `project_shopify.py` was the one where none of the ~17 direct Mongo calls were wrapped — every Shopify credential read/write was blocking the single backend event loop for every other concurrent user. Fixed (F1.3, commit `4b019be`).

| ID | Item | Audit ref | Fix | Status |
|----|------|-----------|-----|--------|
| **P2.1** | Request-scoped cache for user/subscription/plan (kills 3–5 reads/req) | Opt §3.3 | Attach to `request.state`; gatekeeper reads it | ✅ `app/core/request_context.py` exists (`RequestContext`, `get_request_context`) |
| **P2.2** | TTL cache for `load_plans()` | Opt §1.4B | Module cache (~60s) invalidated on `upsert_plan` | ✅ `storage.py` `_PLANS_CACHE`, 60s TTL |
| **P2.3** | Wrap all sync storage in `run_sync` on hot async paths | Opt §3.4 | `deps.py`, `project_lookup.py`, `wordpress.py`, `project_shopify.py` | ✅ First 3 files already done; **`project_shopify.py` fixed 2026-08-01** — all ~17 call sites wrapped, `verify_connection`'s nested `_persist` closure converted `def`→`async def`. Access-check calls (`require_project_access`) deliberately left un-wrapped, matching the existing convention in `wordpress.py` itself. |
| **P2.4** | Add `load_articles_by_ids_for_project` + use in bulk validate / job lookup | Opt §1.1, §3.2 | `$in` query, drop 20k scans | ✅ `storage.py` has `load_articles_by_ids_for_project` |
| **P2.5** | `asyncio.gather` obvious serial pairs (editor-shell, board, Shopify sync) | Opt §3.1 | Concurrent independent awaits | ✅ `asyncio.gather` present in `articles.py` (editor-shell + board). Shopify sync's steps are sequentially dependent (fetch scopes → sync catalog → persist) — no parallelizable pair exists there. |
| **P2.6** | Frontend: visibility guard + backoff on all poll loops | Opt §3.7 | `document.hidden` check + backoff | ✅ Confirmed in `page.tsx`, commented `// P2.6` |
| **P2.7** | Frontend: replace `listArticlesAll` (50-page waterfall) with aggregate endpoint on Overview/Tools | Opt §3.2/§3.8 | Use `workspaceOverview()` | ✅ `api.listArticlesAll` already does bounded-concurrency (4-at-a-time) pagination, not a serial waterfall — commented `// P2.7` |
| **P2.8** | Stop project-shell refetch on tab switch; dedupe GSC analytics fetches | Opt §3.8 | Drop `tab` from deps; share analytics in state | ✅ Confirmed in `page.tsx`, commented `// P2.8` |

### Addendum — found and fixed 2026-08-01, not in the original P2 list

| ID | Item | Fix | Commit |
|----|------|-----|--------|
| **N5** | `generation_worker_loop()` awaited each dequeued job to full completion before dequeuing the next — exactly 1 article generation in flight system-wide regardless of queue depth, despite a `generation_slot()` semaphore already coded and logged at `max_concurrent=3` on startup | Loop now spawns each job as its own `asyncio.create_task()`; actual concurrency stays bounded by the existing semaphore inside the OpenAI-heavy handlers, which was already correct — it just never had more than one job to throttle. Tracks in-flight tasks so shutdown cancels them instead of orphaning. Verified in isolation: 6 fake jobs settle into batches of exactly 3 concurrent. | `aaf44bf` (F1.1) |
| **N6** | `fetch_workspace_overview_bundle()` (dashboard Overview widget data source) had zero caching — a fresh aggregation across up to 500 projects/1500 articles/2000 scheduled jobs on every load | Same 90s TTL pattern as `GoogleConsoleService._CACHE`, keyed on `(owner_user_id, article_limit)` only (date/project filtering happens post-fetch). Degraded (partial-failure) results never cached. | `9f9124b` (F1.4) |

### Phase P4 — Structural performance refactor (deeper)  ✅ DONE

| ID | Item | Audit ref | Fix | Status |
|----|------|-----------|-----|--------|
| **P4.1** | Add Mongo projections everywhere (project/user/scheduler light vs full) | Opt §1.2 | Per-call-site projections | ✅ Project/access/listing/shopify projections already in place; added `get_project_for_generation` (catalog-excluded) wired into worker + scheduler. Heavy catalog products already moved to `shopify_products`. |
| **P4.2** | Route all partial writes through `$set`; batch `bulk_update_articles` | Opt §1.3 | bulk_write of `$set` ops | ✅ `bulk_update_articles` now batch-reads via one `$in` (was N+1 find_ones); `patch_article_fields` ($set) is the partial-write path. |
| **P4.3** | Persist `has_body` + derived listing status (kill pre-`$limit` body scans & double 20k scans) | Opt §1.4A, §3.6 | Write-time flags + `$match` | ✅ `has_body`+`listing_status` persisted in `_normalize_article_dict` & maintained on `$set`; idempotent startup backfill; compound index; `list_articles` status filter now a single indexed `$match`. |
| **P4.4** | Bulk scheduled-job APIs (upsert/delete); move heal to worker | Opt §3.2, §3.7 | `delete_many`, background heal | ✅ `delete_scheduled_jobs_for_project/_for_article` (`delete_many`) replace per-row deletes in clear/cancel (via repo). Heal already runs in the scheduler loop (~10s). |
| **P4.5** | Add missing indexes/TTLs (`site_maps`, monitors, `research_cache`) | Opt §1.5 | `create_index` + TTL | ✅ Done earlier (P0/P1 batch). |
| **P4.6** | Typed repositories + domain models (heavy/light fields) | Opt §2.1-2.2 | `ArticleRepository`, etc. | ✅ `app/repositories/` (Article/Project/User/ScheduledJob repos + `ArticleRef`/`ProjectRef` light models); adopted in scheduled-job delete routes. |
| **P4.7** | `RequestContext` carrying memoized user/project/plan | Opt §2.3 | DI object | ✅ `app/core/request_context.py` DI object memoizing user/subscription/project/plan (builds on P2.1/P2.2 cache) and exposing the repositories. |
| **P4.8** | Expand Motor async coverage for hot reads | Opt §3.4 | Reduce thread-pool reliance | ✅ Motor `fetch_user_by_id` (shared `_user_doc_to_public` normalizer) wired into `get_current_user` with thread-pool fallback; `fetch_project_access_row` added. |

---

# C. INFRASTRUCTURE FOR 50 USERS

> **Status 2026-08-01:** Not started except I3.6-adjacent confirmation (Mongo `maxPoolSize=50` already set, sized fine for current load) and I3.7 (healthchecks already present in `docker-compose.yml`). I3.2 (managed Mongo), I3.3 (managed Redis), and I3.4 (backups) each need an account-level decision (provider, tier, destination) that only the human owner can make — see the pointer at the end of this file for where this is tracked as blocked-on-user, not silently skipped.

### Phase P3 — Scale & reliability (right-sized)

| ID | Item | Why (for 50 users) | Target |
|----|------|--------------------|--------|
| **I3.1** | Separate **worker** and **scheduler** from API processes | Blueprint §8 warns scheduler+worker+API contend; even at 50 users a long OpenAI job shouldn't block API | Procfile/compose: API (`ENABLE_SCHEDULER=0`, `ENABLE_GENERATION_WORKER=0`) + 1 worker + 1 scheduler |
| **I3.2** | Managed **MongoDB Atlas M10** (not shared M0) | Predictable IOPS/connections; backups; M10 is plenty for 50 users | Atlas M10, TLS on, IP allowlist, `maxIdleTimeMS=30000` |
| **I3.3** | Managed **Redis** (Upstash/ElastiCache small) | Queue + future cache; durable across restarts | Single managed instance, auth + TLS |
| **I3.4** | **Automated daily backups** + tested restore | Data safety for paying users | Atlas continuous backup; quarterly restore drill |
| **I3.5** | **TLS termination + HSTS + gzip** at Nginx/Cloudflare | HTTPS everywhere; offload | Already have `nginx/`; add HSTS, force redirect |
| **I3.6** | **Connection pool sizing** for 1–2 API + worker + scheduler | Avoid Atlas connection exhaustion | Set PyMongo `maxPoolSize` per process; sum < Atlas limit |
| **I3.7** | **Healthchecks + auto-restart** (liveness/readiness) | Self-healing | Container healthcheck → restart policy |
| **I3.8** | **Resource limits & 2-instance API** behind LB | Headroom + zero-downtime deploy | 2 small API instances, rolling deploy |
| **I3.9** | **Secrets via env/secret manager**, not files | Security + ops | Move `.env` to host secret store |
| **I3.10** | **Rate-limit store in Redis** (not in-memory) | Correct limits across 2 instances | SlowAPI → Redis storage backend |
| **I3.11** | **Email reliability** — queue or native SMTP lib | Subprocess email is fragile (Blueprint §8) | Replace Node subprocess or queue jobs |

> Explicitly **out of scope for 50 users** (documented so nobody gilds the lily): Kubernetes, DB sharding/read-replicas, multi-region, service mesh, autoscaling fleets. Revisit at ~1,000+ users.

### Phase P5 — Observability, testing & CI ✅

> See `RIVISO_OBSERVABILITY.md` for the full operational reference (env toggles, scrape/probe config, runbook).

| ID | Item | Target | Status |
|----|------|--------|--------|
| **I5.1** | Error tracking (Sentry) on API + worker + frontend | Capture exceptions w/ PII scrubbing | ✅ `init_sentry()` (API + worker), `@sentry/nextjs` instrumentation; DSN-gated, `send_default_pii=False` + auth/cookie scrub. No-op without DSN. |
| **I5.2** | Metrics + dashboards (request latency, queue depth, Mongo op time, OpenAI latency) | Prometheus/Grafana or hosted | ✅ `GET /metrics` (Prometheus): request count/latency/in-flight, generation queue depth, external-call timing hook. Bounded cardinality (route template). `METRICS_TOKEN`/`METRICS_ENABLED` gates. |
| **I5.3** | Structured logging w/ request IDs | Correlate across API/worker | ✅ Unified JSON logging (structlog + stdlib) via `ProcessorFormatter`; `RequestIdMiddleware` binds `request_id` (echoed in `X-Request-ID`); worker binds `job_id`/`job_kind`. |
| **I5.4** | CI: `pip-audit` / Dependabot + secret scanning (gitleaks) | Block merges on Critical | ✅ `.github/workflows/security.yml` (pip-audit + npm audit + gitleaks) + `.github/dependabot.yml` + `.gitleaks.toml`. |
| **I5.5** | CI: backend pytest + frontend unit tests run on PR | Green gate to deploy | ✅ `.github/workflows/ci.yml`: backend `pytest` (JSON storage) + frontend lint + `test:unit`. Dev deps in `backend/requirements-dev.txt`. |
| **I5.6** | Integration tests for auth, plan gating, publish flows | Cover the security-sensitive paths | ✅ `tests/test_integration_security_paths.py` — auth gating, CSRF, plan/trial/quota gating, admin bypass, request-id/metrics (13 tests). |
| **I5.7** | Uptime monitoring + alerting (on `/health` readiness) | Page on downtime | ✅ Documented in `RIVISO_OBSERVABILITY.md`: probe public `/api/health`, alerting (UptimeRobot/Cloudflare/Prometheus), SLO targets; complements container healthchecks (I3.7). |

### Phase P6 — Launch readiness

| ID | Item | Target |
|----|------|--------|
| **L6.1** | Load test @ 15 concurrent users / realistic generation mix | p95 latency within target, no errors |
| **L6.2** | Security re-scan (verify all P0/P1 closed) | Clean High/Critical |
| **L6.3** | Runbook + on-call + incident process | Documented |
| **L6.4** | Disaster recovery drill (restore from backup) | RTO/RPO verified |
| **L6.5** | Data retention & privacy review (GDPR-ish: deletion works end-to-end) | Account deletion purges data |

---

## Suggested sequencing (Gantt-ish)

```
Week 1   2   3   4   5   6   7   8   9   10
P0  ██
P1     ████████
P2        ██████
P3           ████████
P4                  ██████████████
P5                      ██████
P6                                  ████
```

- **Minimum viable "solid for 50 users"** = P0 + P1 + P2 + P3 + P5 (≈6–7 weeks).
- **P4** (typed repositories / structural refactor) is the long-term investment; it can land incrementally after launch without blocking it.

---

## Definition of Done (per item)

1. Code change merged behind review.
2. Test or scan proving the fix (unit/integration/security scan/load check).
3. No regression in CI.
4. Docs/runbook updated if behavior or ops change.

---

*See `RIVISO_HARDENING_TRACKER.xlsx` for the same items as a trackable backlog (Phase, ID, Category, Severity/Priority, Effort, Status, Owner, Verification) — **not updated with the 2026-08-01 status above, may read as stale until manually synced.***

*For an AI session picking this file up: current status and the reasoning behind it is also in Claude's persistent memory (`project_f0_hardening.md`, `project_f1_throughput.md` at `/root/.claude/projects/-var-www-riviso/memory/`) and in a live-maintained execution-plan artifact (see `reference_audit_roadmap_artifacts.md` in that same memory directory for the URL). Check memory first — it has verification detail and dated commit references this file summarizes but doesn't fully carry.*
