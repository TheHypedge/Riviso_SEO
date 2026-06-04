# skills/deployment.md — Infrastructure & Deployment

## Production Infrastructure

| Component | Details |
|-----------|---------|
| Hosting | Hostinger VPS |
| VPS IP | `82.112.242.233` |
| OS | Ubuntu (Linux) |
| App directory | `/var/www/riviso` |
| Process manager | Docker Compose |
| Reverse proxy | Nginx 1.27 |
| TLS termination | Cloudflare edge / host LB (nginx receives `X-Forwarded-Proto`) |
| Database | MongoDB Atlas (external managed service) |
| Redis | Local Redis 7 container on VPS |

---

## Docker Compose Services

```
backend     → FastAPI API         port 8000    ENABLE_SCHEDULER=0, ENABLE_WORKER=0
worker      → Generation queue    (no port)    ENABLE_GENERATION_WORKER=1
scheduler   → APScheduler + reset (no port)    ENABLE_SCHEDULER=1
redis       → Redis 7             port 6379    local only (not exposed)
frontend    → Next.js 16          port 3000    profile: full
nginx       → Nginx 1.27          port 80      profile: full
```

Resource limits:
- `backend`: 768MB RAM / 1 CPU
- `worker`: 1024MB RAM / 1 CPU
- `scheduler`: 512MB RAM / 0.5 CPU
- `frontend`: 512MB RAM / 0.5 CPU

All containers restart `unless-stopped`.

---

## Deployment Procedure

### Standard deploy (new code)

```bash
# On VPS — via Hostinger terminal or SSH
cd /var/www/riviso

# Pull latest code from development branch
git pull origin development

# Rebuild and restart all containers
docker compose build --no-cache
docker compose up -d

# Verify health
docker compose ps
docker compose logs --tail=50 backend
docker compose logs --tail=50 worker
docker compose logs --tail=50 scheduler
```

### Health check after deploy
```bash
# API health endpoint
curl http://localhost:8000/api/health

# Check all containers are "healthy" (not "starting" or "unhealthy")
docker compose ps

# Tail worker for generation activity
docker compose logs -f worker
```

### Rollback
```bash
# On VPS
cd /var/www/riviso
git log --oneline -5       # find the previous commit hash
git checkout <commit-hash>
docker compose build --no-cache
docker compose up -d
```

---

## Environment Configuration

### Required files on VPS
- `/var/www/riviso/backend/.env` — contains all secrets (gitignored)

### Critical `.env` values

```bash
# Identity
ENVIRONMENT=production
APP_NAME=riviso

# Security — MUST be a long random string
SECRET_KEY=<64-char random hex>

# Database
MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net/auto_articles?retryWrites=true&w=majority"
MONGODB_DB_NAME=auto_articles

# OpenAI
OPENAI_API_KEY=sk-...

# Redis (local on VPS — do NOT use localhost; use the Docker network hostname or 127.0.0.1)
REDIS_URL=redis://127.0.0.1:6379/0
# Or if using Docker network:
# REDIS_URL=redis://redis:6379/0

# Auth cookies — IMPORTANT: leave COOKIE_DOMAIN empty
COOKIE_SECURE=true
COOKIE_DOMAIN=
COOKIE_SAMESITE=lax

# Frontend
FRONTEND_BASE_URL=https://app.riviso.com
PUBLIC_BASE_URL=https://api.riviso.cloud

# SMTP — wrap password in double quotes if it contains #
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=587
SMTP_USER=info@thehypedge.com
SMTP_PASS="Thehypedge@2025#"
SMTP_FROM="Riviso <info@thehypedge.com>"

# Google OAuth (optional — for GSC integration)
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...

# Shopify (optional)
SHOPIFY_API_KEY=...
SHOPIFY_API_SECRET=...

# Process control — set in docker-compose environment: blocks, not here
# (these are set per-container in docker-compose.yml)
ENABLE_GENERATION_WORKER=1
ENABLE_SCHEDULER=1
```

### Known `.env` pitfalls
- `COOKIE_DOMAIN` must be empty — setting it breaks cookies through Next.js proxy
- `SMTP_PASS` with `#` must be double-quoted — unquoted `#` is parsed as a comment
- `ENABLE_GENERATION_WORKER` without `=1` at end of file overrides the value set earlier
- pydantic-settings reads `backend/.env`; docker-compose `environment:` blocks are overridden by it

---

## CI/CD Pipeline

### GitHub Actions workflows

**CI** (`.github/workflows/ci.yml`):
- Triggers: PR to `main`, push to `main`, manual dispatch
- Jobs: `backend-tests` (pytest) + `frontend-tests` (lint + unit tests)
- Concurrency: cancel-in-progress for same ref

**Security** (`.github/workflows/security.yml`):
- Triggers: PR to `main`, push to `main`, weekly Monday 06:00 UTC
- Jobs: `pip-audit` (Python CVEs), `npm-audit` (JS vulnerabilities), `gitleaks` (secret scan)

### Branch strategy
```
development  ← active development, PRs merged here
main         ← production-ready; CI gate enforced; deploy source
```

PRs to `main` require CI + security checks to pass.
No automated deploy on merge — deploys are manual on the VPS.

### GitHub deploy key
`~/.ssh/gha_auto_articles_deploy` — used by GitHub Actions to clone the repo.
`~/.ssh/id_ed25519` (added to Hostinger VPS via console) — used by VPS to pull from GitHub.

---

## Nginx Configuration

`nginx/conf.d/default.conf`:
```nginx
# API traffic (long timeout for generation/publish)
location /api/ {
  proxy_pass http://backend:8000/api/;
  proxy_read_timeout 600s;     # aligned with frontend LONG_API_TIMEOUT_MS
  proxy_send_timeout 600s;
}

# All other traffic → Next.js
location / {
  proxy_pass http://frontend:3000;
}
```

HSTS is only emitted when `X-Forwarded-Proto: https` (TLS at edge).
HTTP → HTTPS redirect only when edge sets `X-Forwarded-Proto: http`.

---

## Process Architecture (Procfile Alternative)

For non-Docker deployments (Heroku, Railway, Render):

```
web:       ENABLE_SCHEDULER=0 ENABLE_GENERATION_WORKER=0 uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips=*
worker:    ENABLE_GENERATION_WORKER=1 ENABLE_SCHEDULER=0 python -m app.run_background
scheduler: ENABLE_SCHEDULER=1 ENABLE_GENERATION_WORKER=0 python -m app.run_background
```

Run `cd backend` first, then each process type.
Run exactly **1 replica** of `scheduler` — more causes double-fired jobs.
The `worker` can scale (Redis queue is shared), but 1 is sufficient for current load.

---

## Monitoring & Observability

### Prometheus metrics
```
GET /metrics
Authorization: Bearer <METRICS_TOKEN>   # if METRICS_TOKEN is set
```

Key metrics exposed by `MetricsMiddleware`:
- `http_requests_total{method, endpoint, status_code}`
- `http_request_duration_seconds{method, endpoint}`
- `generation_queue_depth` (set by worker on each poll)

### Sentry
Optional. Set `SENTRY_DSN` to enable. Both backend (`init_sentry("api")`) and
frontend (`@sentry/nextjs`) are wired.

### Log access
```bash
# View last 100 lines from all containers
docker compose logs --tail=100

# Follow worker logs (generation activity)
docker compose logs -f worker

# Backend API errors only
docker compose logs backend 2>&1 | grep ERROR
```

### Health endpoint
```
GET /api/health
```
Returns storage ping status, config fingerprint (OAuth client ID prefix for verification),
generation revision string, and Redis availability. Use this after every deploy to verify
the correct `.env` values loaded.

---

## Dependabot

`.github/dependabot.yml` is present — auto-creates PRs for dependency updates.
Security workflow catches vulnerabilities before they merge.

---

## Secrets Management

- All secrets in `backend/.env` on the VPS — never committed to git
- `.gitignore` excludes `backend/.env` and `backend/.env.production`
- Gitleaks scans full git history on every PR — will catch accidentally committed secrets
- Rotate `SECRET_KEY` by updating `.env` on VPS + restarting backend (all active sessions will be invalidated)
- Rotate `OPENAI_API_KEY` and `SMTP_PASS` in `.env` then `docker compose up -d backend` (no rebuild needed)

---

## Scaling Notes

Current: single VPS node, single replica per service.

When scaling the API:
1. Add a second `backend` instance with a load balancer in front
2. Both instances must share Redis (rate limiter is Redis-backed — correct across instances)
3. Keep `ENABLE_SCHEDULER=0` on all API instances — only the dedicated `scheduler` container runs crons
4. Keep `ENABLE_GENERATION_WORKER=0` on API instances — `worker` handles the queue

The generation queue uses Redis `LPUSH`/`BRPOP` — multiple workers can safely consume
from the same queue (each job is dequeued atomically).
