# Riviso — Disaster Recovery Drill Procedure (L6.4)

> **Goal:** Verify that a full restore from MongoDB Atlas backup can bring the platform back to a working state within the RTO/RPO targets.  
> **RTO target:** < 2 hours (time from incident declaration to users able to log in and read data).  
> **RPO target:** < 24 hours of data loss (Atlas M10 continuous backup captures snapshots every day; point-in-time recovery is available for the last 7 days on M10+).  
> **Frequency:** Run this drill at least once per quarter.  
> **Who:** Primary engineer + one backup engineer observing.

---

## 1. Disaster Scenarios Covered

| Scenario | Recovery approach |
|----------|------------------|
| Accidental `db.articles.drop()` | Point-in-time restore from Atlas to a new cluster |
| Corrupted collection (bad migration) | Selective restore via Atlas cloud backup + `mongorestore` |
| Full cluster failure | Promote replica or restore snapshot to a new M10 |
| VPS total loss (data intact in Atlas) | Redeploy containers; reconnect to existing Atlas cluster |
| Redis total loss | Redis is ephemeral cache/queue; restart and re-drain queue from DB state |

---

## 2. Before the Drill — Preparation Checklist

- [ ] Notify team that a DR drill is in progress (set status page to "Maintenance")
- [ ] Confirm Atlas M10 has at least one backup snapshot from the last 24 hours
  - Atlas UI → Clusters → your cluster → **Backup** tab → verify snapshot list
- [ ] Confirm you have Atlas project owner credentials (required for restore)
- [ ] Confirm you have VPS SSH access or Docker host access
- [ ] Note the **current document counts** as the baseline to verify restore:
  ```bash
  docker compose exec backend python3 -c "
  from database import get_db
  db = get_db()
  print('users:',        db.users.count_documents({}))
  print('projects:',     db.projects.count_documents({}))
  print('articles:',     db.articles.count_documents({}))
  print('scheduled_jobs:', db.scheduled_jobs.count_documents({}))
  print('subscriptions:', db.subscriptions.count_documents({}))
  "
  ```

---

## 3. DR Drill Steps

### Step 1 — Choose the restore point (< 5 min)

1. Open Atlas UI → **Clusters** → your cluster → **Backup**.
2. Select the most recent daily snapshot (or a point-in-time within the last 7 days).
3. Click **Restore** → choose **Restore to new cluster** (never restore over the live cluster during a drill).
4. Name the cluster `riviso-dr-drill-YYYYMMDD`.
5. Select M10 tier, same region as production.
6. Click **Restore**. Atlas will email when complete (typically 5–15 min).

### Step 2 — Verify the restored cluster (< 10 min)

Once the cluster is ready:

1. In Atlas, go to the new cluster → **Connect** → get the connection string.
2. Open Atlas Data Explorer for `riviso-dr-drill-YYYYMMDD`:
   - Verify all collections exist: `users`, `projects`, `articles`, `scheduled_jobs`, `subscriptions`, `plans`
   - Compare document counts to the baseline noted in Preparation.
3. Spot-check one user document and one article document to confirm data integrity.

**Pass criteria:** Document counts match baseline (within RPO window); no collection is empty.

### Step 3 — Test connectivity from the application (< 10 min)

Create a temporary `docker-compose.dr.yml` override with the restored cluster URI:

```yaml
# docker-compose.dr.yml
services:
  backend:
    environment:
      MONGODB_URI: "mongodb+srv://<user>:<pass>@riviso-dr-drill-YYYYMMDD.mongodb.net/auto_articles?retryWrites=true&w=majority"
      ENVIRONMENT: "development"   # disable prod-only checks for the drill
```

Start a test backend container:
```bash
docker compose -f docker-compose.yml -f docker-compose.dr.yml up -d backend
sleep 15

# Health check
curl -sf http://localhost:8000/api/health | python3 -m json.tool

# Readiness check (use a known admin JWT from the restored cluster)
curl -sf -H "Authorization: Bearer <admin_token>" http://localhost:8000/api/health/ready \
  | python3 -m json.tool
```

**Pass criteria:** `health` returns `status: ok`; `health/ready` returns `database_ok: true`.

### Step 4 — End-to-end smoke test (< 15 min)

With the DR backend running against the restored cluster:

```bash
BASE=http://localhost:8000

# 1. Login
LOGIN=$(curl -sf -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"<known_user>","password":"<password>"}')
echo $LOGIN | python3 -m json.tool
TOKEN=$(echo $LOGIN | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# 2. List projects
curl -sf -H "Authorization: Bearer $TOKEN" "$BASE/api/projects" | python3 -m json.tool

# 3. List articles for first project
PROJECT=$(curl -sf -H "Authorization: Bearer $TOKEN" "$BASE/api/projects" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id']) if d else print('')")
curl -sf -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/$PROJECT/articles?page=1&per_page=5" \
  | python3 -m json.tool
```

**Pass criteria:** Login succeeds; projects and articles are returned with expected data.

### Step 5 — Record the results

Fill in the drill log table at the end of this document.

### Step 6 — Teardown

```bash
# Stop the DR test container
docker compose -f docker-compose.yml -f docker-compose.dr.yml down

# Delete the DR drill cluster in Atlas
# Atlas UI → Clusters → riviso-dr-drill-YYYYMMDD → ... → Terminate
```

---

## 4. Full VPS Failover Procedure (non-drill — real incident)

If the VPS is lost but Atlas data is intact:

```
1. Provision a new VPS (same spec: 4 GB RAM minimum).

2. Install Docker + Docker Compose.

3. Clone the repo:
   git clone <repo_url>
   cd auto-articles

4. Restore secrets:
   - Copy .env from secret manager / password vault to the VPS.
   - Verify all required vars are present (see Runbook §5).

5. Point DNS (Cloudflare / registrar):
   - Update A record for api.riviso.com → new VPS IP.
   - TTL: 60 s (reduce before any planned failover; roll back after).

6. Start services:
   docker compose up -d

7. Verify:
   curl -sf https://api.riviso.com/api/health
   # (allow 60 s for DNS to propagate)

8. Monitor for 30 min; watch logs for errors.
```

**Estimated RTO for full VPS failover:** 45–90 min (provisioning + DNS TTL dominate).

---

## 5. Redis Recovery

Redis stores the generation job queue and SSE pub/sub channels. It has AOF persistence enabled, but a total Redis loss is designed to be non-catastrophic:

- **Queue loss:** Generation jobs in-flight are lost. Users must re-trigger generation (article state is unchanged in Mongo).
- **Pub/sub loss:** Any live SSE streams disconnect; browser auto-reconnects on next action.
- **Rate-limit counters:** Reset to zero; brief window of unlimited requests acceptable.

**Recovery:**
```bash
docker compose restart redis
# Queue drains naturally as users re-trigger; no manual intervention needed.
```

---

## 6. Drill Log

Record each quarterly drill run here.

| Date | Engineer | Snapshot used | Restore time | Health check | E2E pass | Doc counts matched | Notes |
|------|----------|---------------|-------------|--------------|----------|--------------------|-------|
| YYYY-MM-DD | | | min | ✓/✗ | ✓/✗ | ✓/✗ | |
| YYYY-MM-DD | | | min | ✓/✗ | ✓/✗ | ✓/✗ | |
| YYYY-MM-DD | | | min | ✓/✗ | ✓/✗ | ✓/✗ | |

---

## 7. Definition of Done for This Drill (L6.4)

- [ ] Restore from Atlas snapshot completed without errors
- [ ] `GET /api/health/ready` returns `database_ok: true` against restored cluster
- [ ] Login + list projects + list articles all succeed with real data
- [ ] Document counts match the baseline (within RPO window)
- [ ] DR test cluster terminated after drill
- [ ] Drill log entry filled in above
- [ ] Any gaps found during the drill tracked as issues
