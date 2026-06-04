# FEATURES.md — Feature Registry

_Last updated: 2026-06-04_

---

## Completed Features

### Authentication & Accounts
- **Email/password auth** — register, login, logout, refresh token rotation
- **Email verification** — token sent on register; account stays `pending` until verified
- **Password reset** — forgot-password → email link → reset form
- **Account deactivation** — soft delete with reactivation flow
- **Trial subscription enforcement** — `PlanLimitsMiddleware` blocks mutations after trial expiry
- **Admin role** — `role: admin` bypasses all plan limits; access to `/api/admin/*`

### Projects
- **Multi-project workspace** — users own multiple projects; each has isolated settings, prompts, articles
- **Platform selection** — WordPress or Shopify per project
- **Brand & niche configuration** — `brand_identity`, `niche_identifier`, `brand_voice`, `brand_tones`, `brand_rules`, audience, geo-targeting

### Article Generation
- **AI article generation** — GPT-4.1-mini generates JSON bundle: body (Markdown), meta_title, meta_description, image_alt
- **Featured image generation** — gpt-image-1 generates contextual featured images
- **Generation queue** — Redis-backed async queue with dedup; in-process fallback when Redis unavailable
- **Generation pipeline SSE stream** — real-time stage updates (queued → OpenAI → humanize → integrity → complete)
- **Generation error persistence** — `generation_error` field written to article on failure; cleared on retry
- **Default prompt backfill** — `_ensure_project_prompt_defaults` ensures prompts exist before generation
- **Content Optimization Profiles** (NEW 2026-06-04) — per-project SEO / AEO / GEO / E-E-A-T system-prompt injection
  - SEO: keyphrase in H1 + H2 + opening paragraph; structured hierarchy; meta compliance
  - AEO: ≥4 FAQ items as H3 + answer; inverted pyramid; featured-snippet-ready answers
  - GEO: named entities; ≥1 stat per 300 words; self-contained factual statements
  - E-E-A-T: first-person experience signals; ≥2 named sources; objections section; trust signal

### AI Humanization
- **RIVISO multi-pass humanization** — automatic AI-marker scrubbing, paraphrase, grammar pipeline
- **AI detection auditing** — scores article before/after humanization; records `integrity_ai_percentage`
- **Configurable Humanization Guardrails** (NEW 2026-06-04) — per-project control:
  - Auto-humanize toggle
  - AI score target: 5% / 8% / 12% / Disabled
  - Strength preset: Light (0.60) / Medium (0.78) / Aggressive (0.88)
  - Max passes: 1–10
- **On-demand humanize** — humanize any article from the editor
- **Humanization diff viewer** — side-by-side before/after comparison in `IntegrityHumanizeCompare`

### Article Editor
- **Tiptap rich editor** — WYSIWYG editing with Markdown import/export
- **Article generation from editor** — generate new content or regenerate in-place
- **Image regeneration** — regenerate featured image independently
- **Article draft cache** — localStorage persistence of unsaved edits
- **Integrity score badge** — shows current AI percentage in editor header

### WordPress Integration
- **WP REST API publishing** — create/update posts, upload featured media
- **Application password auth** — per-project WP username + app password
- **Connection verification** — tests WP credentials + checks Riviso plugin status
- **WordPress Connector Plugin** — custom plugin packaged as downloadable zip
- **Scheduled publishing** — auto-publish at specified time via scheduler
- **GSC ping after publish** — triggers URL inspection after new post goes live
- **Internal link injection** — injects site-map page links into published article
- **Site-map aware prompts** — WP page titles + URLs injected into generation context when enabled
- **Default WP category** — per-project default category for published posts
- **Default WP status** — publish / draft / pending per project

### Shopify Integration
- **Shopify blog publishing** — create articles in Shopify Blog via Admin API
- **Shopify OAuth** — standard OAuth 2.0 flow for per-project access token
- **Shopify product-aware generation** — inject product catalog context into generation (toggle)
- **Shopify credential management** — client_id + client_secret + access_token per project

### Scheduling
- **Article scheduling** — schedule single article to publish at future datetime
- **Bulk cluster scheduling** — schedule entire topic cluster with spacing/dates
- **Scheduled job queue** — `state: pending → prep_dispatched → posted` state machine
- **Prep lead time** — content generated `SCHEDULE_PREP_LEAD_MINUTES` (default 45) before publish
- **User timezone support** — all schedule times stored in user-profile timezone; converted to UTC for processing
- **Daily subscription reset** — resets per-day counters at midnight UTC via `subscription_daily_reset_loop`

### Research & SEO
- **Custom research ideas** — LLM + web scraper generates article ideas from existing content + GSC data
- **Google Search Console integration** — OAuth → property selection → URL inspection per article
- **Google Indexing API** — request immediate indexing after publish
- **Topic cluster planning** — LLM generates a topically coherent cluster of article titles
- **Topic cluster validation** — embedding similarity check prevents intent overlap within a cluster
- **Article rank monitoring** — tracks ranking position; triggers smart refresh when rank drops
- **Cluster internal linking** — auto-links articles within the same cluster post-generation

### Admin
- **User management** — list users, view workspace, update subscription type
- **Plan management** — load/update plan definitions stored in MongoDB
- **Admin workspace viewer** — see all projects + articles for any user

### Platform & Infrastructure
- **Rate limiting** — SlowAPI + Redis; 300 req/min per authenticated user or IP
- **CSRF protection** — X-Requested-With required on cookie-auth mutations
- **Security headers** — CSP, X-Frame-Options, HSTS, Referrer-Policy on all responses
- **Prometheus metrics** — request latency, queue depth, optional Bearer auth
- **Sentry error tracking** — optional; configured via `SENTRY_DSN`
- **Health endpoint** — `/api/health` with storage ping + config fingerprint
- **Request ID tracing** — `X-Request-ID` on every response for log correlation
- **Bulk article upload** — XLSX import with duplicate detection
- **Bulk article export** — XLSX export from article list

---

## Features In Progress

| Feature | Status | Notes |
|---------|--------|-------|
| `generation_error` UI display | Code ready (field persisted) | Frontend article list does not yet show the error or offer retry button |
| Featured image regeneration stability | Fix deployed; monitoring | Commit 27f2262 |

---

## Planned Features

| Feature | Priority | Notes |
|---------|----------|-------|
| Payment integration (Stripe/Paddle) | Critical | Blocks post-beta revenue |
| Plan upgrade UI | High | `TrialUpgradeModal` links out; needs in-app flow |
| Admin account restoration | High | `iamakhileshsoni@gmail.com` deleted from Atlas |
| Content calendar view | Medium | Visualize scheduled articles across projects |
| Multi-user workspaces / team invites | Medium | |
| White-label / agency tier | Medium | Custom domain per workspace |
| Automatic internal linking post-generation | Medium | Research built; auto-injection not wired |
| GSC keyword gap analysis | Medium | Use GSC data to suggest article topics |
| Cluster bulk-schedule UI | Low | `BulkScheduleModal` built; needs scheduler endpoint wired |
| Full PostgreSQL migration | Low | Schema defined; blocked by migration effort |
| Horizontal API scaling | Low | Redis queue + rate limiter ready; Nginx LB config needed |
