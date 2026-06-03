# Riviso — Production Runbook

> **Audience:** On-call engineer.  
> **Scope:** ~50 users, 3-process topology (API + Worker + Scheduler) on VPS / Docker Compose + MongoDB Atlas M10 + managed Redis.  
> **SLO:** 99.5 % monthly availability on `GET /api/health`; p95 < 1 s for non-generation endpoints.

---

## 1. Quick Reference

| Resource | Value |
|----------|-------|
| Production URL | `https://riviso.com` |
| API base | `https://api.riviso.com` (or same-origin at `/api`) |
| Health check | `GET /api/health` → `{"status":"ok"}` |
| Readiness check (auth required) | `GET /api/health/ready` |
| Metrics | `GET /api/metrics` (requires `METRICS_TOKEN`) |
| Logs | `docker compose logs -f --tail=200 backend worker scheduler` |
| Atlas console | MongoDB Atlas M10 cluster dashboard |
| Redis console | Upstash / ElastiCache dashboard |

### Process inventory

| Container | Role | Key env flags |
|-----------|------|---------------|
| `backend` | FastAPI HTTP API | `ENABLE_SCHEDULER=0 ENABLE_GENERATION_WORKER=0` |
| `worker` | Generation queue consumer | `ENABLE_GENERATION_WORKER=1 ENABLE_SCHEDULER=0` |
| `scheduler` | Scheduled publish + daily reset | `ENABLE_SCHEDULER=1 ENABLE_GENERATION_WORKER=0` |
| `frontend` | Next.js SSR | — |
| `nginx` | Reverse proxy / TLS | — |
| `redis` | Queue + pub/sub | AOF persistence |

---

## 2. On-Call Escalation

```
Alert fires
  → Check /api/health first (10 s)
  → Check container status: docker compose ps
  → Check recent logs: docker compose logs --tail=200 <service>
  → Check Atlas metrics (connections, operation time)
  → Check Redis (queue depth at /metrics: riviso_generation_queue_depth)
  → If unable to resolve in 15 min → escalate to primary engineer
```

### Alert severity matrix

| Alert | Severity | First action |
|-------|----------|-------------|
| `/api/health` returns non-200 for 2+ min | P1 | Restart `backend` container |
| 5xx rate > 5 % for 5 min | P1 | Check logs; check Atlas connectivity |
| Queue depth > 50 for 10 min | P2 | Check worker container; restart if needed |
| p95 latency > 3 s for 10 min | P2 | Check Atlas operation time; check thread pool |
| Worker container exited | P2 | Restart; check generation_errors metric |
| Scheduler container exited | P2 | Restart; check scheduled_jobs for stuck states |
| Atlas CPU > 80 % sustained | P2 | Review slow queries; notify primary |
| Redis memory > 80 % | P3 | Check queue depth; clear stale dedup keys if needed |
| Certificate expiry < 14 days | P3 | Renew via Certbot / Cloudflare |

---

## 3. Common Operations

### 3.1 Restart a container

```bash
docker compose restart backend
docker compose restart worker
docker compose restart scheduler
docker compose restart frontend
```

Verify after restart:
```bash
docker compose ps
curl -sf https://api.riviso.com/api/health | python3 -m json.tool
```

### 3.2 Deploy a new release (zero-downtime, 2 API instances)

```bash
git pull origin main

# Build new images
docker compose build backend frontend

# Rolling restart: API first, then workers
docker compose up -d --no-deps --scale backend=2 backend
sleep 30
docker compose up -d --no-deps backend
docker compose up -d --no-deps worker scheduler frontend nginx
```

Smoke test after deploy:
```bash
curl -sf https://api.riviso.com/api/health
curl -sf https://riviso.com | grep -c "Riviso"
```

### 3.3 View and follow logs

```bash
# All services
docker compose logs -f --tail=100

# Single service
docker compose logs -f --tail=200 backend
docker compose logs -f --tail=200 worker

# Filter for errors
docker compose logs --tail=500 backend | grep '"level":"error"'

# Trace a specific request by ID (from X-Request-ID header)
docker compose logs --tail=5000 backend worker | grep '"request_id":"<id>"'
```

### 3.4 Check generation queue depth

```bash
# Via metrics endpoint
curl -H "Authorization: Bearer $METRICS_TOKEN" https://api.riviso.com/metrics \
  | grep riviso_generation_queue_depth

# Via Redis CLI
docker compose exec redis redis-cli llen aa:generation:queue
```

### 3.5 Clear a stuck generation dedup key

If a job is permanently stuck in "queued" and won't re-enqueue:

```bash
# Find the dedup key for an article
docker compose exec redis redis-cli keys "aa:generation:dedup:*"

# Delete it to allow re-enqueue
docker compose exec redis redis-cli del "aa:generation:dedup:<article_id>"
```

### 3.6 Reset a stuck scheduled job

If a job is stuck in `content_generating` or `posting` state for > 5 min:

```javascript
// Run in Atlas Data Explorer or mongosh
db.scheduled_jobs.updateOne(
  { id: "<job_id>" },
  { $set: { state: "scheduled", last_error: "", updated_at: new Date().toISOString() } }
)
```

Then the scheduler loop will pick it up on the next 10-second tick.

### 3.7 Manually trigger a subscription daily reset

If the daily article quota counter was not reset (scheduler outage over midnight):

```bash
# Access the running scheduler container
docker compose exec scheduler python3 -c "
from app.legacy.storage import get_legacy_storage_module
st = get_legacy_storage_module()
n = st.reset_daily_subscription_usage()
print('Reset', n, 'subscriptions')
"
```

### 3.8 Check MongoDB connectivity

```bash
docker compose exec backend python3 -c "
from app.services.storage_db import ping_storage
ping_storage()
print('Mongo OK')
"
```

### 3.9 Rotate the JWT signing secret

1. Generate a new secret: `python3 -c "import secrets; print(secrets.token_hex(32))"`
2. Update `SECRET_KEY` in the secret manager / `.env`.
3. Restart all containers: `docker compose up -d`.
4. **Effect:** All existing sessions are immediately invalidated. Users must log in again.

### 3.10 Check for and handle a MongoDB Atlas connection storm

Symptom: `connection pool timeout` errors in logs; Atlas connection graph spikes.

```bash
# Check per-process maxPoolSize sums < Atlas M10 limit (500)
# API:        maxPoolSize=20 × 2 instances = 40
# Worker:     maxPoolSize=10
# Scheduler:  maxPoolSize=10
# Total:      60 — well under 500

# If spiking, find which container is holding connections
docker compose exec backend python3 -c "
from app.services.storage_db import ping_storage; ping_storage()
print('backend OK')
"
```

---

## 4. Incident Response

### 4.1 Full outage (health returns non-200)

```
1. Check nginx: docker compose ps nginx
   → If down: docker compose restart nginx; wait 10 s; re-check health

2. Check backend: docker compose ps backend
   → If exited: docker compose logs --tail=50 backend
   → Look for startup failure (bad SECRET_KEY, Mongo refused connection)
   → Fix env, then: docker compose start backend

3. Check MongoDB Atlas
   → Is the cluster in PRIMARY state?
   → Are there active connections from the VPS IP?
   → IP allowlist may have changed — re-add VPS IP in Atlas Network Access

4. If backend starts but crashes repeatedly:
   → Check for missing env vars (OPENAI_API_KEY, MONGODB_URI, SECRET_KEY)
   → docker compose exec backend env | grep -E "MONGODB|SECRET|OPENAI"
```

### 4.2 Elevated 5xx rate (not full outage)

```
1. Identify the failing route:
   docker compose logs --tail=500 backend | grep '"status":5'

2. Common causes and fixes:
   a. MongoDB transient timeout → call_storage retries handle it; wait 60 s
   b. OpenAI rate limit on generation → 429 from OpenAI; queue backs up; check worker logs
   c. Unhandled exception in a new deploy → rollback: docker compose up -d <previous image>

3. If Mongo is the cause, check Atlas:
   → Slow query log (> 100 ms)
   → Current Op for blocking operations
   → Replica set health
```

### 4.3 Generation backlog building

```
Symptom: riviso_generation_queue_depth > 20 sustained

1. Check worker container:
   docker compose ps worker
   docker compose logs --tail=100 worker

2. If worker is running but slow:
   → Check OpenAI API status (status.openai.com)
   → Check MAX_CONCURRENT_GENERATIONS env (default 3) — may need increase

3. If worker is crashed:
   docker compose restart worker
   → Monitor: docker compose logs -f worker

4. Extreme backlog (> 100 jobs): inform users via status page
```

### 4.4 Scheduled post failed to publish

```
1. Find the job in Atlas:
   db.scheduled_jobs.findOne({ id: "<job_id>" })

2. Check last_error field for the failure reason

3. Common causes:
   - WordPress credentials changed → user must re-verify in project settings
   - WordPress media 403 → user's WP user needs upload_files permission
   - OpenAI key missing → check OPENAI_API_KEY env

4. Retry the job:
   - Via UI: user clicks "Retry preparation" button
   - Via DB: set state="scheduled" (see 3.6 above)
```

---

## 5. Environment Variables — Production Checklist

Verify all of these are set before going live (`GET /api/health/ready` shows openai_configured and gsc_oauth_configured):

```
SECRET_KEY                         # min 32 chars, never a placeholder
ENVIRONMENT=production
MONGODB_URI                        # Atlas M10 connection string with TLS
REDIS_URL                          # managed Redis with auth (rediss://)
OPENAI_API_KEY
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
SHOPIFY_API_KEY
SHOPIFY_API_SECRET
COOKIE_SECURE=true
CORS_ORIGINS=https://riviso.com,https://www.riviso.com
METRICS_TOKEN                      # protect /metrics endpoint
SENTRY_DSN                         # error tracking
ENABLE_SCHEDULER=0                 # on API container
ENABLE_GENERATION_WORKER=0         # on API container
ENABLE_SCHEDULER=1                 # on scheduler container
ENABLE_GENERATION_WORKER=1         # on worker container
```

Frontend:
```
NEXT_PUBLIC_API_BASE_URL=https://api.riviso.com
NEXT_PUBLIC_SENTRY_DSN
SENTRY_DSN
NODE_ENV=production
```

---

## 6. Monitoring Reference

### Prometheus alert rules (suggested)

```yaml
groups:
  - name: riviso
    rules:
      - alert: RivisoDown
        expr: up{job="riviso-api"} == 0
        for: 2m
        labels:
          severity: critical

      - alert: RivisoHigh5xxRate
        expr: >
          rate(riviso_http_requests_total{status=~"5.."}[5m])
          / rate(riviso_http_requests_total[5m]) > 0.05
        for: 5m
        labels:
          severity: warning

      - alert: RivisoHighLatency
        expr: >
          histogram_quantile(0.95,
            rate(riviso_http_request_duration_seconds_bucket[5m])
          ) > 3
        for: 10m
        labels:
          severity: warning

      - alert: RivisoQueueDepthHigh
        expr: riviso_generation_queue_depth > 50
        for: 10m
        labels:
          severity: warning
```

### Uptime probe

- **Tool:** UptimeRobot / Better Uptime / Pingdom
- **URL:** `https://api.riviso.com/api/health`
- **Interval:** 60 s
- **Condition:** HTTP 200 + body contains `"status":"ok"`
- **Alert:** after 2 consecutive failures → PagerDuty / Slack

---

## 7. Post-Incident Checklist

After any P1 incident:

- [ ] Timeline documented (start → detection → resolution)
- [ ] Root cause identified
- [ ] Fix merged or tracked as issue
- [ ] Runbook updated if a new failure mode was discovered
- [ ] Atlas / Redis / Sentry dashboards reviewed for secondary effects
- [ ] Users notified if data was affected or access was degraded > 5 min
