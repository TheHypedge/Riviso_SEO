# RIVISO — Design System & Dev Handoff

Reference mockups (open directly, inspect via browser devtools for exact values):
- `riviso-dashboard-redesign.html` — Projects dashboard
- `riviso-overview-redesign.html` — Project Overview
- `riviso-articles-redesign.html` — Articles table
- `riviso-scheduled-articles-redesign.html` — Scheduled Articles
- `riviso-site-audit-redesign-v2.html` — Site Audit → Technical Audit
- `riviso-seo-audit-redesign.html` — Site Audit → SEO Audit

All six share one design system (Section 2) and one sidebar/topbar shell (Section 4) — build the shell once, then swap the `<main>` content per page.

---

## 0. Per-screen changelog (what changed and why, page by page)

### Dashboard (Projects list)
- Unified typography: killed the serif/sans mix, Inter only, hierarchy via weight/size.
- Warm neutral background (`bg`/`surface`/`surface-sunken`) replacing pure black — depth from tone, not just borders.
- Accent orange restricted to primary button, active nav, and genuine attention states.
- Sidebar grouped into Workspace / Manage instead of a flat list.
- Added a stats row (Total / Connected / Needs attention / Last synced) above the grid.
- Project cards: platform shown as a colored chip + status dot (WordPress=blue, Shopify=green); "NOT CONNECTED" restyled as an actionable warning tint instead of a broken-looking gray box.
- Added a topbar (search, notifications, primary actions) — previously missing entirely.

### Project Overview
- Sidebar shows the full grouped IA (Content / Automation / Configure), current project pinned in its own card.
- "Total articles" promoted to a hero stat card (tinted background) — the number that matters most gets visual priority.
- Search Console empty state redesigned as a calm actionable card (icon + explanation + button), not a warning bar.
- Publishing Activity chart rebuilt with an inline legend showing live counts and highlighting the active series.
- Breadcrumb replaces the old "← Back to dashboard" + large serif title.

### Articles table
- Status turned into color-coded pills (green=Published, blue=Scheduled, gray=Draft).
- Filters consolidated into one labeled toolbar card (Status / From / To / Sort) instead of loose inline controls.
- Plan-limit badges compressed into pill chips instead of three wide gray boxes.
- Row actions grouped into a tight icon cluster; delete visually distinct (red hover) from neutral actions.
- Title/keyphrase/keywords columns given real typographic hierarchy (bold title, mono keyphrase, muted keywords).
- Table given breathing room: taller rows, header background, hover state, rounded container.

### Scheduled Articles
- Rows turned into a timeline list with a dedicated date block (day + month) as the primary scannable anchor.
- Actions rebalanced: "Post now" primary (accent-tinted), "Re-schedule" neutral, "Cancel" clearly destructive (red outline).
- Posted items get a green-tinted date block + inline "View live ↗" link instead of a separate button breaking row rhythm.
- Status pill added per row for at-a-glance scanning.
- "Retry all failed" promoted to the topbar as an outlined-danger action.

### Site Audit — Technical Audit
- Consolidated three redundant headers (title / site-URL card / tabs-with-scores) into one compact header block.
- Actions (Re-run audit, Export, Compare audits) moved into the page header, contextual to this audit.
- Gauge redesigned with real Lighthouse-style red/amber/green zone bands behind the score arc.
- Metric cards (Performance/Accessibility/Best Practices/PageSpeed SEO) get mini progress bars colored by zone.
- Insight bar restyled as a real callout (icon + amber tint + one focused sentence) instead of a plain caption.
- Trend chart rebuilt with axis date labels, live legend values, and end-point markers.
- Added an "SEO Audit" side panel snapshot so both audit types feel like one connected system.

### Site Audit — SEO Audit
- Donut chart for Indexability Breakdown (Indexable vs Non-indexable) with center total + descriptive legend.
- New horizontal bar chart: "Warnings by category" (meta description / title tags / alt text / heading structure) — didn't exist before, gives users a "where to focus" view.
- Top Issues rebuilt as a real data table: severity pills (Medium/Low), inline mini progress bars, affected-URL counts.
- New Page Explorer preview table: URL, crawl status, HTTP code, indexability, internal link count.
- Crawl stat strip (6 cards) color-coded by severity (green issues, amber warnings, blue opportunities).
- Sub-tab row (Overview / Issues / Page Explorer / Crawl History / Site Structure "Soon" / Segments "Soon" / Reports "Soon") as a proper segmented control.
- Shares the same audit-header/tab system as Technical Audit — score badges on both tabs for quick switching.

---

## 1. Setup

1. Merge `tailwind.config.tokens.js` into your existing `tailwind.config.js` (`theme.extend`).
2. Add Inter + JetBrains Mono to `app/layout.tsx` via `next/font/google`:
   ```tsx
   import { Inter, JetBrains_Mono } from 'next/font/google';
   const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });
   const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });
   ```
3. Set `<body className={`${inter.variable} ${mono.variable} font-sans bg-bg text-ink`}>`.
4. Delete any serif font import used for page titles — the whole app now uses one typeface family, weight does the work of hierarchy.

---

## 2. Design tokens (source of truth)

| Token | Value | Use |
|---|---|---|
| `bg` | `#FAFAF8` | App background |
| `surface` | `#FFFFFF` | Cards, sidebar, topbar |
| `surface-sunken` | `#F4F3F0` | Table headers, input backgrounds, nav hover |
| `border` | `#E8E6E1` | Default dividers |
| `border-strong` | `#D8D5CE` | Input borders, hover borders |
| `ink` | `#1B1A17` | Primary text |
| `ink-secondary` | `#6E6B64` | Secondary text, labels |
| `ink-tertiary` | `#A6A29A` | Placeholder, meta text |
| `accent` | `#E15A2C` | Primary actions, active nav, links — **only** |
| `success` | `#2E8B57` / tint `#E7F4EC` | Published, good scores |
| `warning` | `#B8770B` / tint `#FBF1DE` | Needs-improvement, pending |
| `info` | `#3B6FE0` / tint `#EAF0FE` | Scheduled, WordPress platform tag |
| `danger` | `#C13B2D` / tint `#FDECEA` | Delete, cancel, non-indexable |

**Rule:** accent orange is reserved for primary actions and the single active nav state. Never use it for decorative emphasis — that's what made the old UI feel noisy.

Radii: `sm 6px` (buttons, inputs, chips) · `md 10px` (small cards) · `lg 14px` (main cards, containers).

Shadows: `xs` for resting cards, `sm`/`md` on hover only — don't stack heavy shadows on static elements.

---

## 3. Component inventory to build (shared, reused across every page)

Build these once in `/components/ui/`:

- **`Button`** — variants: `primary` (accent fill), `secondary` (outline), `ghost`, `danger-outline`. Sizes: `default`, `sm`.
- **`Card`** — `bg-surface border border-border rounded-lg shadow-xs`, optional hover-lift variant for clickable cards (dashboard project cards).
- **`StatusPill`** — props: `status: 'published' | 'scheduled' | 'draft' | 'warning' | 'danger'`, renders colored dot + label per the mapping in the token table above.
- **`StatCard`** — value + label + optional sublabel + optional "hero" variant (tinted background for the standout metric).
- **`Gauge`** — circular SVG score ring, props: `value`, `max`, `status`. Reuse across Technical Audit and SEO Audit.
- **`DonutChart`** — reuse the SEO Audit "Indexability breakdown" pattern for any two/three-way split.
- **`BarRow`** — labeled horizontal bar for category breakdowns (used in "Warnings by category").
- **`DataTable`** — header row on `surface-sunken`, row hover on `surface-sunken`, no vertical dividers, generous `py-3.5` row padding.
- **`Sidebar`** — grouped nav (`NavGroup` + `NavItem` + optional `SubNav` for expandable sections like Site Audit).
- **`Breadcrumb`** — replaces the old "← Back to dashboard" link pattern on project-scoped pages.
- **`EmptyStateCard`** — the "not connected" pattern (icon + title + description + primary button), used for Search Console, WordPress, Shopify connection prompts.

---

## 4. Information architecture change

Current sidebar (flat, 10 items) → grouped into:

- **Content**: Overview, Articles, Research, Scheduled Articles
- **Automation**: Prompts, Context Links, Tools
- **Configure**: Members, Project Settings, Site Audit (expandable → Technical Audit, SEO Audit)

This is a navigation/routing change, not just visual — confirm with your team whether route structure changes or only the sidebar grouping/labels change (recommend: labels/grouping only, keep existing routes to avoid breaking links).

---

## 5. Rollout order (recommended)

1. Tokens + fonts (global, low risk, immediate visual lift everywhere)
2. `Button`, `Card`, `StatusPill` (used on nearly every page)
3. `Sidebar` (biggest structural/IA change — do this once, carefully)
4. Dashboard page (highest traffic, good validation point)
5. Data-heavy pages: Articles, Scheduled Articles (DataTable component)
6. Site Audit (Gauge, DonutChart, BarRow — most novel components)
7. Remaining settings-style pages (Prompts, Context Links, Members, Tools, Project Settings) — these mostly reuse Card/Button/form patterns already built.

---

## 6. Applying this in your actual repo

This chat can't see or edit your codebase directly. To apply it hands-on:

- **Claude Code** (terminal, VS Code/JetBrains extension, or desktop app) can open your Next.js repo directly, read these mockup HTML files + this spec, and refactor your components/pages to match — file by file, with you reviewing diffs as it goes.
- Point it at: this MD file + the six HTML mockups + your existing component folder, and ask it to start with step 1 (tokens) through step 7 (rollout) in order.
