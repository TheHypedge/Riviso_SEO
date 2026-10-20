# Changelog

## 2026-10-20 (Technical Audit v2)

### Changed — Technical Audit screen rebuilt to match PageSpeed Insights
- New tab strip (Overview · Performance · Accessibility · Best Practices · SEO) with a shared Mobile/Desktop switch and "N to fix" counts.
- Overview: Performance Score with Lighthouse bands; Core Web Vitals with a Field Data / Lab Data switch, the real-user assessment and distribution bars; Other Key Metrics; Performance Opportunities with metric filters, sorting, an Impact column and inline "Show how"; Page Preview (Lighthouse screenshot); Audit Details (Lighthouse version, device, duration, run warnings, View on PageSpeed Insights, Download report as JSON); Diagnostics with All/Passed/Warnings/Failed filters; link to the SEO Audit.
- Category tabs list every Lighthouse audit grouped like PageSpeed Insights: failing groups, then passed, not applicable and manual checks.
- "Learn about this audit" explains lab vs real-user data, devices and the Riviso Technical Health Score.

### Fixed
- Lab metrics no longer show a real-user status next to a lab value (a 17 s mobile LCP was labelled "Good").
- TTFB shows a value instead of Lighthouse's sentence.
- Lighthouse run warnings (e.g. the page returned 502) are now shown instead of silently reporting a perfect score.

## 2026-10-20

### Added — SEO Audit: pages that could not be crawled are now reported

- Pages that timed out, refused the connection, or got stuck in a redirect loop now appear as issues ("Page timed out", "Page could not be fetched", "Redirect loop or too many redirects") instead of silently disappearing from the report. URLs that Riviso's own safety guard refuses to fetch are not reported as site problems.
- New warning "Linked page blocked by robots.txt" when other pages link to a URL that robots.txt disallows.
- The Issues table now shows each rule's name (with its category underneath), a short explanation, and the exact evidence for every affected URL. CSV export gains a Category column.

### Added — Technical Audit: SEO checks, affected resources, Fix first

- New "Fix first" list ranked by Google's own estimated savings, an "SEO checks" section, affected-resource samples on every finding, a Mobile vs Desktop score table, and labels showing whether Core Web Vitals come from this page's real users, the whole site's, or a lab test.

## 2026-06-08

### Fixed — Performance & Analysis tab (Overview + Insights)

Addressed all 5 issues from the `/impeccable critique` of the Performance & Analysis tab (`projects/[projectId]/page.tsx`, `tab === "performance"`):

- **Phantom `--aa-danger` token (P1):** trend-indicator colors referenced `var(--aa-danger, #ef4444)`, a CSS variable that was never defined — every "down" trend rendered the off-system fallback red instead of the design system's `--aa-error`. Replaced with `var(--aa-success)` / `var(--aa-error)`.
- **Second accent color in `.tableLink` (P1):** the base link style hardcoded a cyan/blue (`#60a5fa`/`#93c5fd`), against the design system's one-accent rule, while a separate override recolored it ember in only one of two tables. Unified the base class on the ember `color-mix` treatment and removed the redundant override.
- **Duplicated active-state styling (P2):** five inline `color-mix(...)` blocks reimplemented the same "active button" treatment at a ratio that diverged from the existing `.navItemActive`/`.articleRichToolBtn[aria-pressed]` patterns. Consolidated into one shared `.miniBtn[aria-pressed="true"]` rule.
- **Dead-end empty/disconnected states (P2):** "No analytics data yet…" and "Connect Search Console…" rendered as inert muted text with no path forward. Both now branch on connection status and surface an "Open Tools" CTA that jumps to the GSC connect flow.
- **Missing mobile breakpoint on Countries/Traffic-sources grid (P3):** the `1fr auto` grid had no responsive override (unlike `.analyticsChartBleed`). Extracted into `.analyticsInsightsGrid` with a `@media (max-width: 640px)` rule that stacks to a single column.

Files: `frontend/src/app/projects/[projectId]/page.tsx`, `frontend/src/app/page.module.css`
