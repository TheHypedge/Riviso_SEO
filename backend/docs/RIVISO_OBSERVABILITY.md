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

---

## I5.8 — APM + Real User Monitoring (New Relic)

Full request/transaction tracing (APM, backend) and real-user page/AJAX/error
monitoring (Browser, frontend), layered on top of Sentry (errors) and
Prometheus (SLO metrics) — same **opt-in via env** contract: with no key set,
neither agent loads.

### Backend — APM

| Process | Command | Enable with |
|---------|---------|-------------|
| API (`uvicorn app.main:app`) | wrapped by `backend/docker-entrypoint.sh` | `NEW_RELIC_LICENSE_KEY` |
| Worker (`python -m app.run_background`) | same entrypoint | `NEW_RELIC_LICENSE_KEY` |
| Scheduler (`python -m app.run_background`) | same entrypoint | `NEW_RELIC_LICENSE_KEY` |

`docker-entrypoint.sh` prefixes the container's `CMD` with `newrelic-admin
run-program` only when `NEW_RELIC_LICENSE_KEY` is present — with it unset,
`docker compose up --build` behaves exactly as before New Relic was added
(no agent import, no startup overhead). `backend/newrelic.ini` is checked in
with a placeholder `license_key`; the env var always takes precedence, so the
file never carries a secret.

FastAPI/Starlette web transactions are captured **automatically** by the
agent's import hooks — no code changes. httpx, pymongo, and redis calls
(OpenAI, MongoDB, the generation queue) are auto-instrumented too, so a
traced request shows its full downstream fan-out.

The worker and scheduler loops are plain asyncio (no web framework), so they
get no automatic transactions. Two entry points are wrapped explicitly with
`app/core/apm.py`'s `@background_task()`:

- `process_generation_job()` (`app/services/generation_worker.py`) — one
  transaction per dequeued job, renamed by kind
  (`generation/article_generate`, `generation/image_regenerate`, …).
- `execute_scheduled_job_post_now()` (`app/services/scheduler.py`) — one
  transaction per scheduled WordPress/Shopify publish.

Each container reports as its **own APM entity** (`Riviso API`, `Riviso
Worker`, `Riviso Scheduler` — set via `NEW_RELIC_APP_NAME` per service in
`docker-compose.yml`) rather than one entity with API and background
throughput conflated.

**`newrelic.ini` must never contain a literal `license_key` or `app_name`
line, even a placeholder.** The Python agent's ini loader overwrites its
env-var-derived settings with whatever's literally written in the file —
there is no `%(VAR)s` interpolation and no "env var wins" behavior, despite
that being the intuitive assumption (it was this repo's original, wrong
assumption, caught only after a real license key was rejected twice with
`newrelic.agent.global_settings()` showing the agent was actually sending
the ini's placeholder text as the license key, silently, the whole time).
Both settings are sourced exclusively from `NEW_RELIC_LICENSE_KEY`
(`backend/.env`) and `NEW_RELIC_APP_NAME` (`docker-compose.yml`, per
service) — see the top-of-file comment in `newrelic.ini` before touching
either of those two keys.

To add a new instrumented background entry point, decorate it:

```python
from app.core.apm import background_task

@background_task(name="my_new_job", group="SomeGroup")
async def my_new_job(...): ...
```

### Frontend — Browser (RUM)

`frontend/instrumentation-client.ts` initialises `@newrelic/browser-agent`'s
`browser-agent` loader (New Relic's "Pro + SPA" feature set — tracks
client-side route changes between Next.js pages, not just the first page
load) when all three are set:

- `NEXT_PUBLIC_NEW_RELIC_ACCOUNT_ID`
- `NEXT_PUBLIC_NEW_RELIC_LICENSE_KEY` (Browser's key is meant to be public —
  it ships in every visitor's JS bundle and can only submit RUM data, unlike
  the backend APM license key, which is a real secret and stays out of any
  `NEXT_PUBLIC_*`/committed file)
- `NEXT_PUBLIC_NEW_RELIC_APP_ID`

Set these in the Vercel project's environment variables (Production +
Preview) — there is no `frontend/.env.example` in this repo (Sentry's
frontend vars aren't templated there either); for local dev, put them in a
gitignored `frontend/.env.local`.

The npm-package loader ships as part of our own JS bundle (webpack), unlike
the copy/paste `<script src="https://js-agent.newrelic.com/...">` snippet —
so no `script-src` CSP change was needed. `next.config.ts`'s `connect-src`
was extended with New Relic's beacon hosts (`bam.nr-data.net`,
`bam-cell.nr-data.net`) so the agent's background POSTs aren't blocked by CSP.

### Linking browser to backend (end-to-end traces)

In the New Relic UI, open the `Riviso API` APM entity → **Add data** →
**Browser** → link (or create) the Browser app, using the same account. With
`distributed_tracing.enabled` on both sides (already set in `newrelic.ini`
and `instrumentation-client.ts`), a single trace can be followed from a
browser page load/click through the API request into the OpenAI/Mongo/
WordPress calls it triggers.
