# Riviso SEO Audit — Full Product, Crawl Engine, Data Model & UI/UX Specification

**Document:** `SEO-Audit-Design.md`  
**Product:** Riviso  
**Module:** Site Audit → SEO Audit  
**Status:** Engineering / Product Master Specification  
**Primary reference UI:** The four supplied Riviso SEO Audit screenshots and the approved dark-mode dashboard direction.  
**Functional benchmark:** Screaming Frog SEO Spider feature coverage, while using Riviso's own implementation, terminology, scoring and UI.

---

## 1. Purpose

This document defines the complete SEO Audit module for Riviso.

The objective is not to build a simple checklist-based SEO report. Riviso SEO Audit must operate as a real crawler and analysis system that:

1. discovers URLs;
2. queues and crawls URLs;
3. follows links and crawl directives;
4. stores raw HTTP, HTML, rendered DOM and extracted SEO data;
5. classifies every URL;
6. calculates URL-level SEO properties;
7. calculates site-level aggregates;
8. detects SEO issues, warnings and opportunities;
9. exposes every affected URL;
10. provides a searchable URL Explorer;
11. provides URL-level drill-down;
12. provides site structure and crawl-depth analysis;
13. preserves crawl history;
14. supports re-crawls and comparisons;
15. supports paid-plan crawling without an artificial 500-URL cap;
16. scales from small websites to large enterprise sites.

Screaming Frog currently documents more than 300 issues, warnings and opportunities, and its crawler exposes URL-level data across tabs such as Internal, External, Response Codes, URL, Page Titles, Meta Description, H1, H2, Content, Images, Canonicals, Pagination, Directives, Hreflang, AMP, Sitemaps, Site Structure, Segments and Response Times. Riviso should cover the same *functional categories* while maintaining its own product architecture and scoring model.

---

# 2. Product Principles

## 2.1 Data first

Every dashboard number must originate from stored crawl data.

Never hard-code:

- URL counts
- issue counts
- SEO scores
- indexability
- crawl depth
- response codes
- word counts
- internal links
- external links
- canonical status
- metadata counts

The UI is a projection of crawl results.

---

## 2.2 Every issue must be traceable

Every issue must resolve to:

```text
Issue
  → affected URL count
  → affected URL list
  → URL detail
  → evidence
  → rule that triggered the issue
  → recommended action
```

Example:

```text
Missing Meta Description
237 URLs
↓
View URLs
↓
/articles/example/
↓
Meta description: NULL
Status: 200
Indexable: YES
Canonical: self
```

---

## 2.3 Never hide crawler limitations

If a page could not be rendered, display:

```text
Rendering: Failed
Reason: JavaScript timeout
```

Do not silently classify the page as "no content".

If a URL was blocked by robots.txt:

```text
Crawl Status: Blocked
Reason: robots.txt
```

If a URL was discovered but not crawled because of plan limits, show:

```text
Discovered
Not Crawled
Reason: Crawl quota
```

---

## 2.4 Separate discovery from crawling

A URL can be:

- discovered;
- queued;
- crawling;
- crawled;
- failed;
- blocked;
- skipped;
- excluded;
- orphaned.

These states must not be collapsed.

---

# 3. Reference UI / UX Direction

The current Riviso interface shown in the supplied screenshots should remain the foundation.

## 3.1 Visual language

Use:

- dark black/charcoal background;
- Riviso orange accent;
- subtle bordered cards;
- compact data density;
- rounded 8–12px surfaces;
- strong typography hierarchy;
- green for healthy;
- amber/yellow for warnings;
- red for errors;
- neutral gray for informational states;
- restrained purple/blue only for secondary data dimensions;
- no excessive gradients;
- no decorative illustrations that compete with audit data.

---

# 4. SEO Audit Information Architecture

The SEO Audit page must be organized into the following primary layers.

```text
SEO Audit
│
├── Header
│   ├── Website
│   ├── Audit status
│   ├── Last audited
│   ├── Crawled URLs
│   ├── Crawl settings
│   └── Actions
│
├── Summary
│   ├── SEO Health Score
│   ├── Crawlability
│   ├── Indexability
│   ├── On-Page
│   └── Internal Linking
│
├── Audit History
│
├── Issues
│   ├── Errors
│   ├── Warnings
│   └── Opportunities
│
├── URL Explorer
│
├── Site Structure
│
├── Crawl Statistics
│
├── Internal Links
│
├── External Links
│
├── Redirects
│
├── Canonicals
│
├── XML Sitemaps
│
├── Hreflang
│
├── Structured Data
│
├── Images
│
├── Content
│
├── Directives
│
├── Response Times
│
└── Reports / Export
```

The dashboard should not display every metric at once. It should expose the highest-value information first and progressively disclose deeper data.

---

# 5. Top Header

## UI

```text
SEO Audit                         [Completed]
sheokandlegal.com ▼

Crawled 5,234 URLs · Aug 12, 2026 03:54 PM
View Crawl Settings

                              [Schedule] [Compare] [Export] [Re-run Audit]
```

## Required fields

- audit name
- website hostname
- crawl status
- crawl start
- crawl completion
- total discovered URLs
- total crawled URLs
- crawl duration
- crawl configuration link
- last audit link

## States

### Running

```text
SEO Audit   [Crawling 64%]
```

### Paused

```text
SEO Audit   [Paused]
```

### Completed

```text
SEO Audit   [Completed]
```

### Failed

```text
SEO Audit   [Failed]
```

---

# 6. Crawl Progress UX

While crawling, show a persistent progress surface.

```text
SEO Audit
Crawling sheokandlegal.com

████████████████████░░░░  78%

4,124 / 5,287 URLs crawled

Discovered       5,287
Queued             861
Crawled          4,124
Errors              42
Blocked             16

[Pause Crawl] [Cancel Crawl]
```

Additional live metrics:

- requests/sec
- pages/sec
- average response time
- current URL
- HTTP 2xx
- 3xx
- 4xx
- 5xx
- blocked
- JavaScript rendering count

---

# 7. Crawl Engine Architecture

## 7.1 Crawl pipeline

```text
Seed URL
   ↓
URL Normalization
   ↓
robots.txt evaluation
   ↓
URL deduplication
   ↓
URL discovery queue
   ↓
Priority scheduler
   ↓
HTTP request
   ↓
Response classification
   ↓
HTML extraction
   ↓
SEO extraction
   ↓
Link extraction
   ↓
Optional JS rendering
   ↓
Rendered extraction
   ↓
Issue evaluation
   ↓
Persist URL result
   ↓
Discover new URLs
   ↓
Queue new URLs
   ↓
Repeat
   ↓
Crawl analysis
   ↓
Site aggregates
   ↓
SEO score
```

---

# 8. URL Discovery

Riviso must discover URLs from:

1. seed URL;
2. `<a href>`;
3. `<link href>`;
4. canonical;
5. hreflang;
6. AMP;
7. meta refresh;
8. iframe;
9. images;
10. CSS references where configured;
11. JavaScript-discovered links;
12. rendered DOM links;
13. XML sitemap;
14. sitemap index;
15. robots.txt sitemap declarations;
16. Google Search Console;
17. Google Analytics;
18. uploaded URL lists;
19. manually supplied URLs;
20. API sources.

---

# 9. URL Normalization

Before inserting a URL into the crawl queue:

```text
normalize(rawUrl)
```

Perform:

- lowercase hostname;
- remove default port;
- normalize percent encoding;
- normalize dot segments;
- normalize protocol;
- resolve relative URLs;
- preserve meaningful path case;
- configurable trailing slash normalization;
- configurable query parameter handling;
- fragment removal;
- punycode normalization;
- canonical host handling.

Fragments must not create separate crawl URLs.

Example:

```text
https://example.com/page#section-1
https://example.com/page#section-2
```

Both resolve to:

```text
https://example.com/page
```

---

# 10. Crawl Scope

Configuration must support:

```text
Same URL
Same hostname
Same domain
All subdomains
External URLs
```

Example:

```text
Start:
https://example.com/

Allowed:
example.com/*
```

Optional:

```text
www.example.com/*
blog.example.com/*
shop.example.com/*
```

---

# 11. Robots.txt

## Fetch

Request:

```text
GET /robots.txt
```

Store:

- status code;
- response time;
- content;
- crawl-delay if relevant;
- user-agent groups;
- allow rules;
- disallow rules;
- sitemap declarations.

## Evaluation

For each URL:

```text
robotsAllowed(url, userAgent)
```

Return:

```json
{
  "allowed": true,
  "matchedRule": null,
  "userAgent": "*"
}
```

If blocked:

```text
Indexability: Unknown
Crawlability: Blocked by robots.txt
```

Do not pretend robots-blocked pages were analyzed as normal HTML pages.

---

# 12. HTTP Request Layer

Every request must store:

- requested URL;
- final URL;
- method;
- status code;
- status text;
- protocol;
- response headers;
- request headers;
- content type;
- content length;
- transfer size;
- response time;
- redirect location;
- cookies;
- TLS information where available;
- request timestamp.

---

# 13. Response Code Classification

## 2xx

```text
200 OK
201 Created
204 No Content
```

## 3xx

```text
301
302
303
307
308
```

Detect:

- redirect target;
- redirect chain;
- redirect loop;
- temporary vs permanent;
- HTTP → HTTPS;
- redirect hop count.

## 4xx

```text
400
401
403
404
410
429
```

## 5xx

```text
500
502
503
504
```

---

# 14. Redirect Chain Analysis

For:

```text
A → B → C → D
```

store:

```text
chainLength = 3
finalUrl = D
```

Issues:

- redirect chain;
- redirect loop;
- excessive redirect hops;
- redirect to error;
- HTTP to HTTP;
- HTTP to HTTPS;
- HTTPS to HTTP;
- redirecting URL in sitemap;
- redirecting canonical;
- redirecting internal links.

---

# 15. HTML Extraction

For every HTML response, extract:

```text
<title>
<meta name="description">
<meta name="robots">
<meta name="viewport">
<meta name="keywords">
<link rel="canonical">
<link rel="alternate" hreflang>
<link rel="amphtml">
<link rel="prev">
<link rel="next">
<h1>
<h2>
<img>
<a>
<iframe>
<form>
<script>
<link>
```

Also extract:

- body text;
- word count;
- HTML size;
- DOM size;
- text-to-code ratio;
- language;
- charset;
- author;
- Open Graph;
- Twitter Cards;
- structured data.

---

# 16. Page Title Audit

## Extraction

```css
title
```

## Data

Store:

```text
title
titleLengthCharacters
titlePixelWidth
titleCount
```

## Rules

### Missing

```text
title == null || title.trim() == ""
```

### Duplicate

Group:

```sql
GROUP BY normalized_title
HAVING COUNT(*) > 1
```

### Too long

Use pixel-width calculation rather than only character count.

### Too short

Configurable threshold.

### Multiple

```text
count(<title>) > 1
```

---

# 17. Meta Description Audit

## Extraction

```css
meta[name="description"]
```

Store:

- content;
- character length;
- pixel width;
- count.

Rules:

```text
Missing
Duplicate
Too short
Too long
Multiple
Empty
```

---

# 18. Meta Robots

Extraction:

```css
meta[name="robots"]
meta[name="googlebot"]
```

Parse:

```text
index
noindex
follow
nofollow
noarchive
nosnippet
noimageindex
max-snippet
max-image-preview
max-video-preview
```

Store each directive independently.

---

# 19. X-Robots-Tag

Read:

```text
X-Robots-Tag
```

Merge HTTP and HTML directives.

Important:

```text
HTTP noindex
+
HTML index
=
Non-indexable
```

---

# 20. Canonical Audit

Extraction:

```css
link[rel="canonical"]
```

Store:

```text
canonicalUrl
canonicalCount
canonicalStatus
canonicalTargetStatus
canonicalTargetIndexability
```

Rules:

- missing;
- multiple;
- non-indexable canonical;
- canonical to 4xx;
- canonical to 5xx;
- canonical chain;
- canonical to redirected URL;
- canonical to different hostname;
- canonical to HTTP;
- canonical mismatch;
- canonical not self-referencing;
- canonical target not crawlable.

---

# 21. H1 Audit

Extraction:

```css
h1
```

Store:

- H1 count;
- H1 text;
- H1 length;
- duplicate H1;
- missing H1.

Rules:

```text
0 H1 → warning
1 H1 → healthy
>1 H1 → configurable warning
```

Do not treat multiple H1 elements as universally invalid. Classify as a review opportunity unless the project's rule profile explicitly marks it as an issue.

---

# 22. H2 Audit

Extract:

```css
h2
```

Store:

- count;
- text;
- sequence;
- length;
- hierarchy.

Detect:

- missing H2 where content architecture suggests one;
- duplicate H2;
- skipped heading hierarchy.

---

# 23. Heading Hierarchy

Build:

```text
H1
 ├── H2
 │    ├── H3
 │    └── H3
 └── H2
```

Detect:

```text
H1 → H3
H2 → H4
```

Classify as accessibility/content-structure warning rather than automatically as an SEO penalty.

---

# 24. Word Count

Extract visible body text.

Exclude:

- script;
- style;
- navigation where configurable;
- hidden content;
- SVG metadata;
- comments.

Store:

```text
wordCount
uniqueWordCount
sentenceCount
paragraphCount
```

Rules:

- low content;
- empty page;
- extremely low text-to-code ratio;
- duplicate content.

Thresholds must be configurable by site/project.

---

# 25. Duplicate Content

## Exact duplicates

Generate:

```text
hash(normalizedVisibleText)
```

Group by hash.

## HTML duplicates

Generate:

```text
hash(normalizedHTML)
```

## Near duplicates

Use:

- SimHash;
- MinHash;
- shingling;
- configurable similarity threshold.

Example:

```text
similarity >= 0.90 → near duplicate
```

Do not use a single threshold for every language/site type.

---

# 26. URL Structure

Store:

```text
protocol
hostname
port
path
directoryDepth
filename
extension
queryString
fragment
parameterCount
urlLength
```

Rules:

- very long URL;
- excessive parameters;
- uppercase path;
- spaces;
- encoded characters;
- unsafe characters;
- multiple consecutive slashes;
- session IDs;
- tracking parameters;
- unnecessary query parameters.

---

# 27. Internal Links

For every `<a href>`:

Store:

```text
sourceUrl
targetUrl
anchorText
rel
nofollow
ugc
sponsored
position
context
```

Aggregate:

```text
inlinks
outlinks
uniqueInlinks
uniqueOutlinks
followedInlinks
nofollowInlinks
```

---

# 28. External Links

Classify:

```text
Internal
External
Subdomain
Cross-domain
```

Store:

```text
targetDomain
anchorText
rel
status
followability
```

Detect:

- broken external links;
- external redirects;
- external 4xx;
- external 5xx;
- excessive external links.

---

# 29. Orphan Pages

An orphan page is a URL discovered from a source but having zero crawlable internal inlinks.

Sources:

```text
XML Sitemap
Google Analytics
Google Search Console
Uploaded URL list
Known historical crawl
```

Logic:

```text
discoveredUrl = true
AND
internalInlinks = 0
```

Do not mark the homepage as orphaned merely because it has no incoming internal link.

---

# 30. Crawl Depth

Depth:

```text
Seed = 0
Links from seed = 1
Links from depth 1 = 2
...
```

Use breadth-first crawling for deterministic depth.

Store:

```text
minCrawlDepth
firstDiscoveredAtDepth
shortestPathSource
```

If multiple paths exist, retain minimum depth.

---

# 31. Site Structure

Aggregate by:

- hostname;
- directory;
- path;
- crawl depth;
- indexability;
- status code.

Example:

```text
/
├── articles/
│   ├── family-law/
│   ├── criminal-law/
│   └── corporate-law/
├── services/
└── contact/
```

UI should support:

- tree;
- table;
- chart;
- indexability view;
- status-code view;
- segment view.

---

# 32. Images

Extract:

```css
img
```

Store:

- src;
- absolute URL;
- alt;
- width;
- height;
- natural dimensions where rendered;
- file size;
- content type;
- status;
- lazy-loading;
- srcset;
- sizes;
- image format.

Rules:

- missing alt;
- empty alt;
- overly long alt;
- broken image;
- oversized image;
- image dimensions missing;
- image not lazy-loaded where appropriate;
- modern format opportunity;
- image response errors.

---

# 33. Image Links

For each image:

```text
sourcePage
imageUrl
status
alt
anchorContext
```

Detect:

```text
4xx image
5xx image
redirecting image
```

---

# 34. JavaScript Rendering

Provide modes:

```text
Raw HTML
Rendered HTML
```

Use headless Chromium for rendering.

Store:

```text
rawHtml
renderedHtml
renderedText
renderedLinks
consoleErrors
networkErrors
screenshot
renderTime
```

Compare:

```text
rawLinks vs renderedLinks
rawText vs renderedText
```

Detect:

- content only available after JS;
- links only available after JS;
- render timeout;
- browser error;
- blocked resource;
- JS exception.

---

# 35. JavaScript Execution Policy

Use isolated browser contexts.

Per-page limits:

```text
maximum render time
maximum resource count
maximum response size
maximum JS execution time
maximum redirects
```

Terminate runaway pages safely.

---

# 36. Meta Refresh

Extract:

```html
<meta http-equiv="refresh">
```

Store:

```text
refreshDelay
refreshTarget
```

Detect:

- meta refresh;
- meta refresh to redirect;
- delayed redirect;
- meta refresh chain.

---

# 37. Iframes

Extract:

```css
iframe[src]
```

Store:

- iframe URL;
- response;
- external/internal;
- sandbox;
- loading;
- dimensions.

---

# 38. AMP

Extract:

```css
link[rel="amphtml"]
```

Store:

```text
ampUrl
ampStatus
ampCanonical
ampValidity
```

---

# 39. Mobile Alternate

Extract:

```css
link[rel="alternate"][media]
```

Validate:

- mobile alternate;
- target status;
- redirect;
- canonical relationship.

---

# 40. Hreflang

Extract:

```css
link[rel="alternate"][hreflang]
```

Store:

```text
language
region
targetUrl
```

Validate:

1. valid language code;
2. valid region;
3. target URL returns successful response;
4. target is indexable;
5. reciprocal return link;
6. self-reference;
7. duplicate language;
8. conflicting language;
9. x-default;
10. inconsistent clusters.

Cluster model:

```text
Cluster A
├── en-us
├── en-gb
├── fr-fr
└── x-default
```

---

# 41. XML Sitemap Discovery

Sources:

```text
robots.txt
/sitemap.xml
/sitemap_index.xml
configured sitemap URLs
Google Search Console
```

Support:

- sitemap index;
- nested sitemap;
- image sitemap;
- news sitemap;
- video sitemap;
- hreflang sitemap.

---

# 42. XML Sitemap Reconciliation

For every sitemap URL:

```text
inSitemap
```

Compare against crawl database.

Detect:

- sitemap URL not crawled;
- sitemap URL 4xx;
- sitemap URL 5xx;
- sitemap URL redirected;
- sitemap URL non-indexable;
- sitemap URL canonicalized;
- sitemap URL blocked;
- orphan sitemap URL;
- URL missing from sitemap;
- sitemap canonical mismatch.

---

# 43. Structured Data

Extract:

```text
JSON-LD
Microdata
RDFa
```

Store:

```text
schemaType
properties
rawMarkup
source
validationErrors
```

Validate:

- Schema.org vocabulary;
- required properties where known;
- invalid property;
- unknown type;
- invalid type/property relation;
- malformed JSON-LD;
- duplicate schema blocks.

Optional Google Rich Result validation should be treated separately from Schema.org validity.

---

# 44. Open Graph

Extract:

```text
og:title
og:description
og:image
og:url
og:type
og:site_name
```

Detect:

- missing OG title;
- missing OG description;
- missing OG image;
- invalid OG URL;
- mismatch with canonical.

---

# 45. Twitter/X Cards

Extract:

```text
twitter:card
twitter:title
twitter:description
twitter:image
```

Detect missing/inconsistent metadata.

---

# 46. Links and Anchor Text

For every internal link store:

```text
anchorText
anchorLength
source
target
rel
position
```

Detect:

- empty anchors;
- image-only links without alt;
- generic anchor text;
- excessive repeated anchor text;
- nofollow internal links;
- orphan targets.

---

# 47. Link Equity / Internal Link Score

Riviso should calculate a proprietary internal link metric.

Example:

```text
Link Score =
weighted_inlinks
× link_quality
× followability
× source_authority
÷ crawl_depth_factor
```

Do not expose this as Google's ranking score.

Label clearly:

```text
Riviso Internal Link Score
```

---

# 48. Broken Links

A broken link is:

```text
target status >= 400
```

Classify:

```text
Internal Broken Link
External Broken Link
Image Broken Link
Resource Broken Link
```

Store source pages so users can fix the link, not only the broken destination.

---

# 49. Response Time

Store:

```text
dnsTime
connectionTime
tlsTime
ttfb
downloadTime
totalResponseTime
```

Where infrastructure permits.

Display:

```text
0–1s
1–2s
2–3s
3–5s
5s+
```

Do not infer Core Web Vitals from server response time.

---

# 50. Content Type

Classify:

```text
HTML
JavaScript
CSS
Image
Font
PDF
XML
JSON
Video
Audio
Other
```

---

# 51. Content Encoding

Store:

```text
gzip
br
deflate
identity
```

Detect missing compression where applicable.

---

# 52. HTTP Headers

Store complete headers.

Important SEO/security headers:

```text
Cache-Control
Content-Type
Content-Length
Content-Encoding
Location
ETag
Last-Modified
X-Robots-Tag
Strict-Transport-Security
Content-Security-Policy
X-Content-Type-Options
X-Frame-Options
Referrer-Policy
Permissions-Policy
```

---

# 53. Security Signals

SEO Audit may surface technical security observations, but must not present itself as a penetration test.

Detect:

- HTTP pages;
- mixed content;
- insecure canonical;
- insecure internal links;
- missing security headers;
- exposed server headers;
- TLS certificate problems where observable.

Security findings should be clearly labeled as:

```text
Technical Observation
```

---

# 54. Pagination

Extract:

```text
rel=next
rel=prev
```

Also detect:

- paginated URLs;
- canonicalized pagination;
- noindex pagination;
- broken pagination chains;
- pagination orphaning.

Do not assume rel=next/prev is a current Google ranking requirement. Store and report the implementation.

---

# 55. URL Parameters

Detect parameters such as:

```text
utm_*
gclid
fbclid
session
sort
filter
page
search
```

Allow users to configure ignored parameters.

Important:

```text
tracking parameter
functional parameter
unknown parameter
```

---

# 56. Faceted Navigation

Detect URL families such as:

```text
/category?color=red
/category?size=large
/category?sort=price
```

Aggregate:

```text
parameter combinations
crawl volume
indexability
canonicalization
duplicate similarity
```

---

# 57. Internationalisation

Detect:

- hreflang;
- language attribute;
- country variants;
- duplicate locale pages;
- incorrect canonical cross-locale;
- missing reciprocal hreflang.

---

# 58. Accessibility Signals

The SEO Audit may include accessibility observations.

Use an automated rule engine such as axe-compatible checks where rendered pages are available.

Detect examples:

- missing accessible names;
- poor contrast;
- invalid ARIA attributes;
- heading hierarchy problems;
- list structure errors;
- image alt issues;
- link naming issues.

These must be shown under:

```text
Accessibility
```

rather than incorrectly presented as direct Google ranking factors.

---

# 59. Spelling and Grammar

Optional crawler analysis.

Extract visible text and detect:

- spelling errors;
- grammar anomalies;
- repeated typos;
- suspicious capitalization.

Do not run expensive language analysis on every URL synchronously.

Use a background analysis queue.

---

# 60. Custom Search

Provide:

```text
Search Mode:
Contains
Does Not Contain
Regex

Scope:
Raw HTML
Rendered HTML
Visible Text
Element
XPath
CSS Selector
```

Example:

```text
Search:
Google Tag Manager

Condition:
Contains

Scope:
HTML
```

Store:

```text
matched
matchCount
matchedText
```

---

# 61. Custom Extraction

Allow:

```text
CSS Selector
XPath
Regex
```

Extraction modes:

```text
Text
HTML
Attribute
Count
```

Example:

```text
CSS:
.article-author

Extract:
Text
```

Store result as a custom column.

Security requirement:

Do not execute arbitrary user-supplied server-side code.

---

# 62. Custom JavaScript

Optional advanced feature.

Allow isolated browser-side snippets to extract data.

Security:

- sandbox execution;
- execution timeout;
- CPU limit;
- memory limit;
- network restrictions;
- no access to Riviso secrets;
- no access to other tenants;
- audit logs.

---

# 63. Google Analytics Integration

Optional.

Retrieve:

- users;
- sessions;
- engagement;
- key events;
- ecommerce;
- revenue;
- landing-page performance.

Map by normalized URL.

Use this to identify:

```text
High traffic + SEO issue
Low traffic + indexable page
High conversion + technical issue
```

---

# 64. Google Search Console Integration

Optional.

Retrieve:

```text
Clicks
Impressions
CTR
Position
```

Optional URL Inspection:

```text
URL is on Google
URL is not on Google
Indexing state
Coverage information
```

Store API quota usage.

Never confuse Search Console's data with crawler observations.

---

# 65. PageSpeed Integration

Technical Audit remains the dedicated performance module.

SEO Audit may display:

```text
Performance summary
```

but should not duplicate the full PageSpeed report.

Cross-link:

```text
View Technical Audit →
```

---

# 66. Issue Engine

Every rule must have a stable ID.

Example:

```text
SEO-TITLE-001
SEO-TITLE-002
SEO-META-001
SEO-CANONICAL-001
SEO-H1-001
SEO-LINK-001
SEO-IMAGE-001
SEO-ROBOTS-001
```

Each rule must define:

```json
{
  "id": "SEO-META-001",
  "name": "Missing Meta Description",
  "severity": "warning",
  "category": "on_page",
  "detector": "meta_description_missing",
  "evidence": "...",
  "recommendation": "...",
  "enabled": true
}
```

---

# 67. Severity Model

Use:

```text
Error
Warning
Opportunity
Notice
```

### Error

Likely technical/indexation problem.

### Warning

Potential problem requiring review.

### Opportunity

Optimization opportunity.

### Notice

Informational observation.

---

# 68. Priority Model

Priority is independent from severity.

Use:

```text
Impact
×
Affected URLs
×
Indexability
×
Business importance
×
Confidence
```

Return:

```text
High
Medium
Low
```

Never claim priority is a Google ranking rule.

---

# 69. Issue Examples

Minimum initial rules:

### Crawlability

- robots blocked URL
- crawl error
- timeout
- redirect loop
- excessive redirects
- inaccessible resource

### Indexability

- noindex
- X-Robots noindex
- canonicalized URL
- non-indexable canonical
- blocked URL
- conflicting directives

### Titles

- missing
- duplicate
- too long
- too short
- multiple
- empty

### Meta

- missing
- duplicate
- too long
- too short
- multiple
- empty

### Headings

- missing H1
- multiple H1
- duplicate H1
- empty H1
- heading hierarchy issue

### Links

- broken internal
- broken external
- orphan page
- empty anchor
- nofollow internal link
- redirecting internal link
- excessive links

### Canonicals

- missing
- multiple
- canonical to redirect
- canonical to 4xx
- canonical to 5xx
- canonical non-indexable
- canonical mismatch

### Images

- missing alt
- empty alt
- oversized image
- broken image
- missing dimensions
- non-modern format opportunity

### Content

- low content
- duplicate content
- near duplicate
- thin page
- low text-to-code ratio

### Sitemap

- URL not in sitemap
- sitemap URL non-indexable
- sitemap URL redirects
- sitemap URL 4xx
- sitemap URL 5xx

### Hreflang

- missing return tag
- invalid language
- invalid target
- non-indexable target
- duplicate locale
- missing self-reference

### Structured Data

- invalid JSON
- invalid Schema type
- invalid property
- missing recommended properties
- unsupported markup

---

# 70. SEO Health Score

The score must be derived from actual crawl data.

Recommended model:

```text
SEO Health Score =
30% Crawlability
25% Indexability
20% On-Page
15% Internal Linking
10% Technical Quality
```

Each category receives 0–100.

Example:

```text
Crawlability       100
Indexability        96
On-Page             94
Internal Linking    91
Technical Quality   97
-------------------------
Overall             96
```

The exact formula must be versioned.

Store:

```text
scoreVersion
calculatedAt
categoryScores
issuePenalties
```

---

# 71. Score Transparency

Clicking the score must open:

```text
Why is my score 99?
```

Show:

```text
Base score                  100
Missing meta descriptions    -1
Broken internal links        -0
Indexability issues          -0
Canonical issues             -0
Final                       99
```

Never display a score without explaining its inputs.

---

# 72. Current Summary UI

The approved visual structure should be:

```text
SEO Audit
sheokandlegal.com

┌───────────────────────────────────────────────────────────────┐
│ 99/100       Crawlability   Indexability   On-Page   Linking │
│ SEO Health      100             100          97        100   │
└───────────────────────────────────────────────────────────────┘

Audit History

Issues

URL Explorer
```

---

# 73. Summary Metric Cards

Required:

1. SEO Health Score
2. Crawlability
3. Indexability
4. On-Page
5. Internal Linking

Optional second-row:

6. Crawled URLs
7. Indexable URLs
8. Non-indexable URLs
9. Errors
10. Warnings
11. Opportunities
12. Redirects
13. Broken Links
14. Orphan URLs

---

# 74. Audit History

Each row:

```text
● Aug 12, 2026 · 03:54 PM     Score 99     URLs 500     >
● Aug 12, 2026 · 01:45 PM     Score 99     URLs 500     >
● Aug 12, 2026 · 02:04 AM     Score 75     URLs 1       >
```

Click opens historical audit.

Actions:

```text
View
Compare
Export
Delete
```

---

# 75. Issues UI

Use expandable rows.

Collapsed:

```text
Meta Description                 Warning      25 URLs   >
```

Expanded:

```text
Meta Description                 Warning      25 URLs   ˅

https://example.com/
https://example.com/service/
https://example.com/contact/

Write a distinct description for each page.

[View all affected URLs]
```

Do not render hundreds of URLs at once.

Use virtualized lists/pagination.

---

# 76. Issues Filters

Provide:

```text
All
Errors
Warnings
Opportunities
Notices
```

Additional filters:

```text
Category
Severity
Priority
URL segment
Directory
Indexability
Status code
```

Search:

```text
Search issues...
```

---

# 77. URL Explorer

This is one of the most important screens.

UI:

```text
URL Explorer

[Search URL or title...........................]

[All] [Indexable] [Non-indexable] [Blocked] [Errors]

https://sheokandlegal.com/
Best Law Firm in Chandigarh
2271 words · depth 0 · indexable                    200

https://sheokandlegal.com/articles/
Articles Archive
636 words · depth 1 · indexable                     200
```

---

# 78. URL Explorer Data

Each URL row must support:

```text
URL
Title
Meta Description
H1
Status Code
Indexability
Indexability Reason
Canonical
Word Count
Crawl Depth
Inlinks
Outlinks
Response Time
Page Size
Content Type
```

---

# 79. URL Detail Drawer

Clicking a URL opens a right-side drawer.

```text
URL
https://example.com/page/

[Overview] [SEO] [Links] [Headers] [Content] [Rendered] [Issues]

Status
200 OK

Indexability
Indexable

Canonical
Self-referencing

Title
...

Meta Description
...

H1
...

Word Count
1,242

Crawl Depth
2

Inlinks
27

Outlinks
18
```

---

# 80. URL Detail — SEO Tab

Show:

```text
Title
Meta Description
H1
H2
Canonical
Robots
X-Robots
Hreflang
Structured Data
Open Graph
Twitter Cards
```

Each property should show:

```text
Value
Status
Evidence
```

Example:

```text
Meta Description

"Best law firm in Chandigarh..."

✓ Present
152 characters
```

---

# 81. URL Detail — Links Tab

Show:

```text
27 Internal Inlinks
18 Internal Outlinks
7 External Outlinks
```

Tables:

```text
Source URL
Anchor
Target
Followability
Status
```

---

# 82. URL Detail — Headers Tab

Show request/response headers in a developer-friendly table.

```text
Header                  Value
Content-Type             text/html
Cache-Control            ...
X-Robots-Tag             ...
ETag                     ...
Last-Modified            ...
```

---

# 83. URL Detail — Content Tab

Show:

```text
Word count
Text-to-code ratio
Language
Reading level
Duplicate hash
Near-duplicate similarity
```

Optional:

```text
Top repeated phrases
N-grams
```

---

# 84. URL Detail — Rendered Tab

Provide:

```text
Raw HTML
Rendered HTML
Rendered screenshot
Console errors
Network errors
```

Use tabs rather than showing all three simultaneously.

---

# 85. Site Structure UI

The site structure screen should resemble a modern version of a crawler tree.

```text
Site Structure

https://
└── sheokandlegal.com
    ├── articles/             168
    ├── services/              42
    ├── category/              20
    ├── bare-acts/             16
    ├── judgements/            13
    └── wp-content/            94
```

Right side:

```text
Indexable
Non-indexable
Errors
```

Provide:

```text
Tree
Table
Chart
```

---

# 86. Crawl Depth Visualization

Chart:

```text
Depth       URLs

0           ███████
1           ███████████
2           █████████████████
3           ███████████████████████
4           ████████
5           ██
```

Break down by:

```text
2xx
3xx
4xx
5xx
blocked
```

---

# 87. Response Time Visualization

Use buckets:

```text
0–1s     334
1–2s      26
2–3s       3
3–4s       0
...
```

Show:

```text
Average
Median
P75
P90
P95
P99
```

---

# 88. Crawl Statistics

Required:

```text
Total URLs
HTML
JavaScript
CSS
Images
Fonts
PDF
Other
```

Also:

```text
Total requests
Failed requests
Average response
Median response
Pages/sec
Bytes transferred
```

---

# 89. Segments

Users should create segments such as:

```text
Blog
Services
Product
Category
Legal Pages
High Traffic
Noindex
```

Segment rules:

```text
URL contains /articles/
Status = 200
Indexability = indexable
```

Display segment counts across every major report.

---

# 90. Crawl Settings

Settings should be accessible through:

```text
View Crawl Settings
```

Sections:

```text
General
Scope
Robots
User Agent
JavaScript
Limits
Sitemaps
Rendering
Links
Images
Canonicals
Hreflang
AMP
Analytics
Search Console
Custom Search
Custom Extraction
```

---

# 91. Crawl Limits for Riviso

Unlike the free Screaming Frog edition, paid Riviso must not impose an artificial 500-URL crawl ceiling.

Plans should instead use quota based on:

```text
crawl credits
monthly URLs
concurrent crawls
rendered pages
API usage
storage
```

Example:

```text
Free Trial
500 URLs

Starter
10,000 URLs/month

Growth
100,000 URLs/month

Scale
1,000,000+ URLs/month
```

These values are product/pricing decisions and must be configurable.

---

# 92. Unlimited / Large Crawl Architecture

Do not crawl millions of URLs in one browser request.

Use:

```text
Crawler Coordinator
      ↓
Queue
      ↓
Worker Pool
      ↓
Fetch Workers
      ↓
Render Workers
      ↓
Extraction Workers
      ↓
Issue Workers
      ↓
Database
```

---

# 93. Crawl Queue

Recommended queue fields:

```text
id
crawl_id
url
normalized_url
priority
depth
status
discovered_from
attempt_count
next_attempt_at
locked_at
worker_id
```

Statuses:

```text
pending
processing
completed
failed
blocked
skipped
```

---

# 94. Priority Queue

Priority should consider:

```text
crawl depth
URL type
seed relationship
sitemap membership
historical importance
traffic
GSC clicks
business priority
```

But default discovery must remain breadth-first to preserve predictable crawl depth.

---

# 95. Retry Policy

Retry transient failures:

```text
408
425
429
500
502
503
504
network timeout
```

Do not blindly retry:

```text
400
401
403
404
410
```

Use exponential backoff:

```text
1s
2s
4s
8s
```

with jitter.

Respect:

```text
Retry-After
```

---

# 96. Politeness / Rate Limiting

Per hostname:

```text
requests per second
concurrency
delay
```

Support:

```text
Conservative
Balanced
Fast
Custom
```

Never allow aggressive defaults that can overload client servers.

---

# 97. SSRF Protection

This is mandatory.

Reject or protect access to:

```text
localhost
127.0.0.1
0.0.0.0
::1
private RFC1918 ranges
link-local
metadata endpoints
internal DNS
cloud instance metadata
```

Resolve DNS and validate the resulting IP before making requests.

Re-check after redirects.

---

# 98. Tenant Isolation

Every record must belong to:

```text
organization_id
project_id
crawl_id
```

No tenant may query another tenant's crawl.

---

# 99. Database Model

Recommended core tables:

```text
projects
audits
crawl_jobs
crawl_queue
urls
url_responses
url_content
url_seo
url_links
url_images
url_headers
url_canonicals
url_hreflang
url_structured_data
url_issues
issues
issue_rules
crawl_statistics
crawl_segments
crawl_segment_members
sitemaps
sitemap_urls
redirect_chains
crawl_events
audit_comparisons
```

---

# 100. URL Table

Example:

```sql
CREATE TABLE crawl_urls (
  id BIGSERIAL PRIMARY KEY,
  crawl_id UUID NOT NULL,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  hostname TEXT NOT NULL,
  path TEXT,
  depth INTEGER,
  discovery_source TEXT,
  discovered_from_url_id BIGINT,
  status TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

Unique constraint:

```sql
UNIQUE(crawl_id, normalized_url)
```

---

# 101. URL SEO Table

```sql
CREATE TABLE url_seo (
  url_id BIGINT PRIMARY KEY,
  title TEXT,
  title_length INTEGER,
  meta_description TEXT,
  meta_description_length INTEGER,
  h1_count INTEGER,
  h2_count INTEGER,
  word_count INTEGER,
  canonical_url TEXT,
  canonical_count INTEGER,
  robots TEXT,
  x_robots_tag TEXT,
  language TEXT,
  content_hash TEXT,
  html_hash TEXT,
  updated_at TIMESTAMP
);
```

---

# 102. Link Table

```sql
CREATE TABLE crawl_links (
  id BIGSERIAL PRIMARY KEY,
  crawl_id UUID NOT NULL,
  source_url_id BIGINT NOT NULL,
  target_url TEXT NOT NULL,
  normalized_target_url TEXT,
  link_type TEXT,
  anchor_text TEXT,
  rel TEXT,
  is_nofollow BOOLEAN,
  status_code INTEGER
);
```

Indexes:

```sql
CREATE INDEX idx_links_target
ON crawl_links(crawl_id, normalized_target_url);

CREATE INDEX idx_links_source
ON crawl_links(crawl_id, source_url_id);
```

---

# 103. Issue Query

Conceptual query for affected URLs:

```sql
SELECT
  u.id,
  u.url,
  i.rule_id,
  i.severity,
  i.priority,
  i.evidence
FROM url_issues i
JOIN crawl_urls u ON u.id = i.url_id
WHERE i.crawl_id = :crawl_id
  AND i.rule_id = :rule_id
ORDER BY i.priority DESC, u.url;
```

---

# 104. Missing Meta Description Query

Conceptual detector:

```sql
SELECT u.id
FROM crawl_urls u
JOIN url_seo s ON s.url_id = u.id
JOIN url_responses r ON r.url_id = u.id
WHERE u.crawl_id = :crawl_id
  AND r.status_code = 200
  AND r.content_type LIKE 'text/html%'
  AND s.meta_description IS NULL
  AND s.indexable = TRUE;
```

---

# 105. Duplicate Title Query

```sql
SELECT normalized_title, COUNT(*)
FROM url_seo
WHERE crawl_id = :crawl_id
GROUP BY normalized_title
HAVING COUNT(*) > 1;
```

Then retrieve URLs in each duplicate group.

---

# 106. Broken Internal Link Query

```sql
SELECT
  l.source_url_id,
  l.normalized_target_url,
  r.status_code
FROM crawl_links l
JOIN crawl_urls target
  ON target.normalized_url = l.normalized_target_url
JOIN url_responses r
  ON r.url_id = target.id
WHERE l.crawl_id = :crawl_id
  AND l.link_type = 'internal'
  AND r.status_code >= 400;
```

---

# 107. Orphan URL Query

```sql
SELECT u.id, u.url
FROM crawl_urls u
LEFT JOIN crawl_links l
  ON l.crawl_id = u.crawl_id
 AND l.normalized_target_url = u.normalized_url
WHERE u.crawl_id = :crawl_id
  AND u.discovered = TRUE
  AND l.id IS NULL;
```

Then exclude:

```text
seed URL
non-HTML resources where inappropriate
URLs intentionally excluded
```

---

# 108. Sitemap Query

```sql
SELECT u.url
FROM sitemap_urls u
LEFT JOIN crawl_urls c
  ON c.crawl_id = :crawl_id
 AND c.normalized_url = u.normalized_url
WHERE u.crawl_id = :crawl_id
  AND c.id IS NULL;
```

---

# 109. UI API Contract

## Start Audit

```http
POST /api/projects/:projectId/seo-audits
```

Body:

```json
{
  "startUrl": "https://example.com",
  "crawlMode": "spider",
  "respectRobots": true,
  "renderJavaScript": false,
  "crawlSitemaps": true
}
```

Response:

```json
{
  "auditId": "uuid",
  "status": "queued"
}
```

---

# 110. Audit Status

```http
GET /api/seo-audits/:auditId
```

Response:

```json
{
  "status": "running",
  "progress": 74,
  "discovered": 5234,
  "crawled": 4124,
  "queued": 1092,
  "errors": 42
}
```

---

# 111. Audit Summary

```http
GET /api/seo-audits/:auditId/summary
```

Return:

```json
{
  "score": 99,
  "crawlability": 100,
  "indexability": 100,
  "onPage": 97,
  "internalLinking": 100,
  "urls": 500,
  "errors": 0,
  "warnings": 5,
  "opportunities": 3
}
```

---

# 112. Issues API

```http
GET /api/seo-audits/:auditId/issues
```

Filters:

```text
severity
priority
category
rule
segment
search
page
limit
```

Example:

```text
/api/seo-audits/123/issues?
severity=warning&
category=on_page&
page=1&
limit=50
```

---

# 113. Affected URLs API

```http
GET /api/seo-audits/:auditId/issues/:ruleId/urls
```

Return paginated URLs.

Never return 50,000 affected URLs in one JSON response.

---

# 114. URL Explorer API

```http
GET /api/seo-audits/:auditId/urls
```

Parameters:

```text
search
status
indexability
contentType
depth
segment
issue
sort
page
limit
```

---

# 115. URL Detail API

```http
GET /api/seo-audits/:auditId/urls/:urlId
```

Return:

```text
overview
seo
headers
links
images
content
issues
rendering
```

---

# 116. Site Structure API

```http
GET /api/seo-audits/:auditId/site-structure
```

Return hierarchical nodes.

---

# 117. Crawl History API

```http
GET /api/projects/:projectId/seo-audits/history
```

Support:

```text
latest
previous
date range
score trend
issue trend
URL growth
```

---

# 118. Audit Comparison

Compare:

```text
Audit A
vs
Audit B
```

Show:

```text
Score
+4

Errors
-12

Warnings
+7

Indexable URLs
+214

Broken Links
-34
```

Issue-level comparison:

```text
Missing Meta Description
Before: 41
After: 25
Change: -16
```

---

# 119. Export

Support:

```text
CSV
XLSX
PDF
JSON
```

Reports:

```text
All URLs
All Issues
Issue URLs
Redirect Chains
Internal Links
External Links
Images
Canonicals
Hreflang
Sitemaps
Structured Data
Response Times
Site Structure
```

For large exports, use background jobs.

---

# 120. Virtualized Data Tables

Any table exceeding ~100 visible rows must use virtualization.

Do not render:

```text
500
5,000
50,000
```

DOM rows simultaneously.

---

# 121. Pagination

API:

```text
cursor-based pagination
```

Prefer:

```text
nextCursor
```

for very large datasets.

Offset pagination can be used for small result sets.

---

# 122. Search

Global URL search should support:

```text
URL
title
H1
meta description
issue
status
canonical
anchor text
```

Use debounced server-side search.

---

# 123. UI State Rules

Loading:

```text
Skeleton
```

Empty:

```text
No issues detected
```

Partial:

```text
Crawl still running
Some metrics are provisional
```

Error:

```text
Unable to load audit data
[Retry]
```

---

# 124. Do Not Show False Zeroes

If data is unavailable:

Bad:

```text
Hreflang: 0
```

Good:

```text
Hreflang: Not analyzed
```

This distinction is critical.

---

# 125. Audit Completeness Indicator

Show:

```text
Audit Coverage

98.7%
```

Breakdown:

```text
URLs discovered      5,287
URLs crawled         5,234
URLs blocked            16
URLs failed             37
```

---

# 126. Current Screenshot Improvements

The current screenshots show:

- a strong summary area;
- audit history;
- issues;
- URL Explorer.

Keep those.

Improve by adding:

1. a compact crawl coverage indicator;
2. issue severity counters;
3. issue category filters;
4. expandable issue rows;
5. URL Explorer sorting;
6. URL detail drawer;
7. site structure;
8. internal/external link analytics;
9. sitemap reconciliation;
10. crawl statistics;
11. audit comparison;
12. export;
13. crawl configuration;
14. progress state;
15. data freshness labels.

---

# 127. Recommended Final Page

```text
┌───────────────────────────────────────────────────────────────┐
│ SEO Audit                          [Completed]                │
│ sheokandlegal.com                                             │
│ Crawled 5,234 URLs · Aug 12 · 03:54 PM                       │
│                                                               │
│                         [Schedule] [Compare] [Export] [Re-run]│
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  99/100       100        100         97         100           │
│  SEO Health   Crawl      Index       On-Page    Linking       │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│ Audit History                                                 │
│                                                               │
│ ● Aug 12 · 03:54 PM                 Score 99   URLs 500  >   │
│ ● Aug 12 · 01:45 PM                 Score 99   URLs 500  >   │
├───────────────────────────────────────────────────────────────┤
│ Issues                                                        │
│                                                               │
│ [All] [Errors] [Warnings] [Opportunities]                     │
│                                                               │
│ Meta Description                Warning       25 URLs       > │
│ Page Titles                     Warning        7 URLs       > │
│ Links                           Warning        1 URL        > │
│ H1                              Warning       13 URLs       > │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│ URL Explorer                                                  │
│                                                               │
│ [Search URL or title.........................]                │
│ [All] [Indexable] [Non-indexable] [Blocked]                   │
│                                                               │
│ URL                            Status  Depth  Words  Index     │
│ /                              200      0     2271   ✓         │
│ /articles/                     200      1      636   ✓         │
│ /articles/example/             200      2     1212   ✓         │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

---

# 128. Secondary Navigation

Do not put every Screaming Frog tab in the main sidebar.

Use a horizontal secondary navigation inside SEO Audit:

```text
Overview
Issues
URL Explorer
Site Structure
Links
Content
Indexability
Sitemaps
Hreflang
Images
Structured Data
Response Times
Segments
Reports
```

On smaller screens:

```text
Overview
Issues
URL Explorer
More ▼
```

---

# 129. Progressive Disclosure

The primary page should answer:

```text
What is wrong?
How serious is it?
How many URLs are affected?
Which URLs?
What should I do?
```

Only after that expose:

```text
headers
HTML
rendered DOM
crawl paths
raw links
technical metadata
```

---

# 130. Issue Detail Drawer

Example:

```text
Missing Meta Description

25 URLs affected
Priority: High

Why this matters
Pages without unique descriptions may have weaker search snippets.

Detected:
25 indexable pages
0 non-indexable pages

Affected URLs
─────────────────────────────
/articles/example/
/services/family-law/
/contact/

Recommendation
Write a unique, relevant description for each indexable page.

[Open URL Explorer]
[Export URLs]
```

---

# 131. Rule Evidence

Every issue must include evidence.

Example:

```text
Detected value:
NULL

Expected:
A non-empty meta description

URL:
https://example.com/

Status:
200

Indexable:
Yes
```

---

# 132. Crawl Analysis Phase

After crawling, run a separate analysis pipeline.

```text
Raw Crawl
    ↓
URL Classification
    ↓
Link Graph
    ↓
Duplicate Analysis
    ↓
Canonical Analysis
    ↓
Sitemap Reconciliation
    ↓
Hreflang Clustering
    ↓
Orphan Analysis
    ↓
Issue Rules
    ↓
Score
```

This allows expensive graph-based calculations to happen after URL discovery.

---

# 133. Crawl Graph

Store a directed graph:

```text
source URL → target URL
```

Use it for:

- inlinks;
- outlinks;
- orphan detection;
- crawl depth;
- internal link score;
- redirect chains;
- site structure;
- hub pages;
- dead-end pages.

---

# 134. Dead-End Pages

Detect indexable pages with:

```text
0 internal outlinks
```

Classify as:

```text
Potential dead-end page
```

Do not automatically mark as an error.

---

# 135. Deep Pages

Configurable threshold:

```text
depth >= 4
```

Detect:

```text
Deep page
```

Show:

```text
Page depth: 6
Shortest path:
Home → Category → Subcategory → Article...
```

---

# 136. Internal Link Opportunities

Identify:

```text
high-authority page
      ↓
related low-linked page
```

Possible future feature:

```text
AI Internal Link Suggestions
```

Keep AI recommendations separate from deterministic crawl findings.

---

# 137. AI Summary

After deterministic analysis, generate:

```text
SEO Audit Summary
```

Example:

```text
Your site is technically healthy overall, but 25 indexable pages
are missing meta descriptions and 13 pages have H1 issues.

The highest-impact action is to resolve the missing metadata on
high-traffic pages first.
```

AI must only summarize stored findings.

It must never invent crawl data.

---

# 138. AI Evidence Contract

AI input should contain structured facts:

```json
{
  "crawl": {...},
  "issues": [...],
  "topPages": [...],
  "score": 99
}
```

The AI output should reference rule IDs.

Example:

```text
SEO-META-001
```

This makes summaries auditable.

---

# 139. Performance Requirements

Dashboard:

```text
initial summary < 1.5s
```

Issue list:

```text
< 1s for paginated results
```

URL search:

```text
< 500ms target
```

Large crawl:

```text
asynchronous
```

Never make the user wait for the entire crawl in an HTTP request.

---

# 140. Crawl Job Lifecycle

```text
CREATED
↓
QUEUED
↓
STARTING
↓
CRAWLING
↓
ANALYZING
↓
SCORING
↓
COMPLETED
```

Failure states:

```text
FAILED
CANCELLED
PAUSED
```

---

# 141. Resume Support

A crawl must be resumable.

Persist:

```text
queue
visited URLs
crawl configuration
workers
last checkpoint
statistics
```

On resume:

```text
continue from last durable checkpoint
```

Do not restart from zero.

---

# 142. Crash Recovery

If a worker dies:

```text
processing → timeout → pending
```

Another worker can claim it.

Use lease locks:

```text
locked_at
worker_id
lock_timeout
```

---

# 143. Crawl Event Log

Store events:

```text
crawl_started
url_discovered
url_crawled
url_failed
url_blocked
render_started
render_failed
analysis_started
analysis_completed
crawl_completed
```

Useful for:

- debugging;
- progress UI;
- audit trail;
- support.

---

# 144. Observability

Track:

```text
queue depth
URLs/sec
requests/sec
error rate
render latency
DB latency
worker utilization
memory
CPU
```

Set alerts for:

```text
queue stalled
high 5xx rate
worker failure
render failure spike
DB failure
```

---

# 145. Crawler Safety

Implement:

- maximum response size;
- maximum HTML size;
- maximum URL length;
- maximum redirects;
- maximum sitemap size;
- decompression bomb protection;
- malformed HTML tolerance;
- timeout;
- rate limit;
- robots handling;
- SSRF protection.

---

# 146. Canonical URL vs Crawled URL

Never replace the crawled URL with its canonical.

Store both:

```text
Crawled URL:
https://example.com/a/

Canonical:
https://example.com/b/
```

The URL remains an independent crawl record.

---

# 147. Redirect URL vs Final URL

Store:

```text
requestedUrl
finalUrl
redirectChain
```

Do not overwrite the original request.

---

# 148. Indexability Engine

Determine:

```text
indexable
non-indexable
unknown
```

Priority:

1. HTTP status;
2. robots crawl permission;
3. meta robots;
4. X-Robots-Tag;
5. canonical;
6. content type;
7. configuration;
8. other directives.

Example:

```text
404 → non-indexable
noindex → non-indexable
canonicalized → non-indexable
200 HTML + index → indexable
robots blocked → unknown
```

---

# 149. Indexability Reason

Every non-indexable URL must have a reason.

Examples:

```text
NOINDEX_META
NOINDEX_X_ROBOTS
CANONICALIZED
REDIRECT
CLIENT_ERROR
SERVER_ERROR
ROBOTS_BLOCKED
NON_HTML
CONFIG_EXCLUDED
```

---

# 150. Data Quality

Every extracted field should have:

```text
value
source
confidence
extractedAt
```

Example:

```json
{
  "title": {
    "value": "Example Title",
    "source": "raw_html",
    "confidence": 1.0
  }
}
```

For rendered-only content:

```text
source = rendered_html
```

---

# 151. Raw vs Rendered Conflict

If:

```text
Raw title = A
Rendered title = B
```

store both.

Display:

```text
Raw:
A

Rendered:
B

⚠ Rendered title differs from source title
```

---

# 152. Crawl Scope UI

Before starting:

```text
Start URL
[https://example.com................]

Crawl
○ Website
○ Subdomain
○ List
○ Sitemap

Robots
☑ Respect robots.txt

Rendering
○ Raw HTML
○ JavaScript

Sitemaps
☑ Crawl linked sitemaps

[Advanced Settings]
```

---

# 153. Advanced Settings

Collapsible.

```text
User Agent
Rate Limit
Concurrency
Max URLs
Max Crawl Depth
URL Parameters
Include Rules
Exclude Rules
Headers
Cookies
Authentication
Rendering
API Integrations
```

---

# 154. Authentication

Enterprise feature.

Support:

```text
Basic Auth
Bearer token
Custom headers
Cookies
```

Credentials must be encrypted.

Never expose credentials in crawl logs.

---

# 155. Crawl Compare UI

```text
Compare Audits

Previous:
Aug 10 · Score 94

Current:
Aug 12 · Score 99

Improved
+5 score
-24 warnings
-12 broken links

Regressed
+7 duplicate titles
+3 redirects
```

---

# 156. Regression Detection

For every re-crawl compare:

```text
new issues
resolved issues
persistent issues
new URLs
removed URLs
changed URLs
```

Show:

```text
New
Resolved
Unchanged
Regressed
```

---

# 157. URL Change Detection

Compare:

```text
title
meta
H1
canonical
status
word count
content hash
links
schema
```

Highlight:

```text
Changed
```

---

# 158. Reports Dashboard

Cards:

```text
Technical SEO
On-Page
Indexability
Links
Content
Images
Sitemaps
International
Structured Data
```

Each opens a filtered report.

---

# 159. Empty State

If no issues:

```text
✓ No critical SEO issues detected

Your crawl completed successfully.

[Explore URL Data]
```

Do not imply the site is perfect.

Use:

```text
No issues detected by the configured audit rules.
```

---

# 160. Error State

If crawl fails:

```text
Audit could not be completed

Reason:
Connection timeout while crawling the website.

URLs crawled:
142

[Retry]
[View Crawl Log]
```

---

# 161. UI Responsiveness

Desktop-first.

Minimum:

```text
1280px
```

Support:

```text
1024px
768px
mobile
```

On mobile:

- collapse sidebar;
- use stacked score cards;
- convert wide tables into cards;
- keep URL search;
- use bottom sheets/drawers;
- avoid horizontal page overflow.

---

# 162. Accessibility

All UI controls must have:

- keyboard navigation;
- visible focus;
- semantic buttons;
- semantic headings;
- accessible labels;
- color-independent status indicators;
- screen-reader text for icons.

---

# 163. Design Tokens

Use Riviso tokens:

```css
--bg-primary
--bg-secondary
--bg-surface
--border-subtle
--text-primary
--text-secondary
--accent-primary
--success
--warning
--error
--info
```

Do not hard-code dozens of colors across components.

---

# 164. Component Architecture

Recommended:

```text
SEOAuditPage
├── AuditHeader
├── AuditSummary
│   ├── HealthScore
│   ├── CrawlabilityCard
│   ├── IndexabilityCard
│   ├── OnPageCard
│   └── InternalLinkingCard
├── AuditHistory
├── IssuesPanel
│   ├── IssueFilters
│   └── IssueRow
├── UrlExplorer
│   ├── UrlFilters
│   ├── UrlSearch
│   └── UrlRow
├── UrlDetailDrawer
├── SiteStructure
├── CrawlStatistics
└── ReportNavigation
```

---

# 165. Avoid the Current UI Problem

The current UI has a long vertical sequence of:

```text
Issues
Issues
Issues
URL Explorer
URL Explorer rows...
```

This becomes difficult for large audits.

Improve it with:

```text
Summary
↓
Issue dashboard
↓
Filterable issue explorer
↓
URL explorer
↓
Deep reports
```

Use progressive disclosure.

---

# 166. Do Not Copy Screaming Frog's Desktop Layout Literally

Screaming Frog is a desktop crawler application.

Riviso is a SaaS application.

Therefore:

### Borrow functionality

- crawl depth;
- URL tables;
- issue categories;
- redirects;
- canonical analysis;
- link graph;
- site structure;
- response times;
- sitemaps;
- hreflang;
- images;
- content;
- custom extraction.

### Do not copy

- dense legacy toolbar layout;
- tiny desktop-only controls;
- multi-pane legacy window layout;
- spreadsheet-like primary navigation.

Riviso should provide the same analytical depth with a modern SaaS UX.

---

# 167. Exact UI Principle

The user should be able to answer these questions within 10 seconds:

```text
1. Did the crawl complete?
2. How healthy is the site?
3. What are the biggest problems?
4. How many URLs are affected?
5. Which URLs are affected?
6. Why are they affected?
7. What should I fix?
```

---

# 168. Development Order

## Phase 1 — Crawler Foundation

- URL queue
- HTTP fetcher
- normalization
- robots
- redirects
- status codes
- HTML extraction
- links
- crawl depth
- database persistence

## Phase 2 — Core SEO

- title
- meta
- H1
- H2
- canonical
- robots
- X-Robots
- indexability
- images
- content
- duplicate detection

## Phase 3 — Graph Analysis

- inlinks
- outlinks
- orphan pages
- crawl depth
- internal link score
- redirect chains
- site structure

## Phase 4 — Advanced SEO

- XML sitemap
- hreflang
- AMP
- structured data
- pagination
- Open Graph
- Twitter Cards
- parameters

## Phase 5 — Rendering

- Chromium
- raw/rendered comparison
- screenshots
- console errors
- network errors

## Phase 6 — Integrations

- GSC
- GA4
- PageSpeed
- external SEO APIs

## Phase 7 — Enterprise

- large crawl
- distributed workers
- scheduled audits
- comparisons
- regression
- segments
- exports
- API

---

# 169. Testing Strategy

Every detector requires unit tests.

Example:

```text
Missing Title
Duplicate Title
Long Title
Short Title
Multiple Title
```

Each should have:

```text
HTML fixture
expected result
```

---

# 170. Crawler Integration Tests

Test:

```text
200
301
302
307
308
404
410
429
500
502
503
timeout
robots blocked
redirect loop
canonical
hreflang
sitemap
JS links
```

---

# 171. Large Crawl Tests

Test:

```text
1,000 URLs
10,000 URLs
100,000 URLs
1,000,000 URLs
```

Measure:

```text
URLs/sec
memory
CPU
DB write throughput
queue throughput
worker recovery
```

---

# 172. UI Acceptance Criteria

The implementation is complete only when:

- summary values are live;
- issue counts are live;
- issue rows expand;
- affected URLs are real;
- URL Explorer searches real crawl data;
- URL detail is real;
- audit history is real;
- re-run creates a new audit;
- crawl progress is live;
- pause works;
- resume works;
- cancel works;
- export works;
- comparisons work;
- filters work;
- pagination works;
- large result sets remain performant.

---

# 173. No Mock Data in Production

Mock data may be used only for:

```text
storybook
development
UI prototyping
automated visual tests
```

Production UI must never use placeholder audit numbers.

---

# 174. Source of Truth

The crawl database is the source of truth.

The React/Next.js dashboard is a consumer.

Architecture:

```text
Crawler
   ↓
Database
   ↓
Analysis Engine
   ↓
API
   ↓
UI
```

Never:

```text
UI → invent calculations
```

---

# 175. Final Product Outcome

Riviso SEO Audit should feel like:

```text
Screaming Frog's analytical depth
+
modern SaaS UX
+
Riviso's visual identity
+
cloud-scale crawling
+
AI-assisted interpretation
```

The user should not need to understand crawler internals to use the product.

The system should expose advanced controls progressively while keeping the first screen extremely clear.

---

# 176. Final Required Screens

Engineering must implement these screens:

1. SEO Audit Overview
2. Crawl Configuration
3. Crawl Progress
4. Audit History
5. Issue Explorer
6. Issue Detail
7. Affected URL Explorer
8. URL Detail Drawer
9. Site Structure
10. Crawl Depth
11. Internal Links
12. External Links
13. Redirect Chains
14. Canonicals
15. XML Sitemaps
16. Hreflang
17. Images
18. Content
19. Structured Data
20. Directives
21. Response Times
22. Segments
23. Raw HTML
24. Rendered HTML
25. Rendered Screenshot
26. Crawl Logs
27. Audit Comparison
28. Reports / Export

---

# 177. Final Engineering Rule

Do not implement this module as:

```text
fetch homepage
+
run a few regex checks
+
show score
```

Implement it as:

```text
A persistent, resumable, breadth-first web crawler
+
URL graph
+
HTTP analysis
+
HTML analysis
+
optional Chromium rendering
+
SEO rule engine
+
post-crawl graph analysis
+
historical comparison
+
large-scale asynchronous processing
+
modern SaaS dashboard
```

That distinction is fundamental.

---

# 178. Feature Parity Checklist

## Crawl

- [ ] Spider crawl
- [ ] List crawl
- [ ] Sitemap crawl
- [ ] URL import
- [ ] robots.txt
- [ ] user agent
- [ ] redirects
- [ ] redirect chains
- [ ] crawl depth
- [ ] response times
- [ ] rate limiting
- [ ] crawl limits
- [ ] pause/resume
- [ ] cancel
- [ ] retry
- [ ] crash recovery

## On-Page

- [ ] titles
- [ ] meta descriptions
- [ ] meta keywords
- [ ] H1
- [ ] H2
- [ ] word count
- [ ] readability
- [ ] text/code ratio
- [ ] page size
- [ ] forms
- [ ] Open Graph
- [ ] Twitter Cards

## Indexability

- [ ] robots meta
- [ ] X-Robots
- [ ] canonical
- [ ] indexability status
- [ ] indexability reason
- [ ] redirects
- [ ] noindex
- [ ] blocked

## Links

- [ ] internal links
- [ ] external links
- [ ] inlinks
- [ ] outlinks
- [ ] anchor text
- [ ] follow/nofollow
- [ ] UGC
- [ ] sponsored
- [ ] broken links
- [ ] orphan pages
- [ ] link score
- [ ] redirecting links

## Images

- [ ] alt
- [ ] image status
- [ ] image size
- [ ] dimensions
- [ ] srcset
- [ ] lazy loading
- [ ] format
- [ ] broken images

## International

- [ ] hreflang
- [ ] reciprocal validation
- [ ] x-default
- [ ] language
- [ ] locale clusters

## Technical

- [ ] status codes
- [ ] HTTP headers
- [ ] cookies
- [ ] content type
- [ ] compression
- [ ] security observations
- [ ] JavaScript
- [ ] rendering
- [ ] console errors
- [ ] network errors

## Architecture

- [ ] site structure
- [ ] crawl depth
- [ ] directory analysis
- [ ] segments
- [ ] link graph
- [ ] orphan detection
- [ ] dead-end detection

## XML

- [ ] sitemap discovery
- [ ] sitemap index
- [ ] sitemap URLs
- [ ] sitemap reconciliation
- [ ] image sitemap
- [ ] news sitemap
- [ ] video sitemap

## Structured Data

- [ ] JSON-LD
- [ ] Microdata
- [ ] RDFa
- [ ] Schema validation
- [ ] rich-result observations

## Content

- [ ] exact duplicate
- [ ] near duplicate
- [ ] thin content
- [ ] low word count
- [ ] spelling
- [ ] grammar
- [ ] n-grams

## Integrations

- [ ] Google Analytics
- [ ] Search Console
- [ ] URL Inspection
- [ ] PageSpeed
- [ ] external APIs

## Advanced

- [ ] custom search
- [ ] custom extraction
- [ ] custom JavaScript
- [ ] custom headers
- [ ] authentication
- [ ] include/exclude
- [ ] URL parameters

## SaaS

- [ ] scheduled crawls
- [ ] crawl history
- [ ] comparison
- [ ] regression
- [ ] exports
- [ ] API
- [ ] team access
- [ ] tenant isolation
- [ ] quota management

---

# 179. Reference Sources

The functional benchmark in this specification was cross-checked against Screaming Frog's current public documentation, including:

- SEO Spider User Guide
- SEO Spider Configuration
- SEO Spider Tabs
- SEO Spider Issues
- XML Sitemap documentation
- JavaScript rendering documentation
- Custom Search / Extraction documentation
- Google Analytics integration documentation
- Google Search Console integration documentation

Important: this specification intentionally describes Riviso's own implementation rather than claiming knowledge of Screaming Frog's proprietary source code or private algorithms.

---

# 180. Definition of Done

The SEO Audit module is considered production-ready only when a real crawl can be performed against an external website and the system can:

```text
discover URLs
→ crawl URLs
→ follow links
→ respect configured rules
→ store URL-level evidence
→ calculate SEO properties
→ build the link graph
→ analyze indexability
→ detect issues
→ aggregate site metrics
→ expose affected URLs
→ allow URL-level investigation
→ calculate a transparent score
→ preserve the audit
→ compare against another audit
→ export the results
```

The final UI must retain the visual language of the supplied Riviso screenshots while replacing the current limited audit implementation with a scalable, data-backed SEO crawler and analysis platform.