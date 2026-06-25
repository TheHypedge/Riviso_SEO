---
target: projects/[projectId] articles table + sidebar
total_score: 26
p0_count: 2
p1_count: 2
timestamp: 2026-06-07T10-52-24Z
slug: p-projects-projectid-page-tsx-articles-tab-sidebar
---
# Critique: Articles List (Table) + Project Sidebar

**Target:** `frontend/src/app/projects/[projectId]/page.tsx` — `tab === "articles"` (toolbar, table, pagination, modals, ~lines 5749-6243) and `<aside className={styles.sidebar}>` (~lines 5221-5325)

**Method:** Two independent, isolated assessments — Assessment A (design review: source + live browser inspection) and Assessment B (detector scan + browser/contrast evidence) — synthesized below.

## Design Health Score: 26/40

| Heuristic | Score | Notes |
|---|---|---|
| 1. Visibility of system status | 2/4 | Keyboard focus indicator measured at ~1.03:1 contrast (WCAG 2.4.11 needs ≥3:1) — effectively invisible on `.navItem`/`.articlesToolbarBtn`; GSC indexing status exposed only via hover `title` (invisible on touch) |
| 2. Match between system and the real world | 3/4 | "Bulk Upload"/"Export"/"Schedule" map to real mental models; "Focus Keyphrase"/"Supporting Keywords" are unexplained Yoast-derived jargon for newcomers |
| 3. User control and freedom | 3/4 | Conditional Clear-filters, bulk popup "Back to actions" escape, modal close paths; no "deselect all" once a page is fully selected, no undo after bulk delete |
| 4. Consistency and standards | 2/4 | Sidebar hardcodes "CURRENT PROJECT"/"SECTIONS" in the same `.sidebarTitle` slot the dashboard sidebar deliberately moved to sentence case in commit 861e708; toolbar mixes ≥4 button visual treatments at identical weight |
| 5. Error prevention | 3/4 | Delete confirm modal, 10-min schedule minimum with explicit copy, "Edit" disabled+explained unless exactly 1 selected; bulk delete of N items has no count-aware warning |
| 6. Recognition rather than recall | 3/4 | Filter labels persistent, selection count always visible, `aria-label`s on row actions present/correct (verified) — but visually, 5 icon-only row actions differ only by hover tooltip |
| 7. Flexibility and efficiency of use | 3/4 | Multi-select, bulk actions, export inherits active filter state (genuinely good); no "select all matching filter" beyond current page, no shortcuts |
| 8. Aesthetic and minimalist design | 2/4 | 11 simultaneous toolbar controls + up to 5 icon actions per row (≈59 interactive targets on one page of 8) at uniform visual weight, no progressive disclosure |
| 9. Help recognizing/diagnosing/recovering from errors | 3/4 | Inline modal errors, calm empty-state copy — but identical empty-state text for "no data yet" vs "filters too narrow" |
| 10. Help and documentation | 2/4 | No inline help for SEO-jargon columns; empty state has no onward CTA; the one piece of excellent microcopy (schedule-time helper text) shows what's possible elsewhere |

## Anti-Patterns Verdict: Mostly clean — two real tells, zero confirmed detector hits in scope

The automated scanner (`detect.mjs`) returned **0 findings** for the markup file directly, and **0 of its 7 CSS-level findings land validly in scope**: six are in entirely different surfaces (article prose/readonly rendering at lines 2940/3221, the content-cluster planner at 4997/5037/5101, the overview readiness gate at 7579 — none reachable from the articles tab or this sidebar), and the seventh — `.sidebar { border-right: 1px solid var(--aa-hairline) }` (page.module.css:3434) — is a **confirmed false positive**: `--aa-hairline` resolves to ~10%-opacity white, a standard 1px neutral panel divider, not the "thick colored accent stripe" the side-tab rule targets.

That said, the design review surfaced two genuine, non-automatable "AI slop" tells the scanner can't see:

1. **Regressed uppercase eyebrows** — "CURRENT PROJECT"/"SECTIONS" (page.tsx:5265, 5295) are typed in all-caps directly into JSX, in the same `.sidebarTitle` slot the sibling dashboard sidebar deliberately converted to sentence case ("Workspace"/"Admin"/"Account") as part of the shipped a11y/polish audit (commit 861e708). The CSS class carries no `text-transform` — confirmed by both assessments — so this is a hand-typed regression, not styling residue.
2. **Borrowed palette** — the status-pill colors (`#ff4d4f`/`#d89614`/`#52c41a`-family, page.module.css:2664-2694) are Ant Design's stock semantic palette, dropped into a bespoke void+ember system that derives every other accent from `--aa-primary`/`color-mix()`. It's the one place in this surface where the design system's voice audibly drops.

## Overall Impression

This is a **custom-built, considered surface, not templated output** — the bulk-actions popup's progressive disclosure, the export dialog's filter-state inheritance, and the sidebar's deliberate IA (there's even a code comment explaining why the project switcher gets its own visual rhythm) all show real product thinking, and the detector confirms there's no mechanical AI-slop scaffolding here. But it reads like a surface that **accreted controls and states over time without a later consolidation pass**: a status-color system borrowed wholesale from a different design language, a sidebar label convention that drifted from its sibling after that sibling was fixed, and a toolbar that grew to 11 same-weight controls with no grouping logic. None of these are hard to fix individually — which is exactly what makes them worth fixing now, before the surface grows further.

## What's Working

1. **Export inherits active filter state** (page.tsx:6013-6019) — a user who filtered to "Published, last 30 days" doesn't have to re-specify that in the export dialog. Small, real empathy for continuity of intent.
2. **Bulk-actions progressive disclosure** (page.tsx:5796-5912) — root menu → labeled "Back to actions" sub-menu → status options as colored dots, plus `disabled`+`title` pairing that *teaches* the "select exactly 1 to edit" constraint instead of silently failing.
3. **Mobile card layout uses semantic `<dl>`/`<dt>`/`<dd>`** (page.tsx:6182-6193) — a notch above the common "shrink the table" mobile anti-pattern, verified to render with no overflow/clipping at 390px.
4. **Row-action `aria-label`s are complete and per-item** (verified: `Edit ${title}`, `Delete ${title}`, etc., page.tsx:3791-3866) — screen-reader users get unambiguous, titled labels even though sighted users only get hover tooltips.
5. **The schedule-time helper copy** ("Times are interpreted in your profile timezone… the article needs ~6-8 minutes to fully prepare," page.tsx:6289-6291) is unusually good microcopy — specific and honest about system constraints. It's proof the team can write this way; the rest of the surface should match it.

## Priority Issues

### P0 — Status-pill color mapping is semantically inverted, and "Scheduled" renders as an invisible pill
**Where:** `statusPillClass()` page.tsx:3778-3784; `.statusPending`/`.statusNeutral` page.module.css:2672-2676, 2690-2694
**What's wrong:** "Pending" — a routine, expected queue state — renders in alarm-red `#ff4d4f`, the universal "broken/blocked" signal, while "Scheduled" — a real, user-filterable status (`<option value="scheduled">`, line 5942) representing *more* progress than pending — has no branch in the switch and falls through to `.statusNeutral`. Assessment B measured `.statusNeutral`'s rendered chrome on the actual dark canvas: background composites to `rgb(10,10,12)` and border to `rgb(9,9,11)` — within **1-2 RGB units of the canvas itself** (`rgb(11,11,13)`). A scheduled article's pill would show text with no visible chrome at all: a borderless, backgroundless label, the only one of four statuses that doesn't look like a pill.
**Fix:** Add a `scheduled` branch to `statusPillClass()` and a `.statusScheduled` class built from the project's own tokens (an info/amber-adjacent `color-mix()` off `--aa-primary`, not `rgba(0,0,0,…)`); reconsider whether "pending" should carry alarm-red at all — a neutral-to-cool tone reads as "queued," not "broken."
**Suggested command:** `/impeccable colorize frontend/src/app/projects/[projectId]/page.tsx — status pill palette (replace Ant-Design-derived colors with void+ember tokens, add missing "scheduled" state)`

### P0 — Keyboard focus indicators measure at ~1:1 contrast — effectively invisible
**Where:** `.navItem`, `.articlesToolbarBtn`, `.articlesTableIconBtn` — no `:focus`/`:focus-visible` rules exist (confirmed via grep); they fall back to the browser default outline
**What's wrong:** Assessment B focused these elements directly and read computed styles: the UA-default outline renders as `rgb(16,16,16)` against a canvas of `rgb(11,11,13)` — a measured **1.03:1 contrast ratio**, roughly a third of the WCAG 2.4.11/1.4.11 minimum of 3:1 for focus indicators. A keyboard user tabbing through the sidebar's SECTIONS nav or the articles toolbar (Bulk Upload, Export, Actions…) cannot see where focus is. The fix pattern already exists two components away — `.articlesFilterControl` *does* have a working custom focus ring (`box-shadow: 0 0 0 3px`, ember-tinted).
**Fix:** Apply the `.articlesFilterControl` focus-ring pattern (or a shared `:focus-visible` utility) to `.navItem`, `.articlesToolbarBtn`, and `.articlesTableIconBtn`; consider a baseline `*:focus-visible` rule in `globals.css` so new components inherit visibility by default.
**Suggested command:** `/impeccable harden frontend/src/app/projects/[projectId]/page.tsx — focus-visible states for sidebar nav, toolbar buttons, and row-action icon buttons`

### P1 — Sidebar labels regress a fix the project already shipped
**Where:** page.tsx:5265 (`"CURRENT PROJECT"`), page.tsx:5295 (`"SECTIONS"`) vs. dashboard/page.tsx:797, 839 (`"Workspace"`, `"Admin"`, `"Account"`)
**What's wrong:** Both sidebars share the identical `.sidebarTitle` class (page.module.css:3527, no `text-transform`). The dashboard sidebar was deliberately moved to sentence case in the shipped P1-P3 a11y/polish audit (commit 861e708) specifically to remove shouty uppercase labels — recorded in project memory as intentional. This sidebar, reached one click away, hand-types the all-caps strings back into the same slot. It reads as two surfaces designed by two different people at two different times.
**Fix:** Change the literal strings to "Current project" / "Sections".
**Suggested command:** `/impeccable clarify frontend/src/app/projects/[projectId]/page.tsx — sidebar eyebrow labels (match sentence-case convention from dashboard sidebar)`

### P1 — Empty state is a dead end that can't tell "no data yet" from "filters too narrow"
**Where:** page.tsx:6064, 6150 — `"No articles match the current filters."`
**What's wrong:** This exact sentence renders whether the project has zero articles ever (the realistic state behind `/projects/test`, "Page 1/1 · 0 item(s)") or the user's Status/From/To filters happen to exclude everything. Neither case gets a next step: no link to the page-header "+ Add article" button, no one-click "Clear filters" even though the toolbar's Clear button is right there. For a first-time user this reads as "you searched and found nothing," not "you haven't started yet" — an emotionally orphaning moment with an easy fix.
**Fix:** Branch the message: zero-articles-ever → "No articles yet — generate your first one" + inline CTA; filtered-to-empty → "No articles match these filters" + inline "Clear filters" action.
**Suggested command:** `/impeccable onboard frontend/src/app/projects/[projectId]/page.tsx — articles empty state (differentiate first-run vs. filtered-empty, add inline CTAs)`

### P2 — The toolbar surfaces 11 same-weight controls with no grouping logic
**Where:** page.tsx:5917-6041
**What's wrong:** Three informational limit-status chips, four filter fields, a conditional Clear, Bulk Upload, Export, and the selection/Actions cluster — eleven controls, all rendered at the same 34px gray-pill weight, separated by exactly one hairline divider. The three chips (purely informational quota displays) sit visually *first and most prominent*, ahead of the actual task controls. Combined with up to 5 icon actions per row, a page of 8 articles presents roughly **59 interactive targets** with nothing in font-weight, color, or spacing distinguishing "do this often" from "do this rarely."
**Fix:** Group by frequency/intent — collapse the limit chips into a compact status strip (or de-emphasize their position), visually separate "filter" controls from "bulk operation" controls beyond a single hairline (background tint, spacing block, labeled group), and let Bulk Upload/Export read as secondary relative to the filter row.
**Suggested command:** `/impeccable layout frontend/src/app/projects/[projectId]/page.tsx — articles toolbar grouping and visual hierarchy`

### P2 — Five icon-only row actions depend entirely on hover; "Delete" differs from siblings only by color
**Where:** `renderArticleActions()` page.tsx:3791-3866; mirrored in `.articlesMobileActions` (~line 6194)
**What's wrong:** Edit/Schedule/Request-indexing/Mark-fresh-or-stale/Delete are bare icon buttons differentiated only by a custom hover-only `data-tooltip`. `aria-label`s are present and correct (verified — not a screen-reader problem), but on touch devices there is no hover: the only way to learn what an icon does is tap-and-see, an uncomfortable discovery model when one of five options permanently deletes the row. The danger button is set apart from its siblings by color alone — a gap for color-blind users.
**Fix:** Give Delete (and ideally all five) an always-visible textual affordance on touch/narrow viewports — e.g. a labeled overflow menu instead of a bare icon row below a breakpoint — and add a non-color cue (icon weight, divider, grouping) to set the destructive action apart.
**Suggested command:** `/impeccable adapt frontend/src/app/projects/[projectId]/page.tsx — touch affordances for icon-only row actions`

### P3 — Hardcoded z-index values bypass the project's own semantic scale
**Where:** `.toast` page.module.css:5716 (`z-index: 1200`), `.modalBackdrop`/`.modal` page.module.css:6841/6854 (`z-index: 60`/`61`)
**What's wrong:** `globals.css` defines `--z-toast: 500`, `--z-modal-bg: 300`, `--z-modal: 400` — but these in-scope rules (the toast shown from the shell, and the backdrop/modal pairing used by every articles-tab modal: delete-confirm, schedule, request-indexing) use untracked literals instead. `1200` sits *above* every defined token including `--z-tooltip: 600` — a stacking surprise waiting to happen the day a tooltip needs to outrank a toast.
**Fix:** Replace the literals with the existing tokens (`var(--z-toast)`, `var(--z-modal-bg)`, `var(--z-modal)`).
**Suggested command:** direct fix — small and mechanical; fold into the next `/impeccable polish` pass if you'd rather batch it.

## Persona Red Flags

- **Sam (accessibility):** Two measured failures, not impressions — keyboard focus contrast at **1.03:1** (need ≥3:1) across the sidebar nav and toolbar buttons, and GSC indexing status exposed *exclusively* through a `title` hover attribute (invisible to screen readers and touch alike).
- **Jordan (first-time user):** Lands on 11 toolbar controls and SEO-jargon columns ("Focus Keyphrase," "Supporting Keywords") with zero inline explanation, then meets an empty state that states a fact and offers no path forward — three compounding moments of "did I do something wrong?"
- **Casey (mobile/touch):** The exact icon-only-row-action pattern that depends on hover repeats verbatim in the mobile card layout (`.articlesMobileActions`); on a touch device, "what does this icon do" becomes "tap it and find out" — including for Delete.

## Minor Observations

- Status-pill text is rendered `.toUpperCase()` (page.tsx:6073) — uppercase pill text in the same family as the sidebar-eyebrow drift; worth resolving together if you're touching the status system anyway.
- `.statusPublished`'s measured contrast (4.52:1 against its own composited background) is the tightest of the three confirmed pill colors — technically AA-passing but the least comfortable margin; if you're already replacing the palette (P0 #1), give it a touch more headroom.
- The active sidebar nav-item treatment (a ~14%-opacity ember tint, no border) is restrained and on-brand — worth using as the reference point when re-grouping the toolbar (P2), since it shows the system already knows how to signal "current/active" without shouting.

## Questions to Consider

1. If "scheduled" is a real, user-filterable status that's been in the dropdown long enough to ship, how did it ship without a matching pill style — and is there a content/status registry anywhere that should make "add a status, get a pill for free" the default?
2. The dashboard sidebar's labels were sentence-cased specifically to fix an a11y/polish issue (861e708) one click away from this sidebar, which still hardcodes the old convention — is there a shared labeling guideline, or does each surface currently reinvent its own casing as it's built?
3. Is the toolbar's current flat list of 11 controls a deliberate "show everything, always" choice for power users, or did it grow one filter/button at a time without a later pass asking "does a first-time user need to see all of this on day one?"
