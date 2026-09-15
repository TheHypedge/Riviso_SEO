# Riviso Site Audit --- Design & Implementation Specification

## 1. Document Purpose

This document defines the complete design, UI/UX, functional behavior,
data presentation, component architecture, responsive behavior,
interaction patterns, performance requirements, and implementation
guidelines for the **Riviso Site Audit** module.

The objective is to transform the current Site Audit experience into a
polished, premium, data-dense but easy-to-scan audit workspace inspired
by the supplied reference design.

The Site Audit module must feel like a professional SEO/technical
intelligence product rather than a generic dashboard.

### Primary goals

-   Present technical website health in a highly scannable format.
-   Make the most important problems visible immediately.
-   Separate high-level health from detailed diagnostics.
-   Make PageSpeed Insights data understandable to non-technical users.
-   Preserve technical depth for developers and SEO professionals.
-   Support historical comparison and trend analysis.
-   Make re-running an audit simple and transparent.
-   Maintain a premium dark-mode Riviso visual language.
-   Keep the interface responsive and usable on desktop, tablet, and
    mobile.
-   Avoid visual clutter even when a large amount of audit data is
    available.

------------------------------------------------------------------------

# 2. Source of Truth

Use the following as the visual and functional references:

1.  The existing Riviso Site Audit screenshots supplied in the
    conversation.
2.  The generated optimized Site Audit design image supplied in the
    conversation.
3.  Existing Riviso application design system, navigation, typography,
    spacing, components, and brand language.
4.  Google PageSpeed Insights / Lighthouse response data for technical
    performance metrics.
5.  Existing Riviso project and audit data structures.

The generated design is a **design direction**, not a reason to blindly
duplicate every value shown in the mockup.

Do not hard-code sample metrics into the production UI.

All metrics, scores, timestamps, URLs, opportunities, diagnostics,
trends, and audit history must come from real application data.

------------------------------------------------------------------------

# 3. Product Positioning

Riviso Site Audit should communicate:

> "A professional technical intelligence layer for understanding website
> performance and SEO health."

The experience should not look like a raw PageSpeed report.

Riviso must:

-   ingest technical audit data,
-   normalize it,
-   categorize it,
-   prioritize it,
-   explain it,
-   visualize it,
-   compare it historically,
-   and present actionable recommendations.

The UI should therefore add product-level interpretation on top of the
raw PageSpeed/Lighthouse response.

------------------------------------------------------------------------

# 4. Page Structure

The Site Audit page should follow this hierarchy:

``` text
Site Audit
│
├── Header
│   ├── Page title
│   ├── Description
│   ├── Last audited timestamp
│   ├── Re-run Audit button
│   └── Audit settings / calendar control
│
├── Website Summary
│   ├── Website URL
│   ├── Website favicon / preview
│   ├── Crawl date
│   ├── Pages crawled
│   ├── Test location
│   ├── Device
│   └── Powered by Google PageSpeed Insights
│
├── Audit Health Overview
│   ├── Overall Riviso Health Score
│   ├── Performance score
│   ├── Accessibility score
│   ├── Best Practices score
│   ├── SEO score
│   └── Contextual health message
│
├── Performance Trend
│   ├── Time range selector
│   ├── Mobile series
│   ├── Desktop series
│   ├── Tooltip
│   └── Historical comparison
│
├── Core Web Vitals
│   ├── Mobile/Desktop toggle
│   ├── LCP
│   ├── INP
│   ├── CLS
│   ├── FCP
│   ├── Speed Index
│   ├── TBT
│   └── TTFB
│
├── Action Center
│   ├── Top Opportunities
│   └── Diagnostics
│
├── Detailed Audit Sections
│   ├── Accessibility
│   ├── Best Practices
│   ├── SEO
│   ├── Performance
│   ├── Network
│   ├── Images
│   ├── JavaScript
│   ├── CSS
│   └── Technical diagnostics
│
├── Audit History
│   ├── Previous audits
│   ├── Mobile score
│   ├── Desktop score
│   └── Audit details
│
└── Contextual guidance / CTA
```

------------------------------------------------------------------------

# 5. Global Visual Design

## 5.1 Design language

The page must use a:

-   premium dark interface,
-   low-noise visual hierarchy,
-   restrained borders,
-   subtle gradients,
-   orange Riviso brand accents,
-   green positive states,
-   amber warning states,
-   red critical states,
-   blue informational states.

Avoid excessive gradients, excessive glow, excessive shadows, or
excessive card nesting.

The design should feel closer to a premium developer/analytics product
than a marketing dashboard.

------------------------------------------------------------------------

# 6. Color System

Use existing Riviso brand tokens where available.

Recommended semantic tokens:

``` text
Background:
--audit-bg: #080A0F
--audit-surface: #0D1118
--audit-surface-raised: #121720
--audit-surface-hover: #171D27

Borders:
--audit-border: rgba(255,255,255,0.08)
--audit-border-strong: rgba(255,255,255,0.14)

Primary:
--riviso-orange: existing Riviso brand orange

Success:
--audit-success: green semantic token

Warning:
--audit-warning: amber semantic token

Critical:
--audit-critical: red semantic token

Info:
--audit-info: blue semantic token

Text:
--audit-text-primary: high contrast
--audit-text-secondary: muted
--audit-text-tertiary: subdued
```

Do not hard-code colors throughout components.

Use centralized design tokens.

------------------------------------------------------------------------

# 7. Typography

Use the existing Riviso typography system.

Hierarchy:

``` text
Page Title
32–40px / bold

Section Title
18–22px / semibold

Card Title
14–16px / semibold

Metric Value
24–40px depending on component

Body
13–15px

Metadata
11–12px

Badge
11–12px
```

The interface must maintain strong contrast between:

-   headings,
-   metric values,
-   labels,
-   explanatory copy,
-   metadata.

Avoid overly large text that reduces information density.

------------------------------------------------------------------------

# 8. Layout System

Use a consistent spacing scale.

Recommended:

``` text
4px
8px
12px
16px
20px
24px
32px
40px
48px
```

Cards should generally use:

``` text
padding: 20–24px
border-radius: 12–16px
```

Do not create unnecessary cards inside cards.

Where possible, use grouped sections instead of nested panels.

------------------------------------------------------------------------

# 9. Site Audit Header

## Layout

Left:

``` text
Site Audit
Comprehensive analysis of your website's performance and SEO health
```

Right:

``` text
Last audited: Aug 11, 2026 • 01:46 PM
[Re-run Audit]
[Audit settings]
```

## Re-run Audit button

Primary orange button.

States:

### Default

``` text
Re-run Audit
```

### Loading

``` text
Running Audit...
```

Include a subtle spinner.

### Success

``` text
Audit Complete
```

Then return to normal state.

### Error

``` text
Retry Audit
```

Display an inline error explanation.

Do not allow multiple simultaneous audit requests.

------------------------------------------------------------------------

# 10. Website Summary Card

This section should establish audit context before presenting metrics.

Include:

### Website preview

Display:

-   screenshot thumbnail if available,
-   favicon,
-   fallback placeholder if screenshot unavailable.

### Website URL

Example:

``` text
https://sheokandlegal.com
```

Add external-link icon.

### Metadata

``` text
Crawl Date
Pages Crawled
Test Location
Device
```

Use compact metadata columns.

Example:

``` text
Crawl Date       Aug 11, 2026 • 01:46 PM
Pages Crawled    128
Test Location    Mumbai, India
Device           Mobile
```

### Provider indicator

``` text
Powered by Google PageSpeed Insights
```

This should be visually secondary.

Do not make third-party branding visually stronger than Riviso branding.

------------------------------------------------------------------------

# 11. Audit Health Overview

This is the most important visual section.

Use a two-part layout:

``` text
┌─────────────────────┬────────────────────────────────────────────┐
│                     │ Performance       Accessibility            │
│   Overall Score     │ Best Practices   SEO                        │
│       78/100        │                                              │
│                     │ Contextual message                           │
└─────────────────────┴────────────────────────────────────────────┘
```

------------------------------------------------------------------------

# 12. Overall Health Score

The score should be a large circular/radial visualization.

Example:

``` text
78
/100
Overall Site Health
```

Under it:

``` text
Needs Improvement
▲ 6 vs previous audit
```

The overall score must be calculated by application logic, not visually
inferred.

## Score bands

Recommended:

``` text
90–100 = Excellent
75–89  = Good
50–74  = Needs Improvement
0–49   = Critical
```

These thresholds must be centralized and configurable.

------------------------------------------------------------------------

# 13. Category Score Cards

Create four cards:

``` text
Performance
Accessibility
Best Practices
SEO
```

Each card contains:

-   icon,
-   score,
-   /100,
-   status,
-   semantic color,
-   optional trend.

Example:

``` text
Performance
58 /100
Needs Improvement
```

``` text
SEO
92 /100
Good
```

Avoid large descriptions inside these cards.

The card should be glanceable in under two seconds.

------------------------------------------------------------------------

# 14. Contextual Health Message

After category cards, display a short intelligent message.

Examples:

``` text
Great job! Your site is performing well.
Focus on Performance improvements to enhance user experience and Core Web Vitals.
```

For poor results:

``` text
Performance requires attention.
The primary opportunities are related to JavaScript execution, render-blocking resources, and image delivery.
```

The message should be dynamically generated from the audit results.

Do not always display the same text.

------------------------------------------------------------------------

# 15. Performance Trend

This section must communicate whether the website is improving or
degrading.

## Controls

Use:

``` text
7D
30D
3M
6M
1Y
All
```

Default:

``` text
30D
```

If there is insufficient historical data, gracefully disable unavailable
ranges.

## Chart

Plot:

``` text
Mobile
Desktop
```

Use separate visual series.

Do not overload the chart with all PageSpeed metrics.

This chart is specifically for score trend.

## Tooltip

Tooltip should contain:

``` text
Aug 03, 2026

Mobile     56
Desktop    68
```

## Empty state

If only one audit exists:

``` text
Your performance trend will appear here after additional audits.

Run periodic audits to track improvements over time.
```

Do not render a fake trend line.

------------------------------------------------------------------------

# 16. Core Web Vitals

This section should be highly actionable.

Include:

``` text
LCP
INP
CLS
FCP
```

and supporting metrics:

``` text
Speed Index
Total Blocking Time
Time to First Byte
```

## Device toggle

``` text
Mobile | Desktop
```

Default to the device used by the latest audit, preferably Mobile.

------------------------------------------------------------------------

# 17. Core Web Vital Cards

Each primary metric card should contain:

``` text
Metric name
Current value
Status
Threshold indicator
```

Example:

``` text
Largest Contentful Paint

1.9 s
● Good

[──────●────────]
Good   Needs Improvement   Poor
```

Do not rely solely on color.

Always display textual status.

------------------------------------------------------------------------

# 18. Metric Thresholds

Use Google/Lighthouse-defined thresholds rather than arbitrary
thresholds.

Store threshold definitions centrally.

Example conceptual structure:

``` ts
{
  metric: "LCP",
  good: ...,
  needsImprovement: ...,
  poor: ...
}
```

Do not duplicate thresholds in UI components.

------------------------------------------------------------------------

# 19. Supporting Metrics

Use a compact horizontal metric row:

``` text
First Contentful Paint
1.2 s

Speed Index
2.4 s

Total Blocking Time
120 ms

Time to First Byte
280 ms
```

This prevents secondary metrics from competing with Core Web Vitals.

------------------------------------------------------------------------

# 20. Top Opportunities

This section should answer:

> "What should I fix first?"

Show the highest-impact opportunities.

Each row:

``` text
[Icon] Opportunity title
       Short explanation
                         Estimated savings
```

Examples:

``` text
Eliminate render-blocking resources
Estimated savings: 1.2 s

Reduce unused JavaScript
Estimated savings: 934 KiB

Reduce unused CSS
Estimated savings: 63 KiB

Properly size images
Estimated savings: 47 KiB

Defer offscreen images
Estimated savings: 38 KiB
```

## Ranking logic

Prioritize by:

1.  Severity
2.  Estimated performance impact
3.  Estimated byte/time savings
4.  Number of affected resources
5.  User-visible impact

Do not simply display Lighthouse's raw ordering if Riviso can provide
better prioritization.

------------------------------------------------------------------------

# 21. Diagnostics

Diagnostics should answer:

> "What technical problems exist?"

Each diagnostic row should contain:

-   severity indicator,
-   title,
-   optional metric/value,
-   expandable details.

Examples:

``` text
Avoid enormous network payloads       3.8 MB
Minimize main-thread work             2.4 s
Reduce JavaScript execution time      1.5 s
Ensure text remains visible during
webfont load                          ✓
Avoid multiple page redirects         ✓
```

Use:

``` text
Critical = red
Warning = amber
Passed = green
Informational = blue
```

------------------------------------------------------------------------

# 22. Expandable Diagnostic Details

Clicking a diagnostic must reveal:

``` text
Problem
Why it matters
Affected resources
Current measurement
Recommended fix
Potential impact
Technical details
```

Example:

``` text
Reduce unused JavaScript

Why this matters
Unused JavaScript increases transfer size and main-thread work.

Affected resources
8 resources

Estimated savings
934 KiB

Recommended action
Split bundles, defer non-critical scripts, and remove unused dependencies.
```

Do not dump raw Lighthouse JSON into the UI.

Raw JSON can be available through a developer/debug view.

------------------------------------------------------------------------

# 23. Detailed Audit Categories

The detailed section should support:

``` text
Performance
Accessibility
Best Practices
SEO
```

Each category can expose its underlying audit checks.

Each check should have:

``` text
Status
Title
Description
Score
Affected resources
Recommendation
```

------------------------------------------------------------------------

# 24. Accessibility Presentation

The current implementation exposes diagnostics such as:

-   ARIA attributes do not match roles
-   insufficient color contrast
-   heading order problems
-   links without discernible names
-   incorrect list structure
-   list items without valid parent elements

These should be grouped into a structured Accessibility panel.

Avoid showing a long unstructured list.

Recommended layout:

``` text
Accessibility
81 / 100

Passed       36
Warnings      5
Failed        2

[Critical issues]
[Warnings]
[Passed checks]
```

------------------------------------------------------------------------

# 25. SEO Presentation

The Site Audit's PageSpeed SEO score is **not Riviso's complete SEO
Audit**.

Keep this distinction explicit.

Use:

``` text
PageSpeed SEO
```

when referring to the Lighthouse category.

Use:

``` text
Riviso SEO Audit
```

for the dedicated SEO audit module.

Never imply that the PageSpeed SEO score represents a complete
technical/content SEO audit.

------------------------------------------------------------------------

# 26. Technical Audit vs SEO Audit

The top-level switch should remain:

``` text
Technical Audit | SEO Audit
```

### Technical Audit

Focus:

-   Core Web Vitals
-   Lighthouse scores
-   network performance
-   JavaScript
-   CSS
-   images
-   browser diagnostics
-   accessibility
-   best practices
-   PageSpeed SEO category

### SEO Audit

Focus separately on:

-   crawlability
-   indexability
-   canonicalization
-   robots.txt
-   sitemap
-   titles
-   meta descriptions
-   headings
-   content
-   internal links
-   external links
-   structured data
-   broken links
-   redirects
-   status codes
-   image alt attributes
-   duplicate content
-   pagination
-   hreflang
-   Open Graph
-   Twitter/X metadata
-   technical SEO issues

Do not mix the two data models.

------------------------------------------------------------------------

# 27. Audit History

Display historical audits in a compact table/list.

Each row:

``` text
Date
Time
Mobile Score
Desktop Score
Status
View Details
```

Example:

``` text
Aug 11, 2026 • 01:46 PM     Mobile 58     Desktop 70
Aug 11, 2026 • 01:35 PM     Mobile 38     Desktop 37
```

Clicking a history row should open the audit snapshot.

Historical results must be immutable snapshots.

A new audit must create a new record rather than overwrite the previous
result.

------------------------------------------------------------------------

# 28. Audit Comparison

When at least two audits exist, support:

``` text
Current Audit vs Previous Audit
```

Show:

``` text
Performance     +20
Accessibility    +3
Best Practices   +2
SEO              +4
```

For metrics:

``` text
LCP
Previous: 4.8s
Current: 1.9s
Improvement: 2.9s
```

Use semantic language:

``` text
Improved
Regressed
Unchanged
```

Do not use a percentage improvement if the underlying metric does not
support a meaningful percentage interpretation.

------------------------------------------------------------------------

# 29. Audit Execution Flow

When the user clicks **Re-run Audit**:

``` text
1. Validate URL
2. Create audit job
3. Lock duplicate execution
4. Request PageSpeed data
5. Request mobile audit
6. Request desktop audit
7. Normalize response
8. Calculate Riviso health score
9. Extract Core Web Vitals
10. Extract opportunities
11. Extract diagnostics
12. Persist immutable audit snapshot
13. Compare against previous audit
14. Update UI
15. Show completion state
```

------------------------------------------------------------------------

# 30. Loading State

Never display an empty dashboard while the audit is running.

Show a structured progress state:

``` text
Running Site Audit

✓ Validating website
✓ Connecting to PageSpeed Insights
● Running mobile analysis
○ Running desktop analysis
○ Processing diagnostics
○ Generating recommendations
```

Use skeleton components for the expected result layout.

Do not use a generic full-screen spinner.

------------------------------------------------------------------------

# 31. Error Handling

Possible errors:

### Invalid URL

``` text
We couldn't analyze this URL.
Please enter a valid public website URL.
```

### API quota exceeded

``` text
PageSpeed analysis is temporarily unavailable because the API quota has been reached.
Try again later.
```

### Website unreachable

``` text
The website could not be reached from the PageSpeed test environment.
Check DNS, server availability, firewall rules, and HTTPS configuration.
```

### Timeout

``` text
The audit timed out while analyzing the website.
Retry the audit.
```

### API authentication

``` text
PageSpeed API authentication failed.
Check the configured API key and API restrictions.
```

Never expose API keys, server credentials, or internal stack traces.

------------------------------------------------------------------------

# 32. PageSpeed API Security

The PageSpeed API key must never be exposed to the browser.

Correct:

``` text
Browser
   ↓
Riviso Backend
   ↓
PageSpeed API
```

Incorrect:

``` text
Browser
   ↓
PageSpeed API using public API key
```

Store the key in an environment variable:

``` env
PAGESPEED_INSIGHTS_API_KEY=...
```

Never commit the key to Git.

Never place it in:

-   client-side JavaScript,
-   NEXT_PUBLIC\_\* variables,
-   HTML,
-   localStorage,
-   URL parameters generated in the browser,
-   public configuration files.

------------------------------------------------------------------------

# 33. Recommended API Service Layer

Create a dedicated server-side service.

Conceptual structure:

``` text
services/
└── pagespeed/
    ├── client
    ├── types
    ├── parser
    ├── normalizer
    ├── thresholds
    └── scoring
```

The UI must not directly understand the raw Google PageSpeed response.

Use:

``` text
PageSpeed API
      ↓
API Client
      ↓
Parser
      ↓
Normalized Audit Model
      ↓
Scoring / Prioritization
      ↓
Database
      ↓
UI
```

------------------------------------------------------------------------

# 34. Normalized Audit Model

Create a stable internal model.

Conceptual example:

``` ts
type SiteAudit = {
  id: string
  projectId: string
  url: string
  auditedAt: string

  device: "mobile" | "desktop"

  scores: {
    overall: number
    performance: number
    accessibility: number
    bestPractices: number
    seo: number
  }

  coreWebVitals: {
    lcp: Metric
    inp: Metric
    cls: Metric
    fcp: Metric
    speedIndex: Metric
    tbt: Metric
    ttfb: Metric
  }

  opportunities: AuditOpportunity[]
  diagnostics: AuditDiagnostic[]

  rawReportReference?: string
}
```

Do not couple the database/UI directly to Google's response structure.

------------------------------------------------------------------------

# 35. Data Freshness

Every audit must display:

``` text
Last audited: [timestamp]
```

Store timestamps in UTC.

Convert them to the user's local timezone for presentation.

Never hard-code dates.

------------------------------------------------------------------------

# 36. Responsive Design

## Desktop

Use:

``` text
Sidebar
+
Main content
```

The primary content should have a maximum readable width.

The dashboard should not become excessively stretched on ultrawide
monitors.

------------------------------------------------------------------------

## Tablet

Reduce:

-   sidebar width,
-   card padding,
-   chart height,
-   metric card width.

Allow score cards to wrap.

------------------------------------------------------------------------

## Mobile

The sidebar becomes:

``` text
mobile navigation / drawer
```

Score cards become vertically or horizontally scrollable.

Trend chart remains horizontally readable.

Core Web Vital cards become a two-column or single-column layout
depending on viewport width.

Do not compress 4 metric cards into unreadable miniature cards.

------------------------------------------------------------------------

# 37. Mobile Header

On mobile:

``` text
☰ Riviso                     ⋮
Site Audit
Last audited...
[Re-run Audit]
```

The primary action must remain easy to access.

------------------------------------------------------------------------

# 38. Accessibility Requirements

The Site Audit UI itself must pass accessibility checks.

Requirements:

-   semantic HTML,
-   valid heading hierarchy,
-   keyboard navigation,
-   visible focus states,
-   accessible buttons,
-   accessible chart labels,
-   accessible tooltips,
-   sufficient contrast,
-   no color-only status indicators,
-   ARIA attributes matching actual roles,
-   descriptive link names,
-   correct list semantics.

Do not reproduce the accessibility problems detected by the audited
customer site inside Riviso's own dashboard.

------------------------------------------------------------------------

# 39. Charts

Charts must be:

-   responsive,
-   accessible,
-   readable in dark mode,
-   interactive where useful,
-   keyboard-compatible where possible.

Do not use excessive animation.

Animations should be short and purposeful.

Recommended:

``` text
150–250ms
```

Avoid chart animations that repeatedly distract users.

------------------------------------------------------------------------

# 40. Animation Guidelines

Use subtle transitions for:

-   card hover,
-   tabs,
-   score changes,
-   accordion expansion,
-   button loading,
-   tooltip appearance.

Avoid:

-   bouncing cards,
-   excessive gradients,
-   continuous pulsing,
-   decorative motion,
-   large entrance animations.

The Site Audit is an analytics tool; data comprehension has priority
over visual spectacle.

------------------------------------------------------------------------

# 41. Empty States

Every major section needs an intentional empty state.

Examples:

### No audit yet

``` text
No audit available

Run your first technical audit to see performance, Core Web Vitals, diagnostics, and opportunities.

[Run Technical Audit]
```

### No history

``` text
No historical audits yet.
Run additional audits to track performance over time.
```

### No opportunities

``` text
No major performance opportunities detected.
Your current audit is performing well.
```

### No diagnostics

``` text
No additional diagnostics require attention.
```

------------------------------------------------------------------------

# 42. Partial Data

The UI must gracefully handle missing metrics.

For example:

``` text
INP
Unavailable
```

Do not display:

``` text
0 ms
```

when the API has no value.

Never convert missing data into zero.

------------------------------------------------------------------------

# 43. Score Visualization Rules

Score visualization must be consistent throughout the product.

Use:

``` text
Excellent
Good
Needs Improvement
Critical
```

Never use inconsistent labels such as:

``` text
Poor
Bad
Weak
Average
```

unless the product taxonomy explicitly defines them.

------------------------------------------------------------------------

# 44. Performance Priority Logic

Riviso should eventually calculate an internal priority score:

``` text
Priority =
severity
+
estimated user impact
+
estimated savings
+
affected resources
```

This allows Riviso to distinguish between:

``` text
High impact
Medium impact
Low impact
```

rather than merely copying Google's list.

------------------------------------------------------------------------

# 45. Actionability

Every problem should ideally answer:

``` text
What is wrong?
Why does it matter?
How severe is it?
What should I do?
How much could it improve?
```

This is a major differentiator for Riviso.

------------------------------------------------------------------------

# 46. "View All" Behavior

Sections such as:

``` text
Top Opportunities
Diagnostics
```

should show the top 4--6 items initially.

Clicking:

``` text
View all
```

opens a detailed list or drawer.

Do not force the user to scroll through dozens of diagnostics on the
main dashboard.

------------------------------------------------------------------------

# 47. Detail Drawer / Modal

For detailed items, prefer a right-side drawer on desktop.

Structure:

``` text
Opportunity title
Status
Impact

Why this matters

Current state

Affected resources

Recommended fix

Technical details

[Close]
```

On mobile, use a full-screen sheet.

------------------------------------------------------------------------

# 48. Raw Technical Data

Developers may need raw information.

Provide an optional:

``` text
Technical details
```

or:

``` text
View raw data
```

Do not expose raw JSON by default.

Raw response data should be formatted and syntax-highlighted if exposed.

------------------------------------------------------------------------

# 49. Data Integrity

Do not fabricate:

-   scores,
-   audit dates,
-   savings,
-   number of pages,
-   CWV values,
-   locations,
-   resource counts,
-   historical data.

The generated design's values are visual examples only.

------------------------------------------------------------------------

# 50. Performance of Riviso Site Audit UI

The Site Audit dashboard itself must be performant.

Requirements:

-   lazy-load heavy charts,
-   virtualize very long audit lists,
-   avoid unnecessary re-renders,
-   memoize expensive transformations,
-   fetch detailed diagnostics only when required where practical,
-   avoid loading the entire raw PageSpeed response into the client,
-   optimize preview screenshots,
-   use responsive image sizes.

The dashboard should not become an example of poor performance while
reporting performance problems.

------------------------------------------------------------------------

# 51. Component Architecture

Recommended components:

``` text
SiteAuditPage
├── SiteAuditHeader
├── AuditSummaryCard
├── OverallHealthCard
├── ScoreGrid
│   ├── PerformanceScore
│   ├── AccessibilityScore
│   ├── BestPracticesScore
│   └── SeoScore
├── AuditInsightBanner
├── PerformanceTrend
├── CoreWebVitals
│   ├── DeviceToggle
│   ├── MetricCard
│   └── SupportingMetrics
├── ActionCenter
│   ├── OpportunitiesPanel
│   └── DiagnosticsPanel
├── AuditHistory
├── AuditDetailDrawer
└── AuditRunProgress
```

Build components from reusable primitives.

Do not implement the entire page as one large component.

------------------------------------------------------------------------

# 52. Reusable Components

Create reusable primitives for:

``` text
AuditCard
ScoreBadge
StatusBadge
MetricCard
MetricThresholdBar
TrendIndicator
AuditRow
ExpandableAuditRow
SectionHeader
DeviceToggle
DateRangeToggle
EmptyState
ErrorState
LoadingState
```

------------------------------------------------------------------------

# 53. State Management

The page should have explicit states:

``` text
idle
loading
processing
success
partial
error
```

Do not rely on implicit booleans such as:

``` ts
isLoading
hasData
hasError
```

alone when the workflow becomes more complex.

------------------------------------------------------------------------

# 54. Audit Job Status

Recommended backend states:

``` text
queued
validating
running_mobile
running_desktop
processing
completed
partial
failed
```

Persist job status where necessary.

This allows users to refresh the page without losing audit state.

------------------------------------------------------------------------

# 55. Duplicate Audit Protection

Prevent accidental repeated clicks from launching multiple audits.

Use:

``` text
disabled button
+
server-side idempotency protection
```

A user clicking Re-run multiple times should not create multiple
identical jobs.

------------------------------------------------------------------------

# 56. API Quotas

The backend should handle:

-   rate limits,
-   API errors,
-   timeout,
-   retries,
-   quota exhaustion.

Use exponential backoff where appropriate.

Do not retry indefinitely.

------------------------------------------------------------------------

# 57. Caching

Do not unnecessarily run PageSpeed on every page load.

Use persisted audit results.

The page should load the latest stored audit immediately.

A new PageSpeed request should only happen when:

``` text
User clicks Re-run Audit
```

or when an explicitly configured automated audit runs.

------------------------------------------------------------------------

# 58. Historical Storage

Recommended records:

``` text
projects
site_audits
site_audit_metrics
site_audit_opportunities
site_audit_diagnostics
```

Depending on the existing database architecture, these can also be
normalized into fewer tables.

The important requirement is that historical audit snapshots remain
queryable.

------------------------------------------------------------------------

# 59. SEO Audit Separation

The Site Audit navigation currently contains:

``` text
Technical Audit | SEO Audit
```

Preserve this distinction.

The technical audit should not attempt to replace a crawler-based SEO
audit.

The SEO Audit should eventually have its own architecture based on
crawling and page-level analysis.

------------------------------------------------------------------------

# 60. Design Details From the Reference

Maintain the following visual characteristics from the optimized design:

-   Riviso orange brand mark.
-   Dark navy/black background.
-   Rounded panels.
-   Subtle panel borders.
-   Strong white primary text.
-   Muted gray metadata.
-   Orange primary CTA.
-   Green positive metric states.
-   Amber warning states.
-   Red critical states.
-   Compact score cards.
-   Large circular overall score.
-   Clean trend chart.
-   Compact Core Web Vital cards.
-   Two-column action center.
-   Purple informational bottom banner.
-   Clear sidebar navigation.
-   Strong spacing between major sections.

Do not copy the mockup pixel-for-pixel if it conflicts with the existing
Riviso design system.

------------------------------------------------------------------------

# 61. Bottom Insight Banner

Use an optional contextual banner at the bottom of the primary audit
view.

Example:

``` text
Did you know?

Sites that load in under 2.5 seconds can provide a significantly better user experience.

[View Performance Guide →]
```

The copy must be evidence-based.

Do not use unsupported conversion claims.

The banner can change according to audit context.

------------------------------------------------------------------------

# 62. SEO / Technical Terminology

Use correct terminology.

Examples:

``` text
Largest Contentful Paint (LCP)
Interaction to Next Paint (INP)
Cumulative Layout Shift (CLS)
First Contentful Paint (FCP)
Total Blocking Time (TBT)
Time to First Byte (TTFB)
Render-blocking resources
Main-thread work
Network payload
JavaScript execution
Cache lifetime
```

Do not simplify terminology to the point of becoming technically
inaccurate.

------------------------------------------------------------------------

# 63. Tooltip Guidelines

Use tooltips for technical metrics where users may need context.

Example:

``` text
LCP
ⓘ
```

Tooltip:

``` text
Largest Contentful Paint measures how quickly the largest visible content element becomes rendered.
```

Keep tooltip content concise.

------------------------------------------------------------------------

# 64. SEO Professional / Developer Modes

Future enhancement:

``` text
Simple View
Technical View
```

### Simple View

Prioritize:

-   score,
-   status,
-   business impact,
-   recommended action.

### Technical View

Expose:

-   audit IDs,
-   resource URLs,
-   timings,
-   transfer sizes,
-   stack details,
-   technical remediation.

This allows Riviso to serve both marketers and developers without
compromising either experience.

------------------------------------------------------------------------

# 65. Copywriting Rules

Use concise product language.

Prefer:

``` text
Reduce unused JavaScript
```

instead of:

``` text
You should probably consider reducing the amount of JavaScript that is currently not being utilized.
```

Prefer:

``` text
Estimated savings: 934 KiB
```

instead of:

``` text
You could potentially save approximately 934 KiB of data.
```

Use direct, analytical copy.

------------------------------------------------------------------------

# 66. Do Not Use

Avoid:

-   fake scores,
-   fake audit history,
-   fake trend data,
-   arbitrary performance thresholds,
-   unnecessary animations,
-   excessive modals,
-   raw JSON everywhere,
-   giant diagnostic lists on the main screen,
-   color-only statuses,
-   hard-coded dates,
-   hard-coded URL,
-   hard-coded API results,
-   client-side PageSpeed API keys,
-   misleading claims that PageSpeed SEO equals a complete SEO audit.

------------------------------------------------------------------------

# 67. Acceptance Criteria

The implementation is considered complete only when:

### UI

-   [ ] Site Audit visually matches the approved Riviso design
    direction.
-   [ ] Existing Riviso sidebar remains consistent.
-   [ ] Header is clean and responsive.
-   [ ] Website summary is easy to scan.
-   [ ] Overall score is prominent.
-   [ ] Four category scores are visible.
-   [ ] Performance trend is interactive.
-   [ ] Core Web Vitals are clearly presented.
-   [ ] Opportunities are prioritized.
-   [ ] Diagnostics are expandable.
-   [ ] Audit history is available.
-   [ ] Mobile/Desktop switching works.
-   [ ] Empty/loading/error states exist.
-   [ ] Mobile layout is usable.

### Data

-   [ ] All metrics come from stored audit data.
-   [ ] No production mock values remain.
-   [ ] Historical results are immutable.
-   [ ] Missing values are handled correctly.
-   [ ] Current and previous audits can be compared.

### API

-   [ ] PageSpeed API is called server-side.
-   [ ] API key is stored securely.
-   [ ] API key is not exposed to frontend code.
-   [ ] API errors are handled.
-   [ ] API quota errors are handled.
-   [ ] Duplicate audit execution is prevented.

### Accessibility

-   [ ] Valid heading hierarchy.
-   [ ] Keyboard accessible controls.
-   [ ] Visible focus states.
-   [ ] Accessible chart labels.
-   [ ] Sufficient contrast.
-   [ ] No color-only status indicators.
-   [ ] Valid ARIA usage.
-   [ ] Valid list semantics.
-   [ ] Accessible buttons and links.

### Performance

-   [ ] Charts are optimized.
-   [ ] Large data sets do not block rendering.
-   [ ] Audit detail data is appropriately lazy-loaded.
-   [ ] Preview images are optimized.
-   [ ] No unnecessary client-side API calls.
-   [ ] No unnecessary re-renders.

------------------------------------------------------------------------

# 68. QA Checklist

Before deployment, test:

## Functional

-   [ ] Run audit.
-   [ ] Re-run audit.
-   [ ] Cancel/handle duplicate requests if supported.
-   [ ] Refresh during audit.
-   [ ] Refresh after completion.
-   [ ] View previous audit.
-   [ ] Compare audits.
-   [ ] Switch Mobile/Desktop.
-   [ ] Switch trend range.
-   [ ] Expand opportunity.
-   [ ] Expand diagnostic.
-   [ ] Open detailed audit.
-   [ ] Handle failed audit.

## Visual

-   [ ] 1440px desktop.
-   [ ] 1280px desktop.
-   [ ] 1024px tablet.
-   [ ] 768px tablet.
-   [ ] 390px mobile.
-   [ ] 430px mobile.
-   [ ] Ultrawide screen.

## Accessibility

-   [ ] Keyboard navigation.
-   [ ] Screen-reader labels.
-   [ ] Focus states.
-   [ ] Contrast.
-   [ ] Heading hierarchy.
-   [ ] ARIA validation.

## Data

-   [ ] Correct latest timestamp.
-   [ ] Correct current scores.
-   [ ] Correct historical scores.
-   [ ] Correct CWV values.
-   [ ] Correct opportunity savings.
-   [ ] Correct diagnostic severity.

------------------------------------------------------------------------

# 69. Recommended Implementation Order

Do not attempt all features simultaneously.

Implement in this sequence:

### Phase 1 --- Foundation

1.  Audit page layout.
2.  Header.
3.  Website summary.
4.  Overall score.
5.  Category score cards.

### Phase 2 --- Performance Intelligence

6.  Performance trend.
7.  Core Web Vitals.
8.  Supporting metrics.
9.  Opportunities.
10. Diagnostics.

### Phase 3 --- Historical Intelligence

11. Audit history.
12. Previous/current comparison.
13. Trend filters.

### Phase 4 --- Advanced UX

14. Detail drawer.
15. Loading workflow.
16. Empty states.
17. Error states.
18. Responsive optimization.

### Phase 5 --- Engineering Hardening

19. API security.
20. Caching.
21. Retry logic.
22. Rate-limit handling.
23. Accessibility QA.
24. Performance QA.
25. Production validation.

------------------------------------------------------------------------

# 70. Final Product Principle

The Site Audit page should not simply answer:

> "What is my PageSpeed score?"

It should answer:

> "How healthy is my website, what is hurting it, how important is each
> issue, what should I fix first, and is the site improving?"

Every UI decision should support this objective.

The final experience should make the user understand the state of the
website within seconds while still allowing a developer or SEO
professional to drill down into technical evidence.

**Riviso should interpret the audit --- not merely display it.**
