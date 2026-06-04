# skills/testing.md — Testing Strategy

## Current State

Testing is minimal. CI gates exist and pass; unit/integration coverage of business logic is low.
This document describes what exists today and the standards to follow when adding tests.

---

## CI Gates (What Runs on Every PR)

```yaml
# .github/workflows/ci.yml — triggers on PR to main + push to main
backend-tests:   pytest -q (backend/)
frontend-tests:  npm run lint && npm run test:unit (frontend/)
```

```yaml
# .github/workflows/security.yml — triggers on PR to main + weekly
pip-audit:       pip-audit -r backend/requirements.txt --strict
npm-audit:       npm audit --audit-level=high
gitleaks:        gitleaks (full repo scan)
```

All 4 jobs must be green before merging to `main`.

---

## Backend Tests (pytest)

### Location
`backend/` — test files alongside source or in `tests/` subdirectory.

### Running locally
```bash
cd backend
FORCE_JSON_STORAGE=1 SECRET_KEY=test ENVIRONMENT=test pytest -q
```

### Key environment variables for tests
```bash
FORCE_JSON_STORAGE=1     # use JSON fallback; never connect to MongoDB in unit tests
SECRET_KEY=test-key      # any non-empty string
ENVIRONMENT=test         # skips production startup checks
```

### What to test

**High-value targets (not yet covered — priority order):**

1. **`integrity_engine.py`** — `execute_structural_humanization()` is the most complex service;
   test that `target_ai_pct`, `initial_strength`, `max_passes` params are respected

2. **`content_optimization.py`** — `build_optimization_profile_block()` — pure function,
   trivially testable; verify each profile returns the expected anchors

3. **`article_pipeline.py`** — `execute_article_generation()` — needs mocking of OpenAI client;
   test the humanization branch logic (auto_humanize=False should skip but still audit)

4. **`generation_queue.py`** — `GenerationJob.to_json()` / `from_json()` round-trip;
   dedup key logic; queue depth counter

5. **`plan_gatekeeper.py`** — `is_trial_expired()`, `assert_plan_action()` — pure logic,
   fully testable without I/O

6. **`schedule_timing.py`** — user timezone conversion logic

7. **`core/security.py`** — `create_access_token` / `decode_token` round-trip

### Test patterns

```python
# Pure function test
from app.services.content_optimization import build_optimization_profile_block, VALID_PROFILES

def test_valid_profile_returns_nonempty_block():
    for profile in VALID_PROFILES:
        if profile == "none":
            assert build_optimization_profile_block(profile) == ""
        else:
            assert len(build_optimization_profile_block(profile)) > 0

def test_unknown_profile_returns_empty():
    assert build_optimization_profile_block("unknown_xyz") == ""
```

```python
# Service test with mock
from unittest.mock import AsyncMock, patch
import pytest

@pytest.mark.asyncio
async def test_humanization_skipped_when_disabled():
    with patch("app.services.integrity_engine.execute_structural_humanization") as mock_hum:
        mock_hum.return_value = {"md": "body", "passes": 0}
        # call pipeline with auto_humanize=False
        # assert mock_hum was NOT called
        ...
```

### Test for the `from __future__ import annotations` bug

Add a regression test that imports route modules and verifies their Pydantic models
can be instantiated without `ForwardRef` errors:

```python
def test_route_models_importable():
    from app.api.routes.articles import GenerateRequest
    from app.api.routes.auth import LoginRequest
    # These should not raise PydanticUserError at import or construction time
    req = LoginRequest(email="a@b.com", password="test")
    assert req.email == "a@b.com"
```

---

## Frontend Tests

### Running locally
```bash
cd frontend
npm run test:unit
# runs tsx --test on:
#   src/lib/overviewReadiness.test.ts
#   src/lib/articlePaths.test.ts
```

Uses Node's built-in test runner via `tsx` — no Jest, no Vitest.

### Existing tests
- `src/lib/overviewReadiness.test.ts` — tests `overviewReadiness.ts` project readiness score
- `src/lib/articlePaths.test.ts` — tests `articlePaths.ts` URL helpers
- `src/lib/articleEditorWordpress.test.ts` — tests WordPress article utilities

### Adding a new test
Co-locate the test file next to the module:
```
src/lib/myUtil.ts
src/lib/myUtil.test.ts
```

Then register it in the test script in `package.json`:
```json
"test:unit": "npx tsx --test src/lib/overviewReadiness.test.ts src/lib/articlePaths.test.ts src/lib/myUtil.test.ts"
```

### Pattern
```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { myFunction } from "./myUtil.js";

test("myFunction returns expected value", () => {
  assert.equal(myFunction("input"), "expected");
});
```

---

## Integration Testing

No integration tests exist today. When added, they should use a real MongoDB instance
(not a mock) — the historical lesson is that mocked Mongo tests pass while real migrations fail.

Recommended approach:
- Spin up a local MongoDB via Docker in CI
- Use a `test_` prefixed database
- Tear down and recreate between test runs

---

## E2E Testing

No Playwright or Cypress tests exist. Priority areas when added:
1. Login flow (register → verify email → login)
2. Article generation (create project → add prompts → generate → check status)
3. Schedule + publish flow

---

## Coverage Requirements

Currently: no enforced coverage threshold.
Target (to be enforced in CI once tests are added):
- Backend services: 60% line coverage minimum
- Core utilities (security, config, deps): 80% minimum
- Route handlers: integration tests preferred over unit mocks

---

## Security Testing

Automated via `.github/workflows/security.yml`:
- `pip-audit` — CVE scan of `requirements.txt` (fails on any known vulnerability)
- `npm audit --audit-level=high` — fails on high/critical npm vulnerabilities
- `gitleaks` — secret scanning on full git history

Run locally:
```bash
pip-audit -r backend/requirements.txt
cd frontend && npm audit --audit-level=high
gitleaks detect --source . --verbose
```

---

## Test Environment Variables

```bash
# backend/.env for test runs (or set inline)
FORCE_JSON_STORAGE=1
SECRET_KEY=ci-test-secret-key-not-used-in-production-0123456789
ENVIRONMENT=test
MONGODB_URI=                    # not needed with FORCE_JSON_STORAGE=1
OPENAI_API_KEY=test-key         # set to a dummy value if needed
```
