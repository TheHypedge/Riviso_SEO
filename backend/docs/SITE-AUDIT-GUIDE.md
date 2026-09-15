# RIVISO — SITE AUDIT MODULE
## Complete Product, Functional, UX, Data, Audit Logic & Implementation Specification

> **Purpose:** This document is the complete implementation context for the Riviso Site Audit feature and should be treated as the functional source of truth while implementing the feature.
>
> **Important:** The existing Riviso codebase, infrastructure, architecture, project context, authentication, APIs, database structure, design system, and existing integrations already provide the implementation context. **Inspect the existing implementation first and reuse what already exists. Do not redesign the underlying architecture or introduce a parallel architecture unnecessarily.**
>
> **Do not treat this as a request to create only UI. The complete feature must be functional end-to-end using real data.**

---

# 1. FEATURE OVERVIEW

Introduce a new **Site Audit** module inside Riviso.

The purpose of Site Audit is to provide users with a comprehensive understanding of the health of their website.

Site Audit consists of two independent audit systems:

```text
SITE AUDIT
│
├── Technical Audit
│
└── SEO Audit
```

These two audits must not be treated as the same audit.

They have different objectives, different data sources, different analysis methodologies, and different outputs.

---

# 2. TWO AUDIT SYSTEMS

## 2.1 Technical Audit

The Technical Audit must primarily use:

**Google PageSpeed Insights**

Its purpose is to determine the technical performance and performance-related health of the website.

It should retrieve real PageSpeed Insights / Lighthouse data and present it inside Riviso.

The Technical Audit should answer:

> How technically performant and healthy is this website according to Google PageSpeed Insights?

It should cover, where returned by PageSpeed Insights:

- Performance
- Core Web Vitals
- Accessibility
- Best Practices
- Lighthouse SEO category
- Performance opportunities
- Diagnostics
- Mobile performance
- Desktop performance
- Supporting Lighthouse metrics

---

## 2.2 SEO Audit

The SEO Audit must use a **Riviso-controlled website crawler**.

Its methodology should be comparable in depth and philosophy to professional crawlers such as **Screaming Frog SEO Spider**.

This does **not** mean copying Screaming Frog or using its service.

Riviso must perform its own crawl and SEO analysis.

The SEO Audit should answer:

> What SEO and technical SEO problems exist across the actual website, which URLs are affected, and what should be fixed?

The SEO crawler should inspect:

- URLs
- HTTP status codes
- Redirects
- Titles
- Meta descriptions
- Headings
- Canonicals
- Indexability
- Robots directives
- XML sitemap
- Robots.txt
- Internal links
- External links
- Images
- Content signals
- Duplicate signals
- Structured data
- Social metadata
- Crawl depth
- URL structure
- Response information

---

# 3. IMPORTANT SEPARATION

Do not merge these systems into one generic audit engine.

The conceptual separation must remain:

```text
TECHNICAL AUDIT
        │
        └── Google PageSpeed Insights
                │
                ├── Performance
                ├── Core Web Vitals
                ├── Accessibility
                ├── Best Practices
                ├── Lighthouse SEO
                ├── Opportunities
                └── Diagnostics


SEO AUDIT
        │
        └── Riviso SEO Crawler
                │
                ├── Crawl
                ├── URL discovery
                ├── HTTP analysis
                ├── On-page SEO
                ├── Indexability
                ├── Links
                ├── Canonicals
                ├── Sitemap
                ├── Robots
                ├── Content
                ├── Images
                ├── Schema
                └── Cross-page analysis
```

The PageSpeed SEO score must **not** be presented as Riviso's complete SEO Audit score.

---

# 4. NAVIGATION

Add a new project-level navigation item:

```text
Site Audit
```

The project navigation should expose:

```text
Overview
Articles
Research
Scheduled Articles
Prompts
Context Links
Tools
Members
Project Settings
Site Audit
```

Follow the existing Riviso navigation conventions and visual language.

Do not create a completely different navigation system for Site Audit.

---

# 5. CURRENT PROJECT CONTEXT

Site Audit must always operate on the currently selected project.

If the user is currently working inside:

```text
Project A
```

the audit must use:

```text
Project A's website
```

If the user switches to:

```text
Project B
```

the Site Audit context must switch to:

```text
Project B's website
```

Do not accidentally retain the previous project's website.

The project context must be consistent with the rest of Riviso.

---

# 6. WEBSITE REQUIREMENT

Every audit requires a valid website.

If the current project has a valid website:

```text
Website

https://example.com/

[ Run Audit ]
```

If no website is configured:

```text
Website not connected

Connect a website to run Site Audit.

[ Go to Project Settings ]
```

Do not allow an audit request to execute against an undefined website.

---

# 7. SITE AUDIT PAGE

The Site Audit page should have a clear hierarchy.

Recommended structure:

```text
Site Audit

Analyze your website's technical performance
and SEO health.

Website
https://example.com/

Last audited:
11 Aug 2026 • 11:32 AM

[ Run Audit ]

------------------------------------------------

Technical Audit        SEO Audit

------------------------------------------------
```

The exact UI should follow the existing Riviso design system.

---

# 8. FIRST-TIME EXPERIENCE

If the user has never run an audit, show a meaningful empty state.

Example:

```text
Site Audit

No audit has been performed yet.

Run an audit to analyze your website's
technical performance and SEO health.

[ Technical Audit ]
[ SEO Audit ]
```

Do not show empty cards filled with meaningless `0` values.

---

# 9. AUDIT STATES

The feature must handle:

```text
Initial
Ready
Running
Completed
Refreshing
Failed
Cancelled
No Website
No Data
Partial Data
```

Every state must have an appropriate UI.

---

# 10. AUDIT EXECUTION

The user should be able to run either audit independently.

For example:

```text
Technical Audit
[ Run Technical Audit ]
```

or:

```text
SEO Audit
[ Run SEO Audit ]
```

Running Technical Audit must not automatically trigger SEO Audit unless a future explicit "Run Full Site Audit" feature is introduced.

Running SEO Audit must not automatically trigger PageSpeed unless explicitly requested.

---

# 11. RUNNING STATE

The application must clearly communicate that the audit is running.

Never leave the user looking at a blank page or indefinite spinner.

## Technical Audit

Example:

```text
Technical Audit

Connecting to PageSpeed Insights...

Fetching performance data...

Processing Lighthouse metrics...

Preparing technical report...
```

## SEO Audit

Example:

```text
SEO Audit

Preparing crawler...

Discovering URLs...

Crawling website...

Analyzing page metadata...

Checking links...

Checking indexability...

Analyzing cross-page signals...

Generating SEO report...
```

Where actual progress is available, display it.

For example:

```text
143 / 500 URLs analyzed
```

Do not fabricate progress values.

---

# 12. TECHNICAL AUDIT — GOOGLE PAGESPEED INSIGHTS

## Objective

The Technical Audit must use Google PageSpeed Insights as its primary data source.

Before implementing a new integration, inspect the Riviso codebase for any existing PageSpeed Insights or Lighthouse implementation.

If an existing integration exists:

- Reuse it.
- Extend it where necessary.
- Do not create duplicate API clients.
- Do not create a second PageSpeed implementation.

If an integration does not exist, implement the required integration using the existing Riviso infrastructure and configuration conventions.

---

# 13. TECHNICAL AUDIT REQUEST

When the user runs Technical Audit:

```text
Current Project
        ↓
Project Website
        ↓
PageSpeed Insights
        ↓
Retrieve PageSpeed/Lighthouse data
        ↓
Normalize required values
        ↓
Store/process audit result
        ↓
Display Technical Audit
```

The request must use the actual project website.

---

# 14. MOBILE AND DESKTOP

Where PageSpeed data is available, retrieve and display separate:

```text
Mobile
Desktop
```

Never silently combine Mobile and Desktop values.

Provide a clear UI control:

```text
Mobile | Desktop
```

Switching the selection should update the relevant metrics.

---

# 15. TECHNICAL OVERVIEW

The Technical Audit should start with the most important metrics.

Example:

```text
Technical Health

Mobile       72
Desktop      94
```

Then:

```text
Performance
Accessibility
Best Practices
SEO
```

Example:

```text
                    Mobile    Desktop

Performance            72        94
Accessibility          91        96
Best Practices         89        93
SEO                    100       100
```

These values must be derived from the actual PageSpeed response.

Never hardcode them.

---

# 16. CORE WEB VITALS

Display Core Web Vitals prominently.

At minimum, where returned:

- LCP
- INP
- CLS

Also show supporting metrics where PageSpeed provides them:

- FCP
- Speed Index
- TBT
- TTFB
- Other relevant Lighthouse metrics

Only display metrics that actually exist in the response.

Do not create fake values.

---

# 17. CORE WEB VITAL STATUS

Every Core Web Vital should clearly indicate its status.

Example:

```text
Largest Contentful Paint

2.1s

Good
```

or:

```text
Largest Contentful Paint

4.4s

Poor
```

Use the relevant Google/PageSpeed/Lighthouse classification.

Do not create conflicting custom thresholds.

---

# 18. PERFORMANCE METRICS

Display relevant performance metrics in a clean hierarchy.

Potential metrics:

```text
Performance Score
FCP
LCP
INP
CLS
Speed Index
TBT
TTFB
```

Metrics must be labeled correctly.

Avoid overwhelming the user with every raw API field.

Prioritize meaningful metrics first, with detailed diagnostics available below.

---

# 19. PERFORMANCE OPPORTUNITIES

Display PageSpeed opportunities returned by the API.

Examples may include:

- Eliminate render-blocking resources
- Reduce unused JavaScript
- Reduce unused CSS
- Optimize images
- Serve images in modern formats
- Properly size images
- Improve caching
- Reduce network payloads
- Reduce main-thread work
- Reduce JavaScript execution
- Optimize fonts
- Reduce third-party impact

Only show opportunities that actually exist in the PageSpeed response.

Each opportunity should show:

```text
Title
Description
Potential savings
Affected resources
Recommended action
```

Where those fields are available.

---

# 20. TECHNICAL DIAGNOSTICS

Show PageSpeed/Lighthouse diagnostics separately where appropriate.

Each diagnostic should be actionable.

Example:

```text
Unused JavaScript

Potential savings:
184 KiB

Description:
...

[ View Details ]
```

---

# 21. ACCESSIBILITY

Display PageSpeed/Lighthouse Accessibility results.

Include:

- Accessibility score
- Failed audits
- Relevant recommendations

Examples:

- Missing accessible labels
- Poor contrast
- Missing image alternatives
- ARIA problems
- Keyboard accessibility issues

Only report actual Lighthouse findings.

---

# 22. BEST PRACTICES

Display:

- Best Practices score
- Failed audits
- Relevant recommendations

Potential areas include:

- Browser compatibility
- Deprecated APIs
- Console errors
- Security-related signals
- Implementation issues

Only display checks returned by PageSpeed/Lighthouse.

---

# 23. PAGESPEED SEO CATEGORY

If PageSpeed provides an SEO score, display it.

However, clearly label it as:

```text
PageSpeed SEO Score
```

Do not call this:

```text
Riviso SEO Score
```

It must remain clear that this is one PageSpeed/Lighthouse category.

The dedicated Riviso SEO Audit remains independent.

---

# 24. TECHNICAL AUDIT SCORE

If Riviso wants to provide a summarized Technical Health Score, it must be derived from actual PageSpeed data.

It must not be:

- Random
- Hardcoded
- Artificial
- Unrelated to PageSpeed results

If a Riviso-specific score is created, label it explicitly:

```text
Riviso Technical Health Score
```

and keep the underlying Google metrics visible.

---

# 25. TECHNICAL AUDIT REFRESH

Provide:

```text
[ Re-run Technical Audit ]
```

When clicked:

1. Request fresh PageSpeed data.
2. Display running state.
3. Process the response.
4. Update the current result.
5. Update the audit timestamp.
6. Preserve historical data if history is supported.

A failed refresh must not destroy the previous successful audit.

---

# 26. TECHNICAL AUDIT LAST UPDATED

Display:

```text
Last audited:
11 Aug 2026 • 11:32 AM
```

This timestamp must represent the actual successful audit.

Do not display `Invalid Date`.

---

# 27. SEO AUDIT — RIVISO CRAWLER

## Objective

The SEO Audit must function as a genuine website crawler.

The crawler should work conceptually similar to Screaming Frog:

```text
Website
   ↓
Crawl
   ↓
Discover URLs
   ↓
Fetch pages
   ↓
Parse HTML
   ↓
Extract SEO information
   ↓
Cross-reference URLs
   ↓
Detect issues
   ↓
Generate report
```

The goal is to audit the website as a complete system, not merely inspect the homepage.

---

# 28. SEO CRAWLER START POINT

Start from the project's configured website.

Example:

```text
https://example.com/
```

Discover URLs from:

- Internal links
- XML sitemap
- Canonical references
- Relevant HTML references

Where supported.

---

# 29. URL NORMALIZATION

The crawler must avoid unnecessary duplicate crawling caused by URL variations.

Handle appropriately:

- Trailing slashes
- HTTP/HTTPS
- URL encoding
- Fragments
- Query parameters
- Case differences where applicable
- Duplicate URL representations

Do not incorrectly collapse genuinely different URLs.

---

# 30. CRAWL SAFETY

The crawler must operate responsibly.

Respect:

- robots.txt
- Crawl limits
- Request limits
- Plan limitations
- Existing system limitations
- Website restrictions

Do not create an uncontrolled crawler that can overwhelm a customer's website.

---

# 31. SEO CRAWL PROGRESS

Show actual crawl progress where available.

Example:

```text
SEO Audit

Crawling website...

245 / 500 URLs

Analyzing:
https://example.com/services/
```

If exact progress cannot be determined, use a meaningful indeterminate state rather than fake percentages.

---

# 32. CRAWL SUMMARY

After completion, show:

```text
SEO Audit

245 URLs Crawled

226 Successful
12 Redirects
5 Client Errors
2 Server Errors
```

Also provide:

```text
Total Internal URLs
Total External URLs
Indexable URLs
Non-indexable URLs
```

Only show values supported by actual crawl data.

---

# 33. HTTP STATUS ANALYSIS

For every crawled URL, record relevant HTTP information.

Support:

- 200
- 3xx
- 301
- 302
- 4xx
- 400
- 401
- 403
- 404
- 410
- 5xx
- 500
- 502
- 503

Group them meaningfully.

---

# 34. REDIRECT ANALYSIS

Identify:

- Redirecting URLs
- Redirect destination
- Redirect chains
- Redirect loops
- Internal links pointing to redirects

Example:

```text
/page-a/
   ↓ 301
/page-b/
   ↓ 301
/page-c/
```

This should be identified as a redirect chain.

---

# 35. BROKEN INTERNAL LINKS

Detect internal links pointing to:

- 4xx
- 5xx
- Invalid URLs
- Failed destinations

For every broken link provide:

```text
Source URL
Destination URL
Status
Anchor Text
```

---

# 36. TITLE TAG AUDIT

For every HTML page analyze:

- Title exists
- Title content
- Title length
- Duplicate title
- Empty title
- Multiple title tags

Potential issues:

```text
Missing title
Duplicate title
Title too short
Title too long
Multiple title tags
```

Severity should be contextual.

---

# 37. META DESCRIPTION AUDIT

Analyze:

- Presence
- Content
- Length
- Duplicates
- Empty descriptions

Potential issues:

```text
Missing
Duplicate
Too short
Too long
```

Do not mark every unusual length as a critical issue.

---

# 38. H1 AUDIT

Analyze:

- Missing H1
- Multiple H1
- Empty H1
- Duplicate H1

Store:

```text
H1 count
H1 content
```

---

# 39. HEADING STRUCTURE

Collect:

```text
H1
H2
H3
H4
H5
H6
```

Analyze obvious structural problems.

Do not treat every heading-level variation as a critical SEO issue.

---

# 40. CANONICAL ANALYSIS

Analyze:

- Canonical exists
- Missing canonical
- Self-referencing canonical
- Canonical to another URL
- Canonical to redirect
- Canonical to error
- Canonical to non-indexable URL
- Canonical conflicts

Where possible, compare canonical target against crawl data.

---

# 41. INDEXABILITY

Determine indexability using actual available signals:

- HTTP status
- Meta robots
- X-Robots-Tag
- Canonical
- Robots restrictions

Classify:

```text
Indexable
Noindex
Blocked
Redirect
Error
```

Do not automatically classify intentionally noindexed pages as errors.

---

# 42. ROBOTS.TXT

Analyze:

- Existence
- Accessibility
- HTTP status
- User-agent rules
- Disallow
- Allow
- Sitemap declaration

Identify important URLs potentially affected by robots rules.

Do not label every Disallow as an error.

---

# 43. XML SITEMAP

Analyze:

- Sitemap availability
- Sitemap status
- Sitemap structure
- URLs
- Broken sitemap URLs
- Redirected URLs
- Noindex URLs
- Canonical conflicts
- Sitemap/crawl differences

Where possible, compare:

```text
Sitemap URLs
vs
Crawled URLs
vs
Indexable URLs
```

---

# 44. INTERNAL LINKING

Analyze:

- Incoming internal links
- Outgoing internal links
- Pages with zero internal links
- Pages with low internal link counts
- Excessive internal links
- Links to redirects
- Links to broken pages

Identify orphan candidates where confidence is sufficient.

Do not falsely label pages as orphaned when the crawler lacks enough information.

---

# 45. EXTERNAL LINKS

Where supported, collect:

- External URL
- Source URL
- Anchor text
- Nofollow
- Sponsored
- UGC
- Redirect status
- HTTP status

---

# 46. IMAGE SEO AUDIT

Analyze:

- Image URL
- Status
- Alt text
- Empty alt
- Missing alt
- Width
- Height
- Format
- Lazy-loading information where detectable

Do not automatically classify empty alt attributes as errors because decorative images can legitimately use empty alt values.

---

# 47. CONTENT AUDIT

Collect measurable content signals:

- Word count
- Main content availability
- Very low-content pages
- Empty pages
- Duplicate content
- Near-duplicate content

Do not classify every short page as thin content.

Consider page purpose.

---

# 48. DUPLICATE ANALYSIS

At minimum identify:

- Duplicate titles
- Duplicate meta descriptions
- Duplicate H1s

Where technically feasible:

- Duplicate page content
- Near-duplicate page content

Distinguish:

```text
Exact duplicate
Near duplicate
Similar
```

Avoid false positives caused by common navigation/footer elements.

---

# 49. STRUCTURED DATA

Analyze detectable structured data:

- JSON-LD
- Microdata
- RDFa

Identify:

- Schema presence
- Schema type
- Parsing errors
- Potential structural issues

Do not claim full Google Rich Results validity unless an actual validation service has been used.

---

# 50. SOCIAL METADATA

Where applicable, inspect:

- OG title
- OG description
- OG image
- Twitter/X title
- Twitter/X description
- Twitter/X image

Treat missing social metadata as a lower-priority recommendation unless there is a strong reason otherwise.

---

# 51. URL STRUCTURE

Collect relevant URL information:

- Protocol
- URL length
- Query parameters
- Fragments
- Trailing slash
- Encoding
- Duplicate variants

Only identify meaningful issues.

Do not create arbitrary SEO warnings simply because a URL looks different from Riviso's preferred format.

---

# 52. CRAWL DEPTH

Track crawl depth where possible.

Example:

```text
Homepage
Depth 0

Services
Depth 1

Service Page
Depth 2

Article
Depth 3
```

This helps users understand internal site architecture.

---

# 53. RESPONSE TIME

Where the crawler records response timing, expose it as crawl-level information.

Important:

Crawler response time must **not** be represented as Core Web Vitals.

Core Web Vitals belong to Technical Audit/PageSpeed.

---

# 54. SEO HEALTH SCORE

The SEO Audit can provide:

```text
Riviso SEO Health Score
```

Example:

```text
84 / 100
```

The score must be calculated from actual audit results.

It must not be hardcoded.

The score should reflect:

- Severity
- Number of affected pages
- Scale of issue
- SEO significance

The score must not hide the actual problems.

---

# 55. SEO SUMMARY

Show:

```text
SEO Health
84 / 100

245 URLs Crawled

Critical
3

High
12

Medium
21

Low
8

Passed
94
```

The exact values must come from the crawl.

---

# 56. ISSUE SEVERITY

Use:

```text
Critical
High
Medium
Low
Notice
Passed
```

Severity should reflect actual impact.

Do not make everything Critical.

Examples of potentially serious issues:

- Large-scale 5xx errors
- Important pages returning 404
- Important pages blocked from indexing
- Large-scale missing titles
- Major canonical conflicts

Examples of lower-impact issues:

- Missing social metadata
- Minor heading recommendations
- Image optimization suggestions

---

# 57. ISSUE LIST

Provide an issue overview.

Example:

```text
Issues

Critical     3
High         12
Medium       21
Low           8
```

Clicking a severity should filter the issue list.

---

# 58. ISSUE DETAILS

Every issue must answer:

```text
What is wrong?

Why does it matter?

Where is it happening?

What should be done?
```

Example:

```text
Missing Meta Descriptions

High

23 pages are missing meta descriptions.

Affected URLs:
23

Recommended action:
Add unique, descriptive meta descriptions.

[ View Affected URLs ]
```

---

# 59. AFFECTED URL LIST

When users open an issue, display affected URLs.

Columns:

```text
URL
Status
Detected Value
Issue
```

Allow:

- Search
- Sort
- Filter
- Open URL details

---

# 60. URL EXPLORER

The SEO Audit must have a detailed URL-level dataset.

Suggested columns:

```text
URL
Status Code
Indexability
Title
Title Length
Meta Description
Meta Description Length
H1
Canonical
Word Count
Internal Links
External Links
Images
Response Time
Crawl Depth
```

The table must support:

- Search
- Filtering
- Sorting
- Pagination

Do not render thousands of records at once.

---

# 61. URL DETAIL VIEW

Clicking a URL should provide:

```text
URL

HTTP Status
200

Indexability
Indexable

Title
Present

Meta Description
Present

H1
Present

Canonical
Self-referencing

Word Count
1,284

Internal Links
14

External Links
3

Images
8

Crawl Depth
2

Issues
2
```

Then show all detected issues for that URL.

---

# 62. SEO FILTERS

Support:

```text
All
Critical
High
Medium
Low
Passed
```

Issue categories:

```text
Metadata
Indexability
Links
Content
Images
Canonical
Sitemap
Robots
Schema
Social
URLs
Status Codes
```

---

# 63. SEARCH

Provide URL-level search.

Search should be able to match:

- URL
- Title
- H1
- Issue
- Status

---

# 64. CRAWL LIMITS

Use existing Riviso plan/system limitation functionality.

If a plan permits only a certain number of pages, enforce that limit.

Example:

```text
Your current audit limit:
500 pages

Pages discovered:
245
```

Do not silently exceed limits.

If the limit is reached:

```text
Audit limit reached.

500 pages were analyzed.

[ View Results ]
```

---

# 65. CRAWL CANCELLATION

If the infrastructure supports cancellation, provide:

```text
[ Cancel Audit ]
```

When cancelled:

- Stop initiating new requests.
- Preserve safely collected data where appropriate.
- Mark audit as cancelled.
- Do not present incomplete results as a completed audit.

---

# 66. AUDIT HISTORY

Where supported by the existing application architecture, maintain historical audits.

Example:

```text
Audit History

11 Aug 2026
04 Aug 2026
28 Jul 2026
```

The user should eventually be able to compare:

```text
Current Audit
Previous Audit
```

---

# 67. AUDIT COMPARISON

Make the implementation future-ready for:

```text
Previous SEO Score: 76
Current SEO Score: 84

Improvement: +8
```

Potential comparison metrics:

- SEO score
- Critical issues
- High issues
- 404 pages
- Missing titles
- Missing descriptions
- Indexability issues
- Broken links

Do not display comparison information if historical data does not exist.

---

# 68. TECHNICAL AUDIT VS SEO AUDIT UI

The UI should communicate the difference.

Technical Audit:

```text
Powered by Google PageSpeed Insights
```

SEO Audit:

```text
Analyzed by Riviso SEO Crawler
```

This provides transparency and avoids confusion.

---

# 69. IMPORTANT SCORE DISTINCTION

There are potentially three different scores:

### PageSpeed Performance

Google's performance score.

### PageSpeed SEO

Google Lighthouse's SEO category.

### Riviso SEO Health Score

Riviso's own crawler-based SEO evaluation.

Never represent these as the same score.

---

# 70. NO FAKE DATA

This feature must follow a strict accuracy principle.

Never display:

- Fake performance scores
- Fake SEO scores
- Fake URL counts
- Fake crawl progress
- Fake issue counts
- Fake Core Web Vitals
- Fake PageSpeed metrics
- Fake audit dates

Every displayed metric must come from:

```text
Google PageSpeed Insights
```

or:

```text
Riviso SEO Crawler
```

or be a deterministic calculation based on those real results.

---

# 71. PARTIAL DATA

If PageSpeed returns partial information:

Display what is available.

Do not fabricate missing values.

If SEO crawling encounters pages that cannot be analyzed:

Example:

```text
245 URLs discovered

232 analyzed successfully

13 could not be analyzed
```

The user must understand the actual audit coverage.

---

# 72. WEBSITE FAILURE

If the website is unreachable:

```text
Website unavailable

Riviso could not reach the configured website.

Check the website and try again.

[ Try Again ]
```

Do not display a successful audit.

---

# 73. PAGE SPEED API FAILURE

If PageSpeed fails:

```text
Technical Audit unavailable

Google PageSpeed Insights did not return
a valid result.

Your previous successful audit has been preserved.

[ Try Again ]
```

Do not delete previous successful data.

---

# 74. SEO CRAWL FAILURE

If the crawler fails:

```text
SEO Audit could not be completed.

The crawler was unable to complete the audit.

[ Try Again ]
```

If partial crawl data can safely be preserved, clearly label it as partial.

---

# 75. DATE HANDLING

Every audit should display a valid timestamp.

Example:

```text
Last audited:
11 Aug 2026 • 11:32 AM
```

Never allow:

```text
Invalid Date
```

If a timestamp is missing, use an explicit fallback such as:

```text
Not available
```

rather than an invalid date string.

---

# 76. AUDIT DATA PERSISTENCE

Successful audit results should be retained according to the existing Riviso data persistence model.

Do not make the UI depend entirely on a temporary frontend state.

A page refresh should not unexpectedly erase the latest audit.

The user should be able to return to Site Audit and see the latest successful audit.

---

# 77. REFRESH BEHAVIOUR

Refreshing the browser must not trigger a new crawl automatically.

A new audit should occur only when the user explicitly requests it or when an existing scheduled/background mechanism intentionally invokes it.

---

# 78. RE-RUN BEHAVIOUR

When the user runs an audit again:

Do not confuse:

```text
Previous Audit
```

with:

```text
Current Running Audit
```

The previous successful result should remain available until the new audit completes successfully.

---

# 79. UX DESIGN PRINCIPLE

The Site Audit interface should not feel like a raw developer diagnostic console.

It should feel like a professional SaaS audit product.

The user should immediately understand:

```text
How healthy is my website?
What are the biggest problems?
Which pages are affected?
What should I fix first?
```

---

# 80. DESIGN HIERARCHY

The preferred information hierarchy is:

```text
Site Audit Header
        ↓
Website + Last Audit + Action
        ↓
Technical Audit / SEO Audit
        ↓
Health Summary
        ↓
Primary Metrics
        ↓
Critical Issues
        ↓
Warnings / Opportunities
        ↓
Detailed Results
        ↓
URL-Level Analysis
```

Do not put the massive URL dataset at the top of the page.

---

# 81. VISUAL DESIGN

Use the existing Riviso visual language.

Maintain:

- Existing dark theme
- Typography
- Orange/brand accent
- Card styling
- Borders
- Buttons
- Pills
- Status indicators
- Spacing
- Navigation
- Icons
- Responsive behavior

The module should feel native to Riviso.

---

# 82. ENGAGEMENT

The audit should feel active and informative.

During execution, communicate what is happening.

After completion, clearly show the outcome.

Example:

```text
SEO Audit Complete

245 pages analyzed

3 critical issues
12 high-priority issues
21 medium issues

SEO Health
84 / 100

[ View Critical Issues ]
```

This creates a clear transition from:

```text
Running
```

to:

```text
Actionable Result
```

---

# 83. ACTIONABLE RECOMMENDATIONS

Every meaningful issue should include a recommendation.

Example:

```text
Broken Internal Links

12 pages affected.

Why it matters:
Broken internal links prevent users and crawlers
from reaching the intended destination.

Recommended action:
Update or remove the broken links.

[ View 12 URLs ]
```

Recommendations must be based on the detected issue.

Do not generate generic AI recommendations that do not correspond to the actual audit data.

---

# 84. CROSS-PAGE ANALYSIS

The SEO crawler must not only analyze pages independently.

It must also perform cross-page analysis.

Examples:

```text
Duplicate titles
Duplicate descriptions
Duplicate H1s
Canonical conflicts
Internal linking
Orphan candidates
Redirect chains
Sitemap mismatches
Duplicate URLs
```

This is a key requirement for making the SEO Audit comparable to professional crawling tools.

---

# 85. SEO CRAWLER DATA FLOW

The crawler should conceptually work as:

```text
Project
   ↓
Website URL
   ↓
Crawler Initialization
   ↓
robots.txt
   ↓
Sitemap Discovery
   ↓
Homepage
   ↓
Internal URL Discovery
   ↓
URL Queue
   ↓
HTTP Fetch
   ↓
HTML Parsing
   ↓
SEO Extraction
   ↓
URL Dataset
   ↓
Cross-URL Analysis
   ↓
Issue Detection
   ↓
Severity Classification
   ↓
SEO Score
   ↓
Audit Report
```

---

# 86. TECHNICAL AUDIT DATA FLOW

Technical Audit should conceptually work as:

```text
Project
   ↓
Website URL
   ↓
PageSpeed Insights Request
   ↓
Mobile Result
Desktop Result
   ↓
Lighthouse Metrics
   ↓
Core Web Vitals
   ↓
Opportunities
   ↓
Diagnostics
   ↓
Category Scores
   ↓
Riviso Processing
   ↓
Technical Audit Report
```

---

# 87. FULL USER FLOW

The complete user journey should be:

```text
User opens project
        ↓
User selects Site Audit
        ↓
Riviso loads current project's website
        ↓
User sees:
Technical Audit | SEO Audit
        ↓
User selects audit
        ↓
User clicks Run Audit
        ↓
Riviso validates website
        ↓
Audit starts
        ↓
Real data is collected
        ↓
Data is analyzed
        ↓
Audit completes
        ↓
Results are displayed
        ↓
User reviews summary
        ↓
User opens critical issues
        ↓
User opens affected URLs
        ↓
User reviews recommendations
        ↓
User fixes website issues
        ↓
User returns to Riviso
        ↓
User re-runs audit
        ↓
Riviso shows updated results
```

---

# 88. FUTURE-READY STRUCTURE

The implementation should be capable of supporting future functionality such as:

- Audit history
- Audit comparison
- Automated monitoring
- Scheduled audits
- SEO issue tracking
- Issue status
- Fixed/unfixed states
- SEO score trends
- Technical score trends
- Automated fixes
- WordPress issue fixing
- Audit reports
- Client-ready reports
- PDF exports
- Email reports

Do not implement these automatically unless already part of the requested scope.

However, avoid implementation decisions that would make them unnecessarily difficult later.

---

# 89. PERFORMANCE REQUIREMENTS

The Site Audit UI must remain responsive.

For Technical Audit:

- Avoid blocking the main UI while waiting for PageSpeed.
- Show proper loading state.
- Handle timeout gracefully.

For SEO Audit:

- Do not load the entire crawl dataset into the browser unnecessarily.
- Use pagination/virtualization for large datasets.
- Avoid rendering thousands of DOM elements simultaneously.
- Keep filtering responsive.
- Keep issue navigation fast.

---

# 90. SECURITY

Do not expose:

- PageSpeed API credentials
- Internal API credentials
- Database credentials
- Server credentials
- Internal infrastructure details
- Raw exception traces

Validate project/user access before allowing audit operations.

A user must only be able to audit websites belonging to projects they are authorized to access.

---

# 91. ROLE & PERMISSION BEHAVIOUR

Site Audit should follow existing Riviso project-level permission rules.

If a user can access a project and its audit functionality, they can use Site Audit according to their role.

Do not create an unrelated permission system.

Respect existing shared-project/member permissions.

---

# 92. PROJECT SWITCHING

When switching projects:

```text
Project A
   ↓
Site Audit
   ↓
Switch Project
   ↓
Project B
   ↓
Site Audit
```

The UI must update:

- Website
- Audit results
- Last audit timestamp
- Technical metrics
- SEO metrics
- URL dataset
- Issues

Never display Project A's audit data under Project B.

---

# 93. CACHE / STALE DATA

If the latest audit is not fresh, clearly show when it was performed.

Example:

```text
Last audited:
7 days ago
```

Do not silently represent old audit data as current.

When the user explicitly runs a new audit, retrieve fresh data.

---

# 94. TECHNICAL AUDIT DATA ACCURACY

Technical Audit must always distinguish:

```text
Latest PageSpeed result
```

from:

```text
Previous PageSpeed result
```

If a new PageSpeed request fails, keep the previous successful result and communicate the failure.

---

# 95. SEO AUDIT DATA ACCURACY

SEO Audit must distinguish:

```text
Completed crawl
```

from:

```text
Partial crawl
```

A crawl that stops halfway must not be represented as a full website audit.

---

# 96. EMPTY / ZERO RESULTS

Do not confuse:

```text
No issues
```

with:

```text
Audit not run
```

These are different states.

### Audit not run

```text
No audit data available.
Run an audit.
```

### Audit completed with no issues

```text
No significant issues detected.
```

---

# 97. IMPLEMENTATION REQUIREMENT — INSPECT FIRST

Before writing code, inspect the existing Riviso codebase.

Understand:

- Existing routing
- Existing project context
- Existing project selection
- Existing authentication
- Existing role/permission system
- Existing website configuration
- Existing API patterns
- Existing PageSpeed integration
- Existing crawler functionality
- Existing SEO utilities
- Existing database patterns
- Existing UI components
- Existing loading states
- Existing error handling
- Existing date formatting
- Existing design system

Do not make assumptions about the codebase.

---

# 98. REUSE EXISTING FUNCTIONALITY

Prioritize reuse of existing components and services.

Look specifically for:

```text
PageSpeed
Lighthouse
Crawler
SEO
Sitemap
Robots
URL parser
HTML parser
Project
Website
Audit
Score
```

If existing functionality can perform part of this task, extend it rather than recreating it.

---

# 99. DO NOT BUILD A MOCK

The implementation must not stop at:

- UI cards
- Static scores
- Dummy charts
- Fake crawl results
- Hardcoded issue counts
- Mock URLs

The complete flow must work using actual data.

---

# 100. DO NOT OVERENGINEER

Do not introduce unnecessary new services, databases, APIs, libraries, or architectural layers when the existing Riviso implementation already provides suitable functionality.

Use the existing architecture.

Only introduce new infrastructure where the existing implementation genuinely cannot support the required behavior.

---

# 101. VALIDATION REQUIREMENTS

Before considering the feature complete, verify:

## Navigation

- Site Audit appears correctly.
- Existing navigation is not broken.
- Project context works.

## Technical Audit

- PageSpeed request works.
- Mobile data works.
- Desktop data works.
- Performance score is accurate.
- Core Web Vitals are accurate.
- Accessibility is accurate.
- Best Practices are accurate.
- Opportunities are accurate.
- Diagnostics are accurate.
- PageSpeed SEO score is clearly distinguished.
- Refresh works.
- Errors are handled.

## SEO Audit

- Crawler starts.
- URLs are discovered.
- URLs are deduplicated.
- HTTP status is recorded.
- Redirects are detected.
- Broken links are detected.
- Titles are analyzed.
- Meta descriptions are analyzed.
- H1s are analyzed.
- Canonicals are analyzed.
- Indexability is analyzed.
- Robots.txt is analyzed.
- Sitemap is analyzed.
- Internal links are analyzed.
- External links are analyzed.
- Images are analyzed.
- Content signals are analyzed.
- Duplicate signals are analyzed.
- Structured data is analyzed.
- Social metadata is analyzed.
- Crawl depth is recorded where supported.
- URL explorer works.
- Issue filtering works.
- URL details work.
- SEO score is calculated from actual results.
- Refresh works.
- Crawl failures are handled.

---

# 102. CRITICAL VALIDATION

Explicitly test the following:

### Technical Audit

```text
Valid website
Invalid website
Website unavailable
PageSpeed success
PageSpeed timeout
PageSpeed API failure
Mobile result
Desktop result
Partial PageSpeed response
```

### SEO Audit

```text
Small website
Large website
Website with redirects
Website with 404s
Website with 5xx errors
Website with missing titles
Website with duplicate titles
Website with missing descriptions
Website with noindex pages
Website with canonical issues
Website with broken internal links
Website with sitemap
Website without sitemap
Website with robots.txt
Website without robots.txt
Crawl limit reached
Crawler failure
Partial crawl
```

---

# 103. FINAL EXPECTED RESULT

The final Site Audit module should feel like a major Riviso product feature.

It should provide:

```text
                 SITE AUDIT
                     │
          ┌──────────┴──────────┐
          │                     │
   TECHNICAL AUDIT          SEO AUDIT
          │                     │
   Google PageSpeed        Riviso Crawler
          │                     │
   Performance             Crawlability
   Core Web Vitals         Indexability
   Accessibility           Metadata
   Best Practices          Titles
   Diagnostics             Descriptions
   Opportunities           Headings
   Mobile                  Canonicals
   Desktop                 Links
                           Sitemap
                           Robots
                           Images
                           Content
                           Schema
                           Duplicates
                           URL Structure
                           Crawl Depth
```

The user should be able to answer two fundamental questions from the module:

### Technical Audit

> **How well is my website performing technically according to Google PageSpeed Insights?**

### SEO Audit

> **What SEO problems exist across my website, which URLs are affected, and what should I fix?**

---

# 104. DEFINITION OF DONE

This feature is considered complete only when:

- Site Audit is available within the project.
- Technical Audit and SEO Audit are separate tabs.
- Technical Audit uses real Google PageSpeed Insights data.
- Mobile and Desktop results are correctly separated.
- Core Web Vitals are displayed accurately.
- PageSpeed opportunities and diagnostics are displayed accurately.
- SEO Audit uses the actual Riviso crawler.
- The crawler discovers and analyzes real website URLs.
- Cross-page SEO analysis works.
- SEO issues are categorized and prioritized.
- Affected URLs can be inspected.
- URL-level details work.
- Audit results persist correctly.
- Audit timestamps are accurate.
- Re-running audits retrieves fresh data.
- Existing successful results are preserved if a refresh fails.
- Project switching does not leak audit data between projects.
- Permissions are respected.
- No fake data is displayed.
- No `Invalid Date` values appear.
- Loading and error states are handled properly.
- Large crawl results remain performant.
- Existing Riviso functionality remains unaffected.
- The implementation is integrated into the existing Riviso architecture rather than creating an unnecessary parallel system.

---

# 105. FINAL IMPLEMENTATION INSTRUCTION

**Do not begin by designing the UI and then attempting to connect the data later.**

First understand how Riviso currently handles:

```text
Project
Website
Authentication
API requests
PageSpeed
SEO
Crawler
Database
State management
Routing
Permissions
```

Then implement Site Audit as an integrated feature.

The implementation order should be:

```text
1. Inspect existing Riviso implementation
        ↓
2. Identify reusable infrastructure
        ↓
3. Verify project → website relationship
        ↓
4. Verify existing PageSpeed functionality
        ↓
5. Verify existing crawler/SEO functionality
        ↓
6. Implement Technical Audit data flow
        ↓
7. Implement SEO Audit crawl flow
        ↓
8. Implement result processing
        ↓
9. Implement issue classification
        ↓
10. Implement Site Audit UI
        ↓
11. Implement loading/error/empty states
        ↓
12. Implement URL-level details
        ↓
13. Validate project switching and permissions
        ↓
14. Test with real websites
        ↓
15. Fix edge cases
        ↓
16. Verify no regressions
```

**Do not consider the task complete merely because the Site Audit page renders.**

The feature is complete only when the user can enter a project, open Site Audit, run either audit, receive real data, see accurate results, inspect issues and affected URLs, and re-run the audit successfully.

The final implementation must be **production-ready, data-driven, accurate, maintainable, and fully integrated with the existing Riviso application.**
