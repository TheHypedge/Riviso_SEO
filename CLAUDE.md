# Riviso — Claude Code Session Bootstrap

## Auto-load on every session start

Read these files in order before doing anything else:

1. `/root/.claude/projects/-var-www-riviso/memory/MEMORY.md` — index of all persistent memories
2. `/root/.claude/projects/-var-www-riviso/memory/project_overview.md` — stack, key files, storage pattern
3. `/root/.claude/projects/-var-www-riviso/memory/project_generation_design.md` — prompt rules, removed features, deploy commands
4. `/root/.claude/projects/-var-www-riviso/memory/project_frontend_patterns.md` — known pitfalls, dashboard patterns, CSS tokens
5. `/root/.claude/projects/-var-www-riviso/memory/project_gsc_integration.md` — GSC OAuth, indexing, API routes
6. `/root/.claude/projects/-var-www-riviso/memory/project_dashboard_audit.md` — a11y audit history (P1–P3), patterns shipped
7. `/root/.claude/projects/-var-www-riviso/memory/project_f0_hardening.md` — security hardening shipped 2026-08-01: encryption at rest, SSRF, XSS, CSP; **read before any deploy** — documents a Docker build-context gotcha that can ship unreviewed code to prod
8. `/root/.claude/projects/-var-www-riviso/memory/project_f1_throughput.md` — generation-worker concurrency fix, dashboard caching, Argon2 migration; current status of the ongoing hardening/roadmap execution
9. `/root/.claude/projects/-var-www-riviso/memory/feedback_prod_deploy_cadence.md` — **read before any multi-step deploy** — this repo's required deploy cadence and safe-migration pattern
10. `DESIGN.md` — design system: tokens, typography, spacing, component rules
11. `PRODUCT.md` — product vision, feature inventory, user personas

After reading, confirm with: "Context loaded — [one line summary of current project state]."

---

## Stack at a glance

| Layer | Tech | Location |
|-------|------|----------|
| Frontend | Next.js App Router (TypeScript) | `frontend/` → Vercel |
| Backend | FastAPI (Python) | `backend/` → Docker on VPS |
| Queue | Redis + custom worker | Docker |
| DB | MongoDB | `storage.py` (repo root) |
| Proxy | Host nginx (TLS) + Certbot | `/etc/nginx/sites-enabled/` |

**Domains:** `riviso.cloud` → Vercel frontend · `api.riviso.cloud` → backend port 8000

---

## Deploy flow

**There is no staging environment.** Dev and prod are the same branch on the same VPS — every `docker compose up --build` ships straight to real users. Default to incremental deploys: one change, one commit, one rebuild, one smoke-check, before the next change. See `feedback_prod_deploy_cadence.md` in memory.

**⚠️ Before any `docker compose up --build`, run `git status --porcelain` first.** The Dockerfiles do a raw `COPY` from the working directory, not `git HEAD` — any uncommitted, unrelated file sitting in the tree gets baked into the image and deployed as a side effect. If there's uncommitted work that isn't part of what you're deploying, `git stash push -u` it first. This has actually happened (see `project_f0_hardening.md`).

```bash
# Frontend: git push → Vercel auto-deploys from main (secondary; Docker on VPS is primary, see below)
git push origin main

# Backend: rebuild only the services that changed (faster, smaller blast radius)
docker compose up -d --build backend worker scheduler   # storage.py / shared backend code
docker compose up -d --build frontend                     # frontend-only change
docker compose ps  # backend/worker/scheduler/redis/frontend → healthy; nginx failing = expected

# Full rebuild (rarely needed — prefer per-service above)
docker compose down && docker compose up -d --build
```

Note: requesting `--build` on one service still recreates its `depends_on` dependencies (e.g. `frontend` also recreates `backend`) — plan for that.

---

## Critical rules (do not violate)

- Never re-add Content Optimization Profile (SEO/AEO blocks) — removed intentionally; user prompt is highest priority
- Never commit any `.env*` file (`backend/.env`, `backend/.env.save`, `*.env.bak`, etc.) — contains live credentials. `.gitignore` covers these as of 2026-08-01; don't narrow that pattern back to an exact-match-only rule.
- `update_article_fields` = full `replace_one`; `patch_article_fields` = `$set`. New article fields must go in BOTH `_normalize_article_dict` AND `_apply_article_updates_dict` in `storage.py`. Same pattern for projects: `_normalize_project_dict` (write shape) + `_mongo_doc_to_project` (read shape) must both know about new fields.
- **`FIELD_ENCRYPTION_KEY` is required in production** (`backend/.env`, Fernet key) — `wp_app_password`, `shopify_access_token`, `shopify_client_secret`, `gsc_access_token`, `gsc_refresh_token` on project docs are encrypted at rest as of 2026-08-01. Boot fails without it in `ENVIRONMENT=production`. Never log or print it. New secret-like project fields should go through `app/core/field_encryption.py`'s `encrypt_field`/`decrypt_field`, added at the same two `storage.py` boundaries (`_mongo_doc_to_project` / `_encrypt_project_secrets`), not scattered per call site.
- Password hashing goes through `backend/app/core/password_hashing.py` (`hash_password`/`verify_password`, Argon2id) — never call `werkzeug.security.generate_password_hash`/`check_password_hash` directly again; the module already handles legacy-hash fallback and opportunistic upgrade.
- `docker-compose` (V1 with hyphen) is NOT installed — always use `docker compose` (V2, space)
- Dashboard modals must use `useFocusTrap` (`frontend/src/lib/useFocusTrap.ts`) — never `window.confirm` / `window.alert`
- Use semantic z-index tokens (`--z-dropdown` → `--z-tooltip`) — never hardcode `999` / `9999`
- Any `dangerouslySetInnerHTML` of markdown-derived content must go through `markdownToArticleHtml()` (`frontend/src/lib/articleMarkdown.ts`), which sanitizes with DOMPurify — never call `marked.parse()` directly and inject the result

---

## Key file map

```
frontend/src/app/
  dashboard/page.tsx          # Admin dashboard — focus traps, accessible modals
  dashboard/dashboard.module.css
  projects/[projectId]/page.tsx  # Project page ~13.5k lines, single component; tabs: articles/research/prompts/schedule/performance/tools/members/project_settings
                               # NOT code-split (F1.5, deliberately deferred) — fragile tab-switch/dirty-state history, no staging env to catch a regression
  globals.css                 # Design tokens: --aa-*, --z-*, prefers-reduced-motion guards

frontend/src/lib/
  useFocusTrap.ts             # Focus trap hook for all modals
  articlePaths.ts
  api.ts                      # API client types
  articleMarkdown.ts           # markdownToArticleHtml() — the only sanitized path from markdown to dangerouslySetInnerHTML

frontend/src/components/
  WorkspaceProjectOverview.tsx
  OverviewReadinessGate.tsx
  ArticlesOverviewChart.tsx

backend/app/services/
  article_pipeline.py         # Single exit point for generation — context links injected here
  article_generation.py       # LLM prompt builder (build_generation_messages)
  wordpress_publish.py        # WP REST publish + update
  gsc.py / gsc_actions.py     # GSC OAuth + indexing
  google_console_service.py   # Search Analytics, 90s cache — the TTL-cache pattern reused for dashboard overview (F1.4) and modeled for any future cache
  generation_worker.py        # Queue drain loop — fans out to concurrent tasks (F1.1), bounded by generation_slot() semaphore (max_concurrent_generations, default 3)
  url_guard.py                 # SSRF guard (assert_public_http_url, ssrf_guarded_event_hooks) — use for ANY new outbound fetch to a user-supplied URL

backend/app/core/
  field_encryption.py         # encrypt_field/decrypt_field (Fernet) — third-party credentials at rest, see FIELD_ENCRYPTION_KEY above
  password_hashing.py         # hash_password/verify_password (Argon2id + legacy fallback)

backend/app/scripts/
  migrate_encrypt_secrets.py  # One-time secret-encryption backfill, run manually: docker compose exec backend python -m app.scripts.migrate_encrypt_secrets

backend/docs/RIVISO_PRODUCTION_HARDENING_PLAN.md  # Internal security/perf/infra tracking doc — kept in sync with Claude memory as of 2026-08-01, check its status table before assuming an item is still open

storage.py                    # MongoDB wrappers (_normalize_article_dict / _mongo_doc_to_project are the canonical read/write shapes for articles/projects)
```
