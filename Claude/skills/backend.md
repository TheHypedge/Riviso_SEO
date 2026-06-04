# skills/backend.md — Backend Conventions

## Stack
- **Python 3.12**
- **FastAPI 0.116** — ASGI, async-first
- **Pydantic v2** — strict model validation
- **pydantic-settings** — config from `.env` + environment
- **pymongo + Motor** — MongoDB sync/async
- **SlowAPI** — rate limiting
- **python-jose** — JWT
- **passlib[bcrypt]** — password hashing
- **httpx** — async HTTP client for external APIs

---

## Directory Structure

```
backend/app/
├── main.py               # create_app() — middleware stack, lifespan hooks
├── run_background.py     # entry point for worker + scheduler processes
├── api/
│   ├── router.py         # aggregates all route modules
│   └── routes/           # one file per feature domain
├── core/
│   ├── config.py         # Settings (pydantic-settings)
│   ├── deps.py           # FastAPI dependencies (get_current_user, require_admin)
│   ├── security.py       # JWT create/decode
│   ├── logging.py        # structlog configuration
│   ├── ratelimit.py      # SlowAPI limiter instance
│   ├── production.py     # startup checks (secret key, env validation)
│   ├── metrics.py        # Prometheus middleware + counter helpers
│   ├── observability.py  # Sentry init
│   ├── request_cache.py  # per-request user/subscription memoization
│   └── project_lookup.py # project ownership verification helper
├── middleware/
│   ├── plan_limits.py    # trial expiry gate (ASGI)
│   └── request_id.py     # X-Request-ID correlation
├── schemas/              # Pydantic v2 request/response models
├── services/             # business logic (no FastAPI imports)
├── repositories/         # typed facades over storage.py functions
└── legacy/
    └── storage.py        # re-exports repo-root storage module
```

---

## Route Handler Pattern

Every route handler follows this structure:

```python
router = APIRouter(prefix="/projects/{project_id}/articles", tags=["articles"])

@router.post("/{article_id}/generate")
@limiter.limit("10/minute")
async def generate_article(
    request: Request,
    project_id: str,
    article_id: str,
    body: GenerateRequest,
    user: dict = Depends(get_current_user),
) -> ArticleGenerationStatusResponse:
    # 1. Load + verify ownership
    proj = await _load_verified_project(project_id, user)
    article = await _load_verified_article(project_id, article_id, user)

    # 2. Validate plan limits
    await assert_plan_action(user=user, action=PlanAction.GENERATE_CONTENT)

    # 3. Delegate to service
    result = await some_service_function(proj=proj, article=article, ...)

    # 4. Return typed response
    return ArticleGenerationStatusResponse(...)
```

**Rules:**
- No business logic in route handlers — delegate to `app/services/`
- No MongoDB calls directly in routes — use `call_storage` or `run_sync`
- No `from __future__ import annotations` in route files (breaks Pydantic v2 + SlowAPI)
- `request: Request` must be the first parameter when using `@limiter.limit`

---

## Service Layer Pattern

Services own business logic. Rules:
- No `from fastapi import ...` imports — services must not depend on the HTTP layer
- May raise `HTTPException` only when it's the only reasonable error path (e.g. `assert_plan_action`)
  Prefer returning typed results and letting routes decide HTTP status
- Async when I/O is needed; sync helper functions for pure computation
- Use `logging.getLogger(__name__)` — never `print()`

```python
# backend/app/services/example_service.py
from __future__ import annotations
import logging
log = logging.getLogger(__name__)

async def do_something(*, proj: dict, user: dict) -> dict:
    # pure business logic
    result = _compute(proj)
    log.info("did something for project %s", proj.get("id"))
    return result
```

---

## Blocking MongoDB Calls

All blocking pymongo calls must run off the event loop:

```python
from app.services.to_thread import run_sync
from app.services.storage_db import call_storage
from app.legacy.storage import get_legacy_storage_module

st = get_legacy_storage_module()
result = await run_sync(call_storage, st.get_article, project_id=pid, article_id=aid)
```

For hot paths (dashboard, workspace listing), use Motor async directly via `mongo_listings_async.py`.

The `call_storage` wrapper adds retry logic (2 attempts, pool reset on transient error).

---

## Adding a New Service

1. Create `backend/app/services/new_service.py`
2. No FastAPI imports; accept typed arguments (dicts for now, dataclasses/schemas preferred)
3. Write pure functions where possible — async only when needed
4. Add logging: `log = logging.getLogger(__name__)`
5. Call from a route handler via `await` (or `await run_sync(...)` if sync)

---

## Dependency Injection

Standard FastAPI `Depends`:

```python
# Get authenticated user (raises 401 if not authenticated)
user: dict = Depends(get_current_user)

# Require admin role (raises 403 if not admin)
user: dict = Depends(require_admin)
```

Per-request caching (avoids double MongoDB reads per request):
```python
# In deps.py
cache_user(request, user_id, user)    # write
user = cached_user(request, user_id)  # read (None if not cached)

cache_subscription(scope, subscription)
sub = cached_subscription(request)
```

---

## Configuration Pattern

All config via `backend/app/core/config.py` → `settings` singleton:

```python
from app.core.config import settings

if settings.is_production:
    # production-only path
    pass

key = settings.openai_api_key
```

**Never** read secrets via `os.environ.get()` directly in service code — always go through `settings`.
`settings` reads from `backend/.env` (pydantic-settings) which wins over environment variables.

Adding a new config field:
```python
class Settings(BaseSettings):
    my_feature_enabled: bool = Field(
        default=True,
        validation_alias="MY_FEATURE_ENABLED",
    )
```

---

## Error Handling

| Scenario | Pattern |
|----------|---------|
| User not found / not authorized | `raise HTTPException(status_code=401, detail="...")` |
| Forbidden (wrong project ownership) | `raise HTTPException(status_code=403, detail="...")` |
| Resource not found | `raise HTTPException(status_code=404, detail="Not found")` |
| Validation error | Pydantic raises automatically on request body |
| MongoDB transient error | `call_storage` retries; `is_transient_storage_error()` for custom handling |
| External API failure (OpenAI, WP) | Catch `httpx.HTTPError`; log + raise `HTTPException(500)` |
| Plan limit exceeded | `PlanGatekeeperError` → `HTTPException(403)` via `assert_plan_action()` |

Never return `{"error": "..."}` dicts — use `JSONResponse` or `HTTPException` so FastAPI serialises correctly.

---

## Pydantic v2 Schema Conventions

```python
from pydantic import BaseModel, Field

class ArticleCreateRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=500)
    keywords: list[str] = Field(default_factory=list)
    focus_keyphrase: str | None = None          # optional field
    word_count: int = Field(default=1200, ge=100, le=5000)
```

- Use `Field(...)` (required) vs `Field(default=...)` (optional)
- Use `ge`, `le`, `min_length`, `max_length` constraints at the schema level
- Response models always inherit `BaseModel`; never return raw dicts from route handlers
- Use `model_config = ConfigDict(extra="ignore")` on schemas that receive MongoDB documents (extra fields won't cause validation errors)

---

## Rate Limiting

```python
from app.core.ratelimit import limiter

@router.post("/some-endpoint")
@limiter.limit("5/minute")
async def my_endpoint(request: Request, ...):
    ...
```

`request: Request` must be the first positional parameter — SlowAPI inspects it for the rate limit key.
Rate limit key: JWT `sub` (authenticated users) or client IP (anonymous).
Redis storage: shared across API instances when `REDIS_URL` is set.

---

## Background Tasks

### Generation Worker
Jobs go through `generation_queue.py`:

```python
from app.services.generation_queue import GenerationJob, GenerationJobKind, enqueue_job

job = GenerationJob(
    kind=GenerationJobKind.ARTICLE_GENERATE,
    payload={"project_id": pid, "article_id": aid, ...},
)
await enqueue_job(job)
```

Worker picks up jobs via `dequeue_blocking()` and dispatches to handlers in `generation_worker.py`.

### Scheduler
`scheduler.py` polls for due scheduled jobs every 10 seconds. Each job has:
- `state`: `pending → prep_dispatched → posted`
- `scheduled_at`: UTC ISO string
- `user_timezone`: IANA timezone name for display

### Process control
```python
# main.py lifespan
if settings.enable_generation_worker:
    generation_worker_task = start_generation_worker()
if settings.enable_scheduler:
    scheduler_task = asyncio.create_task(scheduler_loop(poll_seconds=10.0))
```

Control via `.env`:
```
ENABLE_GENERATION_WORKER=1   # worker container only
ENABLE_SCHEDULER=1           # scheduler container only
```

---

## Logging

```python
import logging
log = logging.getLogger(__name__)

log.info("Article generated: project=%s article=%s", project_id, article_id)
log.warning("Humanization skipped: %s", reason)
log.exception("Unexpected error in generation pipeline")  # includes traceback
```

Structlog is configured in `core/logging.py`. In production, logs are JSON-formatted.
Every request carries an `X-Request-ID` from `RequestIdMiddleware` — appears in all log lines.

---

## Security Checklist for New Endpoints

- [ ] `Depends(get_current_user)` on all authenticated routes
- [ ] `Depends(require_admin)` on admin-only routes
- [ ] Ownership check: `project.get("owner_user_id") == user["id"]` before reading/writing project data
- [ ] Plan limit check: `await assert_plan_action(user=user, action=PlanAction.X)` on generation/schedule
- [ ] User-supplied URLs: `assert_public_http_url(url)` before fetching
- [ ] No secrets in response bodies (never return `wp_app_password`, OAuth tokens in full)
- [ ] Rate limit decorator on expensive endpoints (`@limiter.limit("N/minute")`)
