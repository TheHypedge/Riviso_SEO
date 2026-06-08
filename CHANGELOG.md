# Changelog

## 2026-06-08

### Fixed — Performance & Analysis tab (Overview + Insights)

Addressed all 5 issues from the `/impeccable critique` of the Performance & Analysis tab (`projects/[projectId]/page.tsx`, `tab === "performance"`):

- **Phantom `--aa-danger` token (P1):** trend-indicator colors referenced `var(--aa-danger, #ef4444)`, a CSS variable that was never defined — every "down" trend rendered the off-system fallback red instead of the design system's `--aa-error`. Replaced with `var(--aa-success)` / `var(--aa-error)`.
- **Second accent color in `.tableLink` (P1):** the base link style hardcoded a cyan/blue (`#60a5fa`/`#93c5fd`), against the design system's one-accent rule, while a separate override recolored it ember in only one of two tables. Unified the base class on the ember `color-mix` treatment and removed the redundant override.
- **Duplicated active-state styling (P2):** five inline `color-mix(...)` blocks reimplemented the same "active button" treatment at a ratio that diverged from the existing `.navItemActive`/`.articleRichToolBtn[aria-pressed]` patterns. Consolidated into one shared `.miniBtn[aria-pressed="true"]` rule.
- **Dead-end empty/disconnected states (P2):** "No analytics data yet…" and "Connect Search Console…" rendered as inert muted text with no path forward. Both now branch on connection status and surface an "Open Tools" CTA that jumps to the GSC connect flow.
- **Missing mobile breakpoint on Countries/Traffic-sources grid (P3):** the `1fr auto` grid had no responsive override (unlike `.analyticsChartBleed`). Extracted into `.analyticsInsightsGrid` with a `@media (max-width: 640px)` rule that stacks to a single column.

Files: `frontend/src/app/projects/[projectId]/page.tsx`, `frontend/src/app/page.module.css`
