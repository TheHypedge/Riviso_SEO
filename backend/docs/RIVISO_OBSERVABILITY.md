# RIVISO — Observability, Testing & CI (Phase P5)

Operational reference for the P5 hardening items. Everything is **opt-in via env**:
with no extra env set the app behaves exactly as before, so local dev and tests are
unaffected.

---

## I5.1 — Error tracking (Sentry)

Backend (`api` + `worker`/`scheduler`) and the Next.js frontend report exceptions to
Sentry **only when a DSN is configured**. PII is off by default and request
auth/cookie headers are scrubbed before send.

| Process | Enable with | Notes |
|---------|-------------|-------|
| API (`uvicorn app.main:app`) | `SENTRY_DSN` | `init_sentry("api")` in `create_app()` |
| Worker / scheduler (`python -m app.run_background`) | `SENTRY_DSN` | `init_sentry("worker")` |
| Frontend (Next.js) | `NEXT_PUBLIC_SENTRY_DSN` (browser), `SENTRY_DSN` (server) | `instrumentation.ts`, `instrumentation-client.ts` |

Optional env:

- `SENTRY_TRACES_SAMPLE_RATE` / `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` — perf tracing (default `0`).
- `RELEASE` / `GIT_SHA` — tag events with the deployed version.
- `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` — source-map upload during `next build`.

> The frontend package `@sentry/nextjs` is declared in `frontend/package.json`. Run
> `npm install` before building so the Sentry plugin and instrumentation resolve.

---

## I5.2 — Metrics (Prometheus)

The API exposes `GET /metrics` in the standard Prometheus text format.

| Env | Default | Effect |
|-----|---------|--------|
| `METRICS_ENABLED` | `1` | Set `0` to return 404 (disable scraping) |
| `METRICS_TOKEN` | _(unset)_ | If set, require `Authorization: Bearer <token>` or `?token=` |

Series emitted:

- `riviso_http_requests_total{method,path,status}` — request counts (labelled by **route template**, not raw path, to bound cardinality).
- `riviso_http_request_duration_seconds{method,path}` — latency histogram.
- `riviso_http_requests_in_progress` — in-flight gauge.
- `riviso_generation_queue_depth` — pending generation jobs (sampled by the worker loop).
- `riviso_external_call_duration_seconds{service,operation}` — hook for storage/OpenAI timing.

If `prometheus-client` is not installed, `/metrics` returns `503` and the middleware is a no-op.

**Scrape config (Prometheus):**

```yaml
scrape_configs:
  - job_name: riviso-api
    metrics_path: /metrics
    authorization:
      credentials: ${METRICS_TOKEN}   # only if METRICS_TOKEN is set
    static_configs:
      - targets: ["api-host:8000"]
```

---

## I5.3 — Structured logging + request IDs

All logs — `structlog` calls **and** stdlib `logging` (uvicorn, pymongo, app modules) —
render as a single JSON stream on stdout (container-friendly). Each request is tagged
with a correlation id:

- `RequestIdMiddleware` reads inbound `X-Request-ID` (or generates one), binds it to
  `structlog` contextvars for the request, and echoes it in the `X-Request-ID` response header.
- The generation worker binds `job_id` + `job_kind` per job, so a request that enqueues
  work can be correlated with the worker logs that process it.

Example line:

```json
{"event":"...", "request_id":"a1b2c3d4...", "level":"info", "logger":"...", "timestamp":"..."}
```

To trace one request end-to-end: grep the `request_id` (and the `job_id` it enqueued)
across the API and worker logs.

---

## I5.4 / I5.5 — CI (GitHub Actions)

| Workflow | File | Gate |
|----------|------|------|
| Tests | `.github/workflows/ci.yml` | Backend `pytest` (JSON storage) + frontend lint + `npm run test:unit` on every PR/push to `main` |
| Security | `.github/workflows/security.yml` | `pip-audit` (backend + legacy reqs), `npm audit` (high+), `gitleaks` secret scan |
| Dependabot | `.github/dependabot.yml` | Weekly PRs for pip / npm / github-actions updates |

- Dev/test deps are pinned in `backend/requirements-dev.txt` (`pytest`, `pytest-asyncio`, `pip-audit`).
- `gitleaks` config: `.gitleaks.toml` (default ruleset + allowlist for documented placeholders).

---

## I5.6 — Integration tests

`backend/tests/test_integration_security_paths.py` exercises the security-sensitive
paths through the real FastAPI stack (routing + dependencies + middleware), with storage
forced to the JSON fallback:

- Auth gating (protected route 401 vs. authed 200; public liveness open).
- CSRF protection — cookie-auth mutation without `X-Requested-With` → 403 (S1.7).
- Plan / trial / publish gating — feature-disabled, quota-exhausted, trial-expired → 403; admin bypass; within-quota → 200.
- Observability — every response carries `X-Request-ID`; `/metrics` exposed.

Run locally:

```bash
cd backend
FORCE_JSON_STORAGE=1 SECRET_KEY=dev-only-secret-0123456789012345 ENVIRONMENT=test pytest -q
```

---

## I5.7 — Uptime monitoring + alerting

Probe the **public liveness** endpoint (no auth, leaks no internals — S1.11):

```
GET https://<host>/api/health        ->  {"status":"ok","service":"auto-articles"}
```

For deeper checks, operators can authenticate against readiness (live Mongo ping +
config fingerprint):

```
GET https://<host>/api/health/ready  (requires a valid access token)
```

**Recommended setup (any of these):**

| Tool | Config |
|------|--------|
| UptimeRobot / Better Uptime / Pingdom | HTTP(S) monitor on `/api/health`, interval ≤ 60s, expect `200` + body contains `"status":"ok"`; alert after 2 consecutive failures |
| Cloudflare Health Checks | Same path; region-diverse probes |
| Prometheus + Alertmanager | Alert on `up == 0`, `riviso_http_requests_total{status=~"5.."}` rate, and p95 of `riviso_http_request_duration_seconds` |

**Alert routing:** page on-call (PagerDuty/Opsgenie/Slack) on downtime; warn on elevated
5xx rate or p95 latency. Each container also has a Docker `healthcheck` hitting
`/api/health` with `restart: unless-stopped` (I3.7) for self-healing between pages.

**Suggested SLO for 50 users:** 99.5% monthly availability on `/api/health`, p95 API
latency < 1s for non-generation endpoints.
