# skills/database.md — Database Conventions

## Primary Database: MongoDB Atlas

All production data lives in MongoDB Atlas. The database name is `auto_articles`
(configurable via `MONGODB_DB_NAME` env var).

---

## Collections Schema

### `users`
```json
{
  "id": "uuid4-string",
  "_id": "ObjectId",
  "email": "user@example.com",
  "password_hash": "bcrypt-hash",
  "role": "user | admin",
  "full_name": "",
  "phone": "",
  "timezone": "Asia/Kolkata",
  "account_status": "active | pending | deleted | deactivated",
  "subscription_type": "beta | pro | ...",
  "is_deleted": false,
  "is_deactivated": false,
  "deleted_at": null,
  "deactivated_at": null,
  "created_at": "ISO UTC string",
  "last_activity_at": "ISO UTC string",
  "email_verification_token": "hex",
  "email_verification_expires": "ISO UTC string",
  "password_reset_token": "hex",
  "password_reset_expires": "ISO UTC string"
}
```

### `projects`
```json
{
  "id": "uuid4-string",
  "owner_user_id": "user-id",
  "name": "My Blog",
  "platform": "wordpress | shopify",
  "website_url": "https://...",
  "brand_identity": "...",
  "niche_identifier": "...",
  "brand_voice": "...",
  "brand_tones": ["..."],
  "brand_rules": "...",
  "niche_topic": "...",
  "audience": "...",
  "target_countries": ["IN"],
  "target_countries_all": false,
  "target_cities": [],
  "target_cities_all": false,
  "wp_site_url": "https://...",
  "wp_username": "...",
  "wp_app_password": "encrypted",
  "wp_verified_at": "ISO UTC",
  "wp_verified_status": "connected | auth_failed | failed",
  "wp_plugin_status": "active | missing | ...",
  "default_wp_rest_base": "posts",
  "default_wp_status": "publish",
  "default_wp_category_ids": [1, 2],
  "shopify_shop": "mystore.myshopify.com",
  "shopify_client_id": "...",
  "shopify_client_secret": "encrypted",
  "shopify_access_token": "shpat_...",
  "shopify_verified_at": "ISO UTC",
  "shopify_product_aware_enabled": false,
  "wp_internal_link_aware_enabled": false,
  "gsc_property_url": "https://...",
  "gsc_index_on_publish": true,
  "content_optimization_profile": "none | seo | aeo | geo | eeat",
  "humanization_settings": {
    "auto_humanize": true,
    "target_ai_pct": 6.0,
    "strength_preset": "medium",
    "max_passes": 6
  },
  "created_at": "ISO UTC"
}
```

### `articles`
```json
{
  "id": "uuid4-string",
  "project_id": "project-id",
  "title": "Article Title",
  "keywords": ["kw1", "kw2"],
  "focus_keyphrase": "main kw",
  "article": "# Markdown body...",
  "meta_title": "SEO title",
  "meta_description": "SEO description",
  "image_alt": "Image alt text",
  "image_url": "data:image/... or https://...",
  "status": "pending | generating | draft | scheduled | published",
  "listing_status": "pending | draft | scheduled | published",
  "has_body": true,
  "generation_error": null,
  "integrity_ai_percentage": 4.2,
  "wp_post_id": 123,
  "wp_link": "https://...",
  "wp_last_wp_status": "publish",
  "wp_rest_base": "posts",
  "wp_scheduled_at": "ISO UTC",
  "wp_schedule_error": null,
  "shopify_blog_id": 12345,
  "shopify_article_id": 67890,
  "shopify_link": "https://...",
  "gsc_status": "indexed | not_indexed | unknown",
  "gsc_inspection_url": "https://...",
  "monitor_status": "fresh | stale | unknown",
  "monitor_last_checked_at": "ISO UTC",
  "internal_links_count": 3,
  "created_at": "ISO UTC",
  "updated_at": "ISO UTC",
  "posted_at": "ISO UTC"
}
```

### `scheduled_jobs`
```json
{
  "id": "uuid4-string",
  "project_id": "project-id",
  "article_id": "article-id",
  "state": "pending | prep_dispatched | posted | failed | cancelled",
  "scheduled_at": "2026-06-10T14:00:00+00:00",
  "user_timezone": "Asia/Kolkata",
  "prep_dispatched_at": null,
  "posted_at": null,
  "error": null,
  "created_at": "ISO UTC",
  "updated_at": "ISO UTC"
}
```

### `subscriptions`
```json
{
  "id": "uuid4-string",
  "user_id": "user-id",
  "trial_end_date": "2026-12-31T23:59:59+00:00",
  "plan_key": "beta",
  "created_at": "ISO UTC",
  "updated_at": "ISO UTC"
}
```

### `plans`
```json
{
  "key": "beta",
  "name": "Beta",
  "is_default": true,
  "max_projects": 10,
  "max_articles": 1000,
  "max_articles_per_day": 50,
  "max_articles_per_month": 500,
  "max_writing_prompts": 20,
  "writing_prompt_char_limit": 2000,
  "max_image_prompts": 10,
  "image_prompt_char_limit": 1000,
  "allow_scheduling": true,
  "max_scheduled_per_month": 200,
  "allow_export": true
}
```

---

## Connection Management

### Client initialization (`database.py`)
```python
# Pool config (tuned for Atlas M10 tier)
maxPoolSize = 50          # per process
minPoolSize = 2           # warm connections
maxIdleTimeMS = 120000    # 2 min — outlasts longest OpenAI call
socketTimeoutMS = 20000
connectTimeoutMS = 10000
retryReads = True
retryWrites = True
```

Override pool values via env: `MONGODB_MAX_POOL_SIZE`, `MONGODB_MIN_POOL_SIZE`,
`MONGODB_MAX_IDLE_TIME_MS`, `MONGODB_SOCKET_TIMEOUT_MS`.

### Retry wrapper
`database.run_with_retry(fn, attempts=2)` — retries once with pool reset on transient errors.
`call_storage(fn, *args, **kwargs)` — convenience wrapper in `services/storage_db.py`.

```python
# Always use this pattern for blocking pymongo calls:
result = await run_sync(call_storage, st.get_article, project_id=pid, article_id=aid)
```

### Async reads (Motor)
`services/mongo_listings_async.py` provides Motor-based async reads for hot paths:
- `fetch_user_by_id(user_id)` — used in `deps.py` (every authenticated request)
- `fetch_project_listing(owner_user_id)` — dashboard project list
- `fetch_workspace_articles(user_id, limit)` — workspace feed

---

## Write Patterns

All writes go through `storage.py` (repo root) functions. The pattern:

```python
# Patch specific fields (preferred — atomic $set)
st.patch_article_fields(article_id, {
    "listing_status": "published",
    "wp_post_id": post_id,
    "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
})

# Full document update
st.update_project_fields(project_id, {
    "content_optimization_profile": "seo",
    "humanization_settings": {...},
})
```

Always include `updated_at` when patching documents so the UI shows correct "last modified" times.

---

## Indexes

Indexes are created by `database.init_db()` on startup. Key indexes:
- `articles`: `project_id`, `(project_id, status)`, `id` (unique)
- `projects`: `owner_user_id`, `id` (unique)
- `users`: `email` (unique), `id` (unique)
- `scheduled_jobs`: `(project_id, state)`, `(article_id, state)`

---

## Query Standards

### Projection (performance)
Heavy documents (article body, project prompts, OAuth tokens) should not be loaded
when only listing fields are needed.

```python
# Light listing — project dashboard fields only
_PROJECT_LISTING_AGGREGATE_PROJECT = {
    "_id": 0, "id": 1, "name": 1, "platform": 1, "website_url": 1, ...
}
```

Use `get_project_for_generation()` (light — no catalog/prompts) vs `get_project_by_id()` (full).
Use `get_article_editor_shell()` (no body HTML) vs `get_article()` (full with body).

### Pagination
Articles use cursor-style pagination:
```python
# per_page=10, page=1, sort="desc"
st.load_articles_listing_page_for_project(project_id, page=1, per_page=10, sort="desc")
st.count_articles_listing_for_project(project_id)  # for total count
```

### Date storage
All dates stored as ISO 8601 UTC strings (`"%Y-%m-%dT%H:%M:%S+00:00"` or `"%Y-%m-%d %H:%M:%S"`).
When reading, use `_parse_iso_utc()` in `plan_gatekeeper.py` to handle both formats.

---

## Migration Strategy

Currently: no formal migration tool for MongoDB (schema-less; additive changes are safe).

For adding a new field to existing documents:
1. Add field with a safe default in the Pydantic schema and storage reads
2. If backfill is needed, write a one-time backfill (example: `backfill_article_listing_fields` in `main.py`)
3. Backfills should be idempotent (only update docs missing the field)

PostgreSQL (dormant) uses Alembic for versioned migrations:
```bash
cd backend
alembic upgrade head
```

---

## Sensitive Data

Never log or return in API responses:
- `wp_app_password` — always masked as `wp_app_password_set: bool`
- `shopify_client_secret` — never returned
- `shopify_access_token` — only returned when explicitly needed by OAuth flow
- `password_hash` — never in any response
- Google OAuth tokens — per-user in users collection; masked in API

---

## Legacy JSON Fallback

For local dev or CI without MongoDB:
```
FORCE_JSON_STORAGE=1   # always use JSON files
AUTO_IMPORT_JSON=1     # import JSON files to MongoDB on startup
```

JSON files: `data/projects.json`, `data/articles.json`

Do not depend on JSON files in new code. Write all new features against MongoDB.
