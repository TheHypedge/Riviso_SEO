# Riviso — Production Deployment Guide

> **Goal:** Take a fresh VPS from zero to a production-ready, 50-user Riviso deployment.  
> **Time to first deploy:** ~90 min.  
> **Prerequisites:** A Linux VPS (Ubuntu 22.04 LTS, 4 GB RAM min), a domain pointed at it, Docker + Docker Compose v2 installed.

---

## 1. Infrastructure provisioning (I3.2 / I3.3)

### 1.1 MongoDB Atlas M10

1. Create an Atlas account at [cloud.mongodb.com](https://cloud.mongodb.com).
2. Create a new Project → **Build a Cluster** → select **M10 Dedicated**.
3. Region: same as or nearest to your VPS.
4. Cluster name: `riviso-prod`.
5. **Security → Database Access**: create a user, e.g. `riviso_app` with `readWrite` on `auto_articles`.  
   Copy the password — you'll need it in the connection string.
6. **Security → Network Access**: add your VPS IP (and your local IP for admin access).
7. **Connect → Drivers** → copy the connection string:
   ```
   mongodb+srv://riviso_app:<password>@riviso-prod.xxxxx.mongodb.net/auto_articles?retryWrites=true&w=majority
   ```
8. **Backup**: enable **Continuous Cloud Backup** (M10 includes daily snapshots + point-in-time restore for 7 days).

### 1.2 Managed Redis (I3.3)

**Option A — Upstash (recommended for simplicity)**
1. Create an account at [upstash.com](https://upstash.com).
2. Create a Redis database → region same as VPS → **TLS enabled**.
3. Copy the `rediss://` connection string from the dashboard.

**Option B — AWS ElastiCache (if already on AWS)**
1. Create a Redis Cluster (cache.t4g.small) → enable in-transit encryption.
2. Copy the endpoint URL → prepend `rediss://`.

---

## 2. VPS setup

```bash
# 1. Clone the repo
git clone <your-repo-url> /opt/riviso
cd /opt/riviso

# 2. Install Docker + Compose (if not already installed)
curl -fsSL https://get.docker.com | sh
sudo apt-get install -y docker-compose-plugin

# 3. Add your user to docker group (re-login after)
sudo usermod -aG docker $USER
```

---

## 3. Secrets & environment (I3.9)

Create `backend/.env` — this is the only secret file; never commit it.

```bash
cat > /opt/riviso/backend/.env << 'EOF'
# ── Core ──────────────────────────────────────────────────────────────────
ENVIRONMENT=production
APP_NAME=auto-articles

# Generate: python3 -c "import secrets; print(secrets.token_hex(32))"
SECRET_KEY=<64-hex-char-random-string>

# ── Database ──────────────────────────────────────────────────────────────
MONGODB_URI=mongodb+srv://riviso_app:<pass>@riviso-prod.xxxxx.mongodb.net/auto_articles?retryWrites=true&w=majority
MONGODB_DB_NAME=auto_articles
MONGODB_MAX_POOL_SIZE=50
MONGODB_MIN_POOL_SIZE=2

# ── Redis ─────────────────────────────────────────────────────────────────
REDIS_URL=rediss://<upstash-endpoint>:6380

# ── OpenAI ────────────────────────────────────────────────────────────────
OPENAI_API_KEY=sk-...

# ── Auth / Cookies ────────────────────────────────────────────────────────
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
# Set COOKIE_DOMAIN if API and frontend share a root domain, e.g. .riviso.com
# COOKIE_DOMAIN=.riviso.com

# ── CORS ──────────────────────────────────────────────────────────────────
CORS_ORIGINS=https://riviso.com,https://www.riviso.com

# ── Google OAuth (Search Console) ─────────────────────────────────────────
GOOGLE_OAUTH_CLIENT_ID=<from-google-cloud-console>
GOOGLE_OAUTH_CLIENT_SECRET=<from-google-cloud-console>

# ── Shopify ───────────────────────────────────────────────────────────────
SHOPIFY_API_KEY=<from-shopify-partners-dashboard>
SHOPIFY_API_SECRET=<from-shopify-partners-dashboard>

# ── Email (SMTP) ──────────────────────────────────────────────────────────
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=noreply@riviso.com
SMTP_PASS=<smtp-password>
SMTP_FROM=Riviso <noreply@riviso.com>
FRONTEND_BASE_URL=https://riviso.com

# ── Generation queue ──────────────────────────────────────────────────────
MAX_CONCURRENT_GENERATIONS=3
GENERATION_QUEUE_ENABLED=true

# ── Observability ─────────────────────────────────────────────────────────
SENTRY_DSN=https://<key>@sentry.io/<project>
METRICS_TOKEN=<random-token-for-metrics-endpoint>

# ── Bootstrap admin (one-time; remove after first login) ─────────────────
# BOOTSTRAP_ADMIN_EMAIL=admin@yourcompany.com
# BOOTSTRAP_ADMIN_PASSWORD=<strong-password>
EOF
```

**Next.js env** (create `frontend/.env.production`):

```bash
cat > /opt/riviso/frontend/.env.production << 'EOF'
NEXT_PUBLIC_API_BASE_URL=https://api.riviso.com
NEXT_PUBLIC_SENTRY_DSN=https://<key>@sentry.io/<project>
SENTRY_DSN=https://<key>@sentry.io/<project>
SENTRY_ORG=<your-sentry-org>
SENTRY_PROJECT=<your-sentry-project>
EOF
```

> **Tip:** For a production secret manager, use Doppler or AWS SSM and inject secrets at container start — never check `.env` files into git.

---

## 4. TLS certificate (I3.5)

```bash
# Install Certbot
sudo apt-get install -y certbot

# Issue wildcard cert (DNS challenge) or per-domain cert (HTTP challenge)
sudo certbot certonly --standalone -d riviso.com -d www.riviso.com -d api.riviso.com

# Certs are at: /etc/letsencrypt/live/riviso.com/
```

Update `nginx/conf.d/default.conf` to add TLS listeners and point to the cert files, or place Nginx TLS termination in front using Certbot's nginx plugin.

---

## 5. First deploy

```bash
cd /opt/riviso

# Build images (takes 3–5 min first time)
docker compose -f docker-compose.yml build

# Start all services (full profile = includes nginx + frontend)
docker compose --profile full up -d

# Check status
docker compose ps

# Tail logs for the first 30s
docker compose logs -f --tail=50
```

### Verify startup

```bash
# Liveness
curl -sf http://localhost:8000/api/health | python3 -m json.tool
# Expected: {"status":"ok","service":"auto-articles"}

# Check Mongo connected (requires admin JWT)
# Get token from login first, then:
curl -sf -H "Authorization: Bearer <token>" http://localhost:8000/api/health/ready
# Expected: {"database_ok":true,...}
```

### Bootstrap the admin user (first run only)

Uncomment `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` in `backend/.env`, restart backend, log in, then re-comment them and restart again.

```bash
docker compose restart backend
# Log in at https://riviso.com/login
# Re-comment the BOOTSTRAP lines, then:
docker compose restart backend
```

---

## 6. Connection pool sizing (I3.6)

With the default `MONGODB_MAX_POOL_SIZE=50` per process, the combined pool across all containers is:

| Container | Instances | Pool/instance | Total |
|-----------|-----------|---------------|-------|
| `backend` | 1 (or 2) | 50 | 50–100 |
| `worker` | 1 | 50 | 50 |
| `scheduler` | 1 | 50 | 50 |
| **Total** | | | **150–200** |

Atlas M10 supports **~1,500 connections** — well under the limit. If you scale to more instances, lower `MONGODB_MAX_POOL_SIZE` accordingly so the sum stays below 1,000.

---

## 7. Scaling to 2 API instances (I3.8)

```bash
# Run 2 API replicas with Nginx load balancing
docker compose up -d --scale backend=2

# Verify both are healthy
docker compose ps backend
```

**Required:** `REDIS_URL` must point to managed Redis (not container-local Redis) so rate limits and the generation queue are shared across both API instances.

**Note:** Keep `scheduler` at exactly 1 replica — running multiple schedulers will create duplicate WordPress posts.

---

## 8. Secrets rotation

### JWT signing key

```bash
# Generate new key
NEW_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
echo "New SECRET_KEY: $NEW_KEY"

# Update backend/.env SECRET_KEY=<new-key>
# Restart all containers — all active sessions are invalidated (users re-login)
docker compose restart backend worker scheduler
```

### SMTP password / API keys

Update the value in `backend/.env` and restart the affected container only:
```bash
docker compose restart backend
```

---

## 9. Post-deploy verification checklist

Run after every production deploy:

- [ ] `GET /api/health` returns `{"status":"ok"}` — liveness OK
- [ ] `GET /api/health/ready` returns `database_ok: true` — Mongo connected
- [ ] `/api/metrics` returns Prometheus metrics (with `METRICS_TOKEN`)
- [ ] Login works; `GET /api/auth/me` returns the user
- [ ] Create a test project; article list loads
- [ ] `POST /api/projects/{id}/articles/{id}/generate` returns 202 (queued)
- [ ] Worker logs show job received + generated
- [ ] Sentry: trigger a test error and confirm it appears in the dashboard
- [ ] Uptime monitor shows green

---

## 10. Ongoing maintenance

| Task | Frequency | Command |
|------|-----------|---------|
| Rotate Let's Encrypt cert | Auto (certbot timer) | `sudo certbot renew --dry-run` to test |
| Review Atlas slow queries | Weekly | Atlas Performance Advisor |
| DR restore drill | Quarterly | See `RIVISO_DR_DRILL.md` |
| Dependency updates | Weekly | Dependabot PRs auto-created |
| Secret rotation | Quarterly | See §8 |
| Load test | Pre-release | `k6 run backend/docs/load_tests/k6_load_test.js` |
| Security re-scan | Pre-release | `pip-audit -r backend/requirements.txt` |

---

## 11. Atlas backup verification (I3.4)

1. Atlas UI → your cluster → **Backup** → confirm snapshots are listed daily.
2. Confirm **Continuous Cloud Backup** is enabled for point-in-time restore.
3. Run the DR drill (see `RIVISO_DR_DRILL.md`) quarterly.

---

## 12. Monitoring quick-start (I5.2 / I5.7)

**Prometheus scrape config:**
```yaml
scrape_configs:
  - job_name: riviso-api
    metrics_path: /metrics
    authorization:
      credentials: <METRICS_TOKEN>
    static_configs:
      - targets: ["api.riviso.com:443"]
    scheme: https
```

**Uptime robot / Better Uptime:**
- URL: `https://api.riviso.com/api/health`
- Method: GET
- Expected: HTTP 200 + body contains `"status":"ok"`
- Alert after: 2 consecutive failures

**Suggested Grafana panels:**
- `riviso_http_requests_total` by status code (5xx alert)
- `riviso_http_request_duration_seconds` p95 (latency)
- `riviso_generation_queue_depth` (queue health)
