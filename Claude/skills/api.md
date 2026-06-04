# skills/api.md — API Conventions

## Base URL

All API routes are mounted under `/api` prefix.
- Local dev: `http://127.0.0.1:8000/api/...`
- Production (direct): `https://api.riviso.cloud/api/...`
- Production (via Next.js proxy): `https://app.riviso.com/api/...` → rewrites to backend

---

## Route Naming Conventions

| Pattern | Usage |
|---------|-------|
| `GET /api/projects` | List all projects for current user |
| `POST /api/projects` | Create a project |
| `GET /api/projects/{id}` | Get single project |
| `PATCH /api/projects/{id}/settings` | Update project settings (partial update) |
| `DELETE /api/projects/{id}` | Delete a project |
| `GET /api/projects/{id}/articles` | List articles (paginated) |
| `POST /api/projects/{id}/articles/{aid}/generate` | Trigger generation |
| `GET /api/projects/{id}/articles/{aid}/generation-status` | Poll generation status |
| `POST /api/projects/{id}/articles/{aid}/integrity/humanize` | On-demand humanize |

**Conventions:**
- Use kebab-case for URL path segments: `/generation-status`, `/integrity/humanize`
- Nested resource paths: `/projects/{id}/articles/{aid}/...`
- Actions that aren't standard CRUD: POST to a verb path: `/generate`, `/verify`, `/publish`
- `PATCH` for partial updates (not `PUT`) — only send changed fields

---

## Request Standards

### Authentication
Two methods supported (checked in this order):

1. **Bearer token** — `Authorization: Bearer <jwt>`
2. **Cookie** — `aa_access=<jwt>` (httpOnly cookie, set by login)

All authenticated endpoints use `Depends(get_current_user)`.

### CSRF Protection
All cookie-authenticated **mutating** requests (POST, PUT, PATCH, DELETE) must include:
```
X-Requested-With: XMLHttpRequest
```
Bearer-token requests are exempt. Auth routes (`/api/auth/*`) and webhook routes are also exempt.

### Content-Type
JSON body requests: `Content-Type: application/json`
File uploads: `Content-Type: multipart/form-data`

### Request body validation
Pydantic v2 validates all request bodies automatically. The response for a validation error:
```json
HTTP 422 Unprocessable Entity
{
  "detail": [
    {"type": "missing", "loc": ["body", "title"], "msg": "Field required"}
  ]
}
```

**Critical**: Never use `from __future__ import annotations` in route files — it causes
Pydantic v2 + SlowAPI to fail with `ForwardRef` errors producing 422 on every request.

---

## Response Standards

### Success responses
```json
// Single resource
HTTP 200
{ "id": "...", "title": "...", ... }

// List
HTTP 200
{ "items": [...], "total": 42, "page": 1, "per_page": 10 }

// Created
HTTP 201
{ "id": "...", ... }

// Accepted (async job enqueued)
HTTP 202
{ "status": "queued", "article_id": "..." }

// Action with simple confirmation
HTTP 200
{ "ok": true, "message": "..." }
```

### Error responses
All errors return JSON `{"detail": "..."}` or `{"detail": {...}}`:

```json
HTTP 401
{ "detail": "Missing bearer token" }

HTTP 401
{ "detail": "Invalid token" }

HTTP 403
{
  "detail": {
    "code": "email_verification_required",
    "message": "Verify your email address before signing in."
  }
}

HTTP 403
{ "error": "trial_expired", "message": "Your beta access has ended." }

HTTP 404
{ "detail": "Article not found" }

HTTP 422
{ "detail": [{ "type": "missing", "loc": ["body", "field"], "msg": "Field required" }] }

HTTP 429
"Rate limit exceeded"

HTTP 500
{ "detail": "A database error occurred. Please try again." }
```

---

## Pagination

Standard pagination for article lists:
```
GET /api/projects/{id}/articles?page=1&per_page=10&q=keyword&status=published&sort=desc
```

Response:
```json
{
  "items": [ ... ],
  "total": 42,
  "page": 1,
  "per_page": 10
}
```

Parameters:
- `page` — 1-based page number
- `per_page` — items per page (max 100)
- `q` — search query string
- `status` — filter by status: `pending | draft | scheduled | published`
- `sort` — `asc` or `desc` (by created_at)
- `date_from`, `date_to` — ISO date range filter

---

## Generation Status Polling

Article generation is async. Workflow:

1. `POST .../generate` → `202 { "status": "queued", "article_id": "..." }`
2. Poll `GET .../generation-status` until `status` is `complete` or `error`

```json
// Pending / in-progress
{
  "status": "generating",
  "stage": "STAGE_HUMANIZATION",
  "message": "Humanizing content..."
}

// Complete
{
  "status": "complete",
  "article_id": "..."
}

// Failed
{
  "status": "error",
  "generation_error": "Internal error: OpenAI rate limit exceeded"
}
```

Frontend uses `pollWithBackoff()` which throws immediately when `generation_error` is set.

---

## Server-Sent Events (Pipeline Stream)

For real-time generation progress, subscribe to the SSE stream:
```
GET /api/projects/{id}/articles/{aid}/pipeline-stream
Accept: text/event-stream
```

Event format:
```
data: {"type": "stage_update", "stage": "STAGE_OPENAI_DISPATCH", "message": "Sending to OpenAI..."}

data: {"type": "stage_update", "stage": "STAGE_HUMANIZATION", "message": "Humanizing..."}

data: {"type": "complete", "stage": "STAGE_COMPLETE"}

data: {"type": "error", "message": "Generation failed: ..."}
```

---

## Rate Limits

Default: **300 requests/minute** per authenticated user (by JWT sub) or per IP (anonymous).

Endpoint-specific overrides:
- `POST .../generate` — `10/minute`
- `POST .../research/ideas` — `5/minute`
- `POST /auth/login` — `10/minute`
- `POST /auth/register` — `5/minute`
- `POST /auth/forgot-password` — `3/minute`

Rate limit exceeded: `HTTP 429 "Rate limit exceeded"`

Redis-backed when `REDIS_URL` is set (required for multi-instance correctness).

---

## Key Endpoints Reference

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Register (creates pending account) |
| POST | `/api/auth/login` | Login → sets `aa_access` + `aa_refresh` cookies |
| POST | `/api/auth/refresh` | Refresh access token |
| POST | `/api/auth/logout` | Clear cookies |
| POST | `/api/auth/verify-email` | Verify email with token |
| POST | `/api/auth/forgot-password` | Request password reset email |
| POST | `/api/auth/reset-password` | Set new password with reset token |

### Projects
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List user's projects |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/{id}/settings` | Get project settings |
| PATCH | `/api/projects/{id}/settings` | Update project settings |
| DELETE | `/api/projects/{id}` | Delete project |

### Articles
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects/{id}/articles` | Paginated article list |
| POST | `/api/projects/{id}/articles` | Create article |
| GET | `/api/projects/{id}/articles/{aid}` | Get article (full body) |
| PATCH | `/api/projects/{id}/articles/{aid}` | Update article fields |
| DELETE | `/api/projects/{id}/articles/{aid}` | Delete article |
| POST | `/api/projects/{id}/articles/{aid}/generate` | Trigger AI generation |
| GET | `/api/projects/{id}/articles/{aid}/generation-status` | Poll generation status |
| POST | `/api/projects/{id}/articles/{aid}/integrity/humanize` | Humanize article |
| POST | `/api/projects/{id}/articles/{aid}/publish` | Publish to WP/Shopify |
| POST | `/api/projects/{id}/articles/{aid}/regenerate-image` | Regenerate featured image |
| GET | `/api/projects/{id}/articles/{aid}/pipeline-stream` | SSE stream |

### Settings & Publishing
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/projects/{id}/settings/wordpress/verify` | Test WP credentials |
| GET | `/api/projects/{id}/settings/wordpress/pages` | List WP pages for mapping |
| POST | `/api/projects/{id}/schedule` | Schedule article for publishing |
| GET | `/api/projects/{id}/schedule` | List scheduled jobs |
| DELETE | `/api/projects/{id}/schedule/{jid}` | Cancel scheduled job |

### Research & Clusters
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/projects/{id}/research/ideas` | Generate research ideas (synchronous) |
| POST | `/api/projects/{id}/cluster/plan` | Generate topic cluster plan |
| POST | `/api/projects/{id}/cluster/generate-all` | Batch generate all cluster articles |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health + readiness check |
| GET | `/metrics` | Prometheus metrics (optional auth) |

---

## API Versioning

No versioning currently. All endpoints are under `/api/`. Breaking changes are not
expected in the near term. If versioning is introduced, use path-based `/api/v2/`.

---

## OpenAPI / Swagger

- Available at `/docs` and `/redoc` in development only
- Disabled when `ENVIRONMENT=production` (returns 404)
- JSON schema at `/openapi.json` (development only)
