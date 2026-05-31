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

### Phase P0 — Critical stop-the-bleed (do immediately)

| ID | Item | Evidence | Fix | Verify |
|----|------|----------|-----|--------|
| **S0.1** | Fail-fast on placeholder/short `SECRET_KEY` in production | `core/config.py:47-49`, `core/production.py:67-71` (warn-only) | Raise at startup if `ENVIRONMENT=production` and key is default or <32 chars | Boot with bad key → process exits non-zero |
| **S0.2** | Remove hardcoded admin seed `Admin@2026` | `app.py:52-78` | Delete seed; replace with env-gated one-time bootstrap CLI | grep shows no literal password; fresh DB has no default admin |
| **S0.3** | Stop returning WordPress app password in API responses | `routes/wordpress.py:537,584-585`, `schemas/project_settings.py:34-36` | Return `wp_app_password_set: bool` only | Response JSON contains no secret value |
| **S0.4** | Disallow `MONGODB_TLS_INSECURE=1` and legacy `OAUTHLIB_INSECURE_TRANSPORT` in production | `database.py:88-93`, `app.py:33-36` | Startup check rejects insecure transport when production | Prod boot fails if flags set |
| **S0.5** | Confirm legacy Flask `app.py` is NOT deployed/reachable | `app.py` (whole) | Remove from deploy target or gate behind disabled flag | No route on prod served by Flask |

### Phase P1 — Security hardening

**Auth & sessions**
| ID | Item | Evidence | Fix |
|----|------|----------|-----|
| **S1.1** | Refresh-token rotation + server-side invalidation | `routes/auth.py:700-790` | Issue new RT each refresh; track jti allow/deny list |
| **S1.2** | Rate-limit `/auth/refresh` | `routes/auth.py:700` | `@limiter.limit("20/minute")` |
| **S1.3** | Move tokens out of `localStorage` → httpOnly cookies only | `frontend/src/lib/api.ts:1038-1060,1282-1347` | Cookie-only auth; drop localStorage; add CSRF defense (S1.7) |
| **S1.4** | Cookie `Secure` default true in prod + `max_age` aligned to TTL | `core/config.py:53`, `routes/auth.py:127-163,772-788` | Secure+SameSite+expiry |
| **S1.5** | Account lockout after N failed logins | `routes/auth.py:187` | Per-email backoff/lockout |

**SSRF (outbound HTTP to user-supplied URLs)**
| ID | Item | Evidence | Fix |
|----|------|----------|-----|
| **S1.6a** | Block private/link-local/metadata IPs on WordPress fetch | `routes/wordpress.py:140-146`, `services/wordpress_client.py:45-81` | URL allowlist + IP guard, restrict redirects |
| **S1.6b** | SSRF guard on Shopify shop resolution | `services/shopify_oauth.py:132-137` | Require `*.myshopify.com` / Admin API only |
| **S1.6c** | SSRF guard on featured-image + OpenAI ref-image download | `services/wordpress_client.py:231-237`, `services/shopify_article_image.py:47-61`, `services/openai_client.py:175-178` | HTTPS host allowlist / data-URL only |

**CORS / CSRF / headers / abuse**
| ID | Item | Evidence | Fix |
|----|------|----------|-----|
| **S1.7** | CSRF protection for cookie auth | `core/deps.py:38-46` | Require `X-Requested-With` header on mutations or SameSite=Strict |
| **S1.8** | Drop localhost origins from prod CORS | `main.py:72-87,234-240` | Env-only strict allowlist in production |
| **S1.9** | Rate-limit expensive endpoints (generate, bulk-upload, publish, research) | `core/ratelimit.py:13` | Per-user limits on OpenAI-backed routes |
| **S1.10** | Trust-proxy config so rate-limit key isn't `X-Forwarded-For`-spoofable | `core/ratelimit.py:11-13` | Configure trusted proxy or key by user id |
| **S1.11** | Split public liveness from detailed readiness `/health` | `routes/health.py:49-60` | Public `{status:ok}`; detail behind auth |
| **S1.12** | Close plan bypasses: humanize + export-consume | `routes/articles.py:1723` (humanize no gate), `901-936` (client export) | Add `require_plan_action`; server-side export gating |
| **S1.13** | Authenticate WordPress plugin ZIP download | `routes/wordpress.py:508-527` | Require auth or signed token |
| **S1.14** | Add Next.js security headers | `frontend/next.config.ts:15-27` | `headers()` with HSTS/CSP/X-Frame |

---

# B. PERFORMANCE WORK (from optimization audit)

### Phase P2 — Performance quick wins (high ROI, low risk)

| ID | Item | Audit ref | Fix |
|----|------|-----------|-----|
| **P2.1** | Request-scoped cache for user/subscription/plan (kills 3–5 reads/req) | Opt §3.3 | Attach to `request.state`; gatekeeper reads it |
| **P2.2** | TTL cache for `load_plans()` | Opt §1.4B | Module cache (~60s) invalidated on `upsert_plan` |
| **P2.3** | Wrap all sync storage in `run_sync` on hot async paths | Opt §3.4 | `deps.py`, `project_lookup.py`, `wordpress.py`, `project_shopify.py` |
| **P2.4** | Add `load_articles_by_ids_for_project` + use in bulk validate / job lookup | Opt §1.1, §3.2 | `$in` query, drop 20k scans |
| **P2.5** | `asyncio.gather` obvious serial pairs (editor-shell, board, Shopify sync) | Opt §3.1 | Concurrent independent awaits |
| **P2.6** | Frontend: visibility guard + backoff on all poll loops | Opt §3.7 | `document.hidden` check + backoff |
| **P2.7** | Frontend: replace `listArticlesAll` (50-page waterfall) with aggregate endpoint on Overview/Tools | Opt §3.2/§3.8 | Use `workspaceOverview()` |
| **P2.8** | Stop project-shell refetch on tab switch; dedupe GSC analytics fetches | Opt §3.8 | Drop `tab` from deps; share analytics in state |

### Phase P4 — Structural performance refactor (deeper)

| ID | Item | Audit ref | Fix |
|----|------|-----------|-----|
| **P4.1** | Add Mongo projections everywhere (project/user/scheduler light vs full) | Opt §1.2 | Per-call-site projections |
| **P4.2** | Route all partial writes through `$set`; batch `bulk_update_articles` | Opt §1.3 | bulk_write of `$set` ops |
| **P4.3** | Persist `has_body` + derived listing status (kill pre-`$limit` body scans & double 20k scans) | Opt §1.4A, §3.6 | Write-time flags + `$match` |
| **P4.4** | Bulk scheduled-job APIs (upsert/delete); move heal to worker | Opt §3.2, §3.7 | `delete_many`, background heal |
| **P4.5** | Add missing indexes/TTLs (`site_maps`, monitors, `research_cache`) | Opt §1.5 | `create_index` + TTL |
| **P4.6** | Typed repositories + domain models (heavy/light fields) | Opt §2.1-2.2 | `ArticleRepository`, etc. |
| **P4.7** | `RequestContext` carrying memoized user/project/plan | Opt §2.3 | DI object |
| **P4.8** | Expand Motor async coverage for hot reads | Opt §3.4 | Reduce thread-pool reliance |

---

# C. INFRASTRUCTURE FOR 50 USERS

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

### Phase P5 — Observability, testing & CI

| ID | Item | Target |
|----|------|--------|
| **I5.1** | Error tracking (Sentry) on API + worker + frontend | Capture exceptions w/ PII scrubbing |
| **I5.2** | Metrics + dashboards (request latency, queue depth, Mongo op time, OpenAI latency) | Prometheus/Grafana or hosted |
| **I5.3** | Structured logging w/ request IDs | Correlate across API/worker |
| **I5.4** | CI: `pip-audit` / Dependabot + secret scanning (gitleaks) | Block merges on Critical |
| **I5.5** | CI: backend pytest + frontend unit tests run on PR | Green gate to deploy |
| **I5.6** | Integration tests for auth, plan gating, publish flows | Cover the security-sensitive paths |
| **I5.7** | Uptime monitoring + alerting (on `/health` readiness) | Page on downtime |

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

*See `RIVISO_HARDENING_TRACKER.xlsx` for the same items as a trackable backlog (Phase, ID, Category, Severity/Priority, Effort, Status, Owner, Verification).*
