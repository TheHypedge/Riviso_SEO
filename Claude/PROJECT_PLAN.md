# PROJECT_PLAN.md — Riviso Platform Roadmap

## Current State (as of 2026-06-04)

Riviso is live in production at `app.riviso.com`. The platform is in **beta** — users
have trial subscriptions with `trial_end_date` enforcement. Core generation, scheduling,
WordPress/Shopify publishing, and content optimization features are all operational.

---

## Current Goals

1. **Stability** — reduce production errors; all known critical bugs are fixed
2. **Content Quality** — AEO/GEO/SEO optimization profiles now injected into generation
3. **User Control** — humanization guardrails are now configurable per project
4. **Observability** — Prometheus metrics + Sentry error tracking are wired but need tuning
5. **Billing** — subscription/plan system is in place; payment integration is the next gap

---

## Completed Milestones

- [x] Core article generation pipeline (OpenAI GPT-4.1-mini)
- [x] Featured image generation (gpt-image-1)
- [x] Multi-project workspace per user
- [x] WordPress REST API publishing + verification
- [x] Shopify blog publishing + OAuth
- [x] Scheduled article publishing (APScheduler + Redis queue)
- [x] Bulk article upload (XLSX)
- [x] Topic cluster planning + generation (LLM-driven)
- [x] Custom research ideas (Google Search Console + web scraper)
- [x] AI humanization pipeline (RIVISO multi-pass)
- [x] AEO/GEO/SEO/E-E-A-T content optimization profiles (per-project)
- [x] Configurable humanization guardrails (target AI%, strength preset, passes)
- [x] JWT auth (cookie + Bearer) with refresh token rotation
- [x] Email verification flow + password reset
- [x] Trial subscription enforcement via PlanLimitsMiddleware
- [x] Rate limiting (SlowAPI, Redis-backed, per-user + per-IP)
- [x] CSRF protection middleware
- [x] Security headers on all responses
- [x] CI pipeline (GitHub Actions: pytest + ESLint + unit tests)
- [x] Security pipeline (pip-audit + npm audit + gitleaks)
- [x] Google Search Console integration (URL inspection + indexing API)
- [x] Internal link injection (WordPress site-map aware)
- [x] Article rank monitoring + smart refresh trigger
- [x] Prometheus metrics endpoint + Sentry integration
- [x] Docker Compose multi-container topology (API / worker / scheduler / Redis)

---

## Active Development (In Progress)

- [ ] Featured image regeneration stability (permissions fix merged; monitoring)
- [ ] Generation error surface — `generation_error` field now persisted; frontend displays it
- [ ] Admin dashboard — user listing, workspace viewer, plan management
- [ ] Subscription plan management UI (users cannot self-serve plan upgrades yet)

---

## Roadmap

### Near-term (1–4 weeks)
- [ ] **Payment integration** — Stripe or Paddle; connect to `subscription_type` field
- [ ] **Plan upgrade UI** — current `TrialUpgradeModal` links out; needs in-app flow
- [ ] **Admin iamakhileshsoni@gmail.com** — restore admin MongoDB account
- [ ] **Cluster bulk-schedule** — `BulkScheduleModal` is built; wire to scheduler endpoint
- [ ] **Generation retry UI** — show `generation_error` in article list with a retry button

### Medium-term (1–3 months)
- [ ] **Multi-user workspaces** — invite team members to a project
- [ ] **White-label / agency tier** — custom domain per workspace
- [ ] **Content calendar view** — visualize scheduled articles across projects
- [ ] **Shopify product-aware generation** — inject product catalog context into prompts
- [ ] **GSC keyword gap analysis** — suggest articles based on ranking opportunities
- [ ] **Automatic internal linking** — auto-inject internal links post-generation

### Long-term
- [ ] **PostgreSQL migration** — current primary is MongoDB; PostgreSQL schema is defined
  in `backend/app/repositories/` but not yet the primary data store
- [ ] **Horizontal scaling** — Redis-backed queue + rate limiter is ready; Nginx LB config needed
- [ ] **Multi-region** — VPS currently single-node; Atlas is multi-region capable
- [ ] **Plugin marketplace** — Riviso WordPress plugin currently downloaded as a zip

---

## Known Gaps

| Gap | Impact | Notes |
|-----|--------|-------|
| No payment processor | Critical for post-beta | Trial enforcement exists; payment integration is missing |
| Admin MongoDB account deleted | High (ops) | `iamakhileshsoni@gmail.com` needs recreation in Atlas |
| No automated deployment | Medium | Manual `git pull + docker compose` on VPS; no CD pipeline |
| PostgreSQL unused | Low | Schema defined, migrations set up via Alembic; currently dormant |
| No test coverage for services | Medium | CI runs pytest but coverage is low; most logic is in services |
| No E2E tests | Medium | No Playwright/Cypress tests; manual QA only |
| `backend/.env.production` has secrets | Low | File is gitignored; template created at `backend/.env.production` |
