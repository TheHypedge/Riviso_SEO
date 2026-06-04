# skills/frontend.md — Frontend Conventions

## Stack
- **Next.js 16** (App Router) — `frontend/src/app/`
- **React 19** — functional components + hooks only; no class components
- **TypeScript 5** — strict mode; all types explicit
- **CSS Modules** — one `.module.css` per page or component

---

## Directory Structure

```
frontend/src/
├── app/                         # Next.js App Router pages
│   ├── layout.tsx               # Root layout (AppProviders wrapper)
│   ├── page.tsx                 # Landing / redirect
│   ├── globals.css              # Global CSS reset + CSS variables
│   ├── dashboard/page.tsx       # Workspace dashboard
│   ├── login/page.tsx           # Auth page (login/register/verify)
│   ├── projects/
│   │   └── [projectId]/
│   │       ├── page.tsx         # Project tabs (Articles / Prompts / Research / Schedule / Cluster)
│   │       ├── articles/[articleId]/page.tsx   # Article editor
│   │       └── connect-shopify/page.tsx        # Shopify OAuth callback
│   └── reset-password/page.tsx
├── components/                  # Shared reusable components
│   ├── subscription/            # Trial countdown + upgrade modal
│   ├── bulkSchedule/            # Bulk schedule modal + hooks
│   ├── shopify/                 # Shopify connect panel
│   ├── wordpress/               # WP page map picker
│   └── skeleton/                # Loading skeleton components
├── lib/                         # Pure utility / logic (no JSX)
│   ├── api.ts                   # ALL backend calls — single source of truth
│   ├── pipelineStream.ts        # SSE generation stream client
│   ├── articleEditorCache.ts    # localStorage draft persistence
│   └── *.ts                     # Other pure logic helpers
├── hooks/                       # Custom React hooks
└── content/                     # Static content (tutorial steps, etc.)
```

---

## Component Patterns

### Page components
- Each page is a `default export` async or client component in `app/*/page.tsx`
- Data loading: `useEffect` + `useState` — not `getServerSideProps` or RSC data fetching
  (the app is client-heavy; most state is user-interactive)
- Tab-based pages (like project page) use a `activeTab` state string to conditionally render tab content

```tsx
const [activeTab, setActiveTab] = useState<"articles" | "prompts" | "research">("articles");
```

### Shared components
- `components/` holds components used across more than one page
- Keep components focused — one responsibility per file
- Use `ComponentName.tsx` + `componentName.module.css` co-located naming

### Loading states
- Use the `Skeleton` component from `components/skeleton/` for content placeholders
- Loading booleans: `const [loading, setLoading] = useState(true)`
- Error states: `const [error, setError] = useState<string | null>(null)`

---

## State Management

No global state library. Use:

1. **Local `useState`** — for UI state within a component
2. **`useEffect` + API call** — for data fetching on mount / dependency change
3. **`projectsCache.ts`** — in-memory cache for project list within a session (avoids refetching on tab switch)
4. **`articleEditorCache.ts`** — localStorage for article editor drafts (persists across page refresh)
5. **Context providers** (limited use):
   - `AppProviders.tsx` — wraps the app; includes `SubscriptionProvider`
   - `GlobalLoadingProvider.tsx` — spinner for full-page loads
   - `SubscriptionProvider.tsx` — trial status + countdown banner

Avoid prop drilling beyond 2 levels — use a context provider instead.

---

## API Calls

**All backend communication goes through `frontend/src/lib/api.ts`.**

Never use raw `fetch()` in components. Always use the typed functions in `api.ts`.

```typescript
// Correct
const articles = await api.getArticles(projectId);

// Wrong — never do this
const res = await fetch('/api/projects/123/articles');
```

### Routing logic
`getApiBaseUrl()` in `api.ts` determines the API base URL:
- Returns `""` (empty) when running on `RIVISO_APP_HOSTS` domains → uses same-origin Next.js proxy
- Returns the explicit `NEXT_PUBLIC_API_BASE_URL` or `http://127.0.0.1:8000` when on other origins

```typescript
const RIVISO_APP_HOSTS = new Set([
  "riviso.com", "www.riviso.com", "app.riviso.com",
  "riviso.cloud", "www.riviso.cloud", "app.riviso.cloud",
]);
```

### Timeouts
```typescript
const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_API_TIMEOUT_MS = 600_000;  // generation, research, bulk ops
```

Always use `LONG_API_TIMEOUT_MS` for:
- Article generation (`generateArticle`)
- Research ideas (`researchIdeas`)
- Bulk upload/export
- WordPress publish

### CSRF header
Every mutating API call (POST / PUT / PATCH / DELETE) must include:
```typescript
headers: { "X-Requested-With": "XMLHttpRequest" }
```
This is already built into the `api.ts` helpers — don't bypass it.

### Generation polling
Use `pollWithBackoff` for generation status:
```typescript
await pollWithBackoff(articleId, projectId, onProgress);
```
- Exponential backoff from 1s → 8s
- Throws immediately when `generation_error` is set (don't keep polling a failed job)

---

## Styling Standards

### CSS Modules
- One `.module.css` file per page (`page.module.css`) or component (`componentName.module.css`)
- Classes use camelCase: `.articleCard`, `.headerRow`
- No `!important` — redesign the specificity instead

### No inline styles except dynamic values
```tsx
// OK — dynamic value driven by state
<div style={{ width: `${progress}%` }} />

// Not OK — static values belong in CSS
<div style={{ padding: "16px", color: "#333" }} />
```

### CSS variables
Global CSS variables defined in `globals.css`:
- Use them for colors, spacing, font sizes — do not hardcode hex values in component CSS
- Example: `var(--color-primary)`, `var(--spacing-md)`

### No Tailwind, no styled-components, no CSS-in-JS

---

## TypeScript Conventions

- All API response types defined in `api.ts` — keep them co-located with the functions that use them
- No `any` without a comment explaining why
- Use `undefined` (not `null`) for optional fields in function parameters; use `null` for optional DB fields coming from the backend (backend uses `None` → JSON `null`)
- Always type `useState`: `useState<string | null>(null)`, `useState<Article[]>([])`

---

## Form Patterns

No form library (no react-hook-form). Pattern:

```tsx
const [value, setValue] = useState("");
const [saving, setSaving] = useState(false);
const [error, setError] = useState<string | null>(null);

async function handleSubmit(e: React.FormEvent) {
  e.preventDefault();
  setSaving(true);
  setError(null);
  try {
    await api.updateSomething(value);
  } catch (err) {
    setError(err instanceof Error ? err.message : "Unknown error");
  } finally {
    setSaving(false);
  }
}
```

---

## Pipeline SSE Stream

Generation uses a Server-Sent Events stream via `frontend/src/lib/pipelineStream.ts`:

```typescript
streamPipeline(articleId, projectId, {
  onStage: (stage, msg) => { /* update UI stage indicator */ },
  onComplete: () => { /* generation done */ },
  onError: (err) => { /* show error */ },
});
```

Stage constants: `STAGE_OPENAI_DISPATCH`, `STAGE_HUMANIZATION`, `STAGE_INTEGRITY_VERIFY`,
`STAGE_INTERNAL_LINKS`, `STAGE_FEATURED_IMAGE`, `STAGE_COMPLETE`

---

## Testing

Unit tests use Node's built-in test runner (`tsx --test`):
```bash
npm run test:unit
# runs: src/lib/overviewReadiness.test.ts src/lib/articlePaths.test.ts
```

Test files are co-located with the lib file: `articlePaths.ts` → `articlePaths.test.ts`

No React component tests yet. Lint runs as part of CI.

---

## Adding a New Page

1. Create `frontend/src/app/your-route/page.tsx`
2. Add CSS module `frontend/src/app/your-route/page.module.css` if needed
3. Link from an existing page (no automatic route registration needed)
4. Add any new API calls to `frontend/src/lib/api.ts`
5. Add types to `api.ts` before using them in the component

## Adding a New UI Setting to a Project

1. Add the type to `ProjectSettings` and the patch type in `api.ts`
2. Add `useState` for the setting in `projects/[projectId]/page.tsx`
3. Initialize from `settings` in the `useEffect` that loads the prompts tab
4. Include the field in `savePrompts()` → `api.updateProjectSettings(projectId, { ... })`
5. Add the UI control to the Prompts tab card section
