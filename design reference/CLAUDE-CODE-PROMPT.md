# How to use this

1. Copy the six HTML mockups + `RIVISO-DESIGN-HANDOFF.md` + `tailwind.config.tokens.js` into your repo, e.g. a top-level `/design-reference` folder (delete it once the migration is done).
2. Open your project in VS Code with the Claude Code extension installed.
3. Open a Claude Code chat panel and paste the prompt below as-is (edit the bracketed parts if your file paths differ).
4. Let it work through the phases one at a time — review each diff before approving, don't let it run all phases unattended in one shot.

---

## Prompt to paste into Claude Code

```
I'm migrating my Next.js + Tailwind SaaS app (RIVISO) to a new design system.
Reference material is in /design-reference:
- RIVISO-DESIGN-HANDOFF.md — full design spec, token table, component inventory, and a page-by-page changelog of what changed and why
- tailwind.config.tokens.js — the exact color/radius/shadow/font tokens to merge into my real tailwind.config.js
- 6 HTML mockups (riviso-dashboard-redesign.html, riviso-overview-redesign.html, riviso-articles-redesign.html,
  riviso-scheduled-articles-redesign.html, riviso-site-audit-redesign-v2.html, riviso-seo-audit-redesign.html) —
  these are the literal visual reference. Open them, inspect the markup/CSS, and match spacing, colors, radii,
  and component structure exactly. Don't reinterpret or "improve" on them — implement what's there.

First, explore my existing codebase structure: find my component folder, my existing Button/Card/Table
components if any, my routing structure, and my current tailwind.config.js. Tell me what you find and
propose a mapping between the mockup components and my existing file structure before changing anything.

Then work in this order, and stop for my review after each phase:

PHASE 1 — Tokens & fonts
Merge tailwind.config.tokens.js into my real tailwind.config.js (don't overwrite unrelated config).
Add Inter (sans) and JetBrains Mono (mono) via next/font/google in the root layout. Remove any serif
font currently used for page titles. Set the base app background/text color per the token table in
the handoff doc.

PHASE 2 — Shared components
Build or refactor these in my components/ui folder, matching the mockups exactly:
Button (primary/secondary/ghost/danger-outline, sizes default/sm), Card, StatusPill
(published/scheduled/draft/warning/danger variants), StatCard (with a "hero" tinted variant),
Gauge (circular SVG score ring with red/amber/green zone bands), DonutChart, BarRow (horizontal
category bar), DataTable, Sidebar (with NavGroup/NavItem/SubNav for expandable sections like Site
Audit), Breadcrumb, EmptyStateCard (icon + title + description + button, for "not connected" states).

PHASE 3 — Sidebar & IA restructure
Reorganize the sidebar nav into three groups per the handoff doc: Content (Overview, Articles,
Research, Scheduled Articles), Automation (Prompts, Context Links, Tools), Configure (Members,
Project Settings, Site Audit → expandable into Technical Audit + SEO Audit). Keep existing routes
unchanged — this is a labeling/grouping change, not a routing change, unless I tell you otherwise.

PHASE 4 — Page migrations, one at a time, in this order:
1. Dashboard (Projects list) — match riviso-dashboard-redesign.html
2. Project Overview — match riviso-overview-redesign.html
3. Articles table — match riviso-articles-redesign.html
4. Scheduled Articles — match riviso-scheduled-articles-redesign.html
5. Site Audit / Technical Audit — match riviso-site-audit-redesign-v2.html
6. Site Audit / SEO Audit — match riviso-seo-audit-redesign.html
For each page: read my existing page component, identify what data it currently fetches/renders,
then rebuild the JSX to match the mockup's structure while preserving all existing functionality,
data bindings, and event handlers. Don't remove or break any working logic — only change markup,
styling, and component usage. Show me the diff before applying it.

After all phases: list any pages NOT covered by the mockups (Prompts, Context Links, Tools, Members,
Project Settings) and propose how to apply the same design system to them using the shared components
from Phase 2, since they'll mostly reuse Card/Button/Table/EmptyStateCard patterns already built.

Ask me before starting Phase 1.
```
