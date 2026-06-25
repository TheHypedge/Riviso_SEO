# Riviso — Claude Code Session Bootstrap

## Auto-load on every session start

Read these files in order before doing anything else:

1. `/root/.claude/projects/-var-www-riviso/memory/MEMORY.md` — index of all persistent memories
2. `/root/.claude/projects/-var-www-riviso/memory/project_overview.md` — stack, key files, storage pattern
3. `/root/.claude/projects/-var-www-riviso/memory/project_generation_design.md` — prompt rules, removed features, deploy commands
4. `/root/.claude/projects/-var-www-riviso/memory/project_frontend_patterns.md` — known pitfalls, dashboard patterns, CSS tokens
5. `/root/.claude/projects/-var-www-riviso/memory/project_gsc_integration.md` — GSC OAuth, indexing, API routes
6. `/root/.claude/projects/-var-www-riviso/memory/project_dashboard_audit.md` — a11y audit history (P1–P3), patterns shipped
7. `DESIGN.md` — design system: tokens, typography, spacing, component rules
8. `PRODUCT.md` — product vision, feature inventory, user personas

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

```bash
# Frontend: git push → Vercel auto-deploys from main
git push origin main

# Backend: rebuild Docker services
docker compose down && docker compose up -d --build
docker compose ps  # backend/worker/scheduler/redis → healthy; nginx failing = expected
```

---

## Critical rules (do not violate)

- Never re-add Content Optimization Profile (SEO/AEO blocks) — removed intentionally; user prompt is highest priority
- Never commit `backend/.env.save` — contains live credentials
- `update_article_fields` = full `replace_one`; `patch_article_fields` = `$set`. New article fields must go in BOTH `_normalize_article_dict` AND `_apply_article_updates_dict` in `storage.py`
- `docker-compose` (V1 with hyphen) is NOT installed — always use `docker compose` (V2, space)
- Dashboard modals must use `useFocusTrap` (`frontend/src/lib/useFocusTrap.ts`) — never `window.confirm` / `window.alert`
- Use semantic z-index tokens (`--z-dropdown` → `--z-tooltip`) — never hardcode `999` / `9999`

---

## Key file map

```
frontend/src/app/
  dashboard/page.tsx          # Admin dashboard — focus traps, accessible modals
  dashboard/dashboard.module.css
  projects/[projectId]/page.tsx  # Project page ~11k lines; tabs: articles/research/prompts/schedule/performance/tools/project_settings
  globals.css                 # Design tokens: --aa-*, --z-*, prefers-reduced-motion guards

frontend/src/lib/
  useFocusTrap.ts             # Focus trap hook for all modals
  articlePaths.ts
  api.ts                      # API client types

frontend/src/components/
  WorkspaceProjectOverview.tsx
  OverviewReadinessGate.tsx
  ArticlesOverviewChart.tsx

backend/app/services/
  article_pipeline.py         # Single exit point for generation — context links injected here
  article_generation.py       # LLM prompt builder (build_generation_messages)
  wordpress_publish.py        # WP REST publish + update
  gsc.py / gsc_actions.py     # GSC OAuth + indexing
  google_console_service.py   # Search Analytics, 90s cache

storage.py                    # MongoDB wrappers (_normalize_article_dict is canonical schema)
```
