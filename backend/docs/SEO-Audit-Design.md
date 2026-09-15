# Riviso SEO Audit --- Full Crawl Engine & Screaming Frog Parity Specification

**Status:** Product + Engineering Specification\
**Module:** Riviso → SEO Audit\
**Objective:** Build a production-grade full-site technical SEO crawler
that discovers, crawls, renders, analyses, prioritises and explains
every relevant URL within the user's configured scope.

------------------------------------------------------------------------

## 1. Product Objective

Riviso SEO Audit must be a **real crawler**, not a PageSpeed report and
not a collection of API calls.

The engine must:

1.  Start from one or more seed URLs.
2.  Discover URLs recursively.
3.  Respect crawl scope and robots.txt by default.
4.  Normalize and deduplicate URLs.
5.  Fetch every in-scope URL.
6.  Record HTTP responses, headers, timings and resources.
7.  Parse HTML, links, metadata, directives, canonicals, hreflang,
    structured data, images, scripts and stylesheets.
8.  Optionally render JavaScript pages in Chromium.
9.  Discover additional URLs from rendered DOM.
10. Continue until the crawl frontier is exhausted.
11. Run post-crawl graph/content analysis.
12. Evaluate a versioned SEO rule registry.
13. Store URL-level facts and relationship-level facts.
14. Provide URL-level evidence for every finding.
15. Produce site-wide summaries, issue counts, priorities, structure and
    trends.
16. Preserve every crawl as an immutable audit snapshot.
17. Allow paid plans to crawl all URLs within their plan entitlement
    rather than imposing a 500-URL limit.

Screaming Frog currently documents 300+ SEO issues, warnings and
opportunities, with tabs spanning response codes, security, URLs,
metadata, headings, content, images, canonicals, pagination, directives,
hreflang, JavaScript, links, structured data, sitemaps, PageSpeed,
mobile, accessibility, Analytics, Search Console and validation. Riviso
should use that public capability set as the parity baseline.

------------------------------------------------------------------------

## 2. Important Limitation About "Exact Screaming Frog Method"

Screaming Frog is proprietary software. Its complete internal
implementation is not public.

Therefore Riviso must distinguish between:

### Publicly documented behaviour to reproduce

-   breadth-first crawling
-   crawl depth
-   robots.txt handling
-   URL discovery
-   internal/external classification
-   HTTP response analysis
-   JavaScript rendering
-   rendered-vs-raw HTML comparison
-   link graph analysis
-   Link Score-style analysis
-   canonical analysis
-   sitemap reconciliation
-   structured-data validation
-   PageSpeed/Lighthouse enrichment
-   Search Console enrichment
-   Analytics enrichment
-   duplicate/near-duplicate analysis
-   issue/warning/opportunity model
-   URL-level details
-   inlinks/outlinks
-   SERP preview
-   rendered page inspection
-   change detection

### Riviso implementation

Where the original algorithm is proprietary, implement a deterministic,
documented equivalent. Do not claim that Riviso uses Screaming Frog's
private internal algorithm.

------------------------------------------------------------------------

# 3. Product Architecture

``` text
                         RIVISO SEO AUDIT
                                |
              +-----------------+-----------------+
              |                                   |
         CRAWL ENGINE                         ENRICHMENT
              |                                   |
      +-------+-------+                +----------+----------+
      |       |       |                |          |          |
     HTTP    HTML   Browser           PSI        GSC        GA4
      |       |       |                |          |          |
      +-------+-------+                +----------+----------+
              |
       NORMALIZED DATA
              |
       +------+--------+
       |      |        |
      URL   GRAPH   RESOURCES
       |      |        |
       +------+--------+
              |
        ANALYSIS ENGINE
              |
       +------+---------+
       |      |         |
     RULES  SCORES   PRIORITY
       |      |         |
       +------+---------+
              |
       RIVISO INTELLIGENCE
              |
       +------+---------+
       |      |         |
      AI   SUMMARY  RECOMMENDATIONS
              |
           PRODUCT UI
```

**Build order:** crawler → data model → rule engine → analysis → API →
UI.

Do not build the visual dashboard first.

------------------------------------------------------------------------

# 4. User-Facing Information Architecture

The UI should use a modern SaaS information architecture rather than
copying Screaming Frog's desktop application.

``` text
SEO Audit
├── Overview
├── Crawl
│   ├── URL Explorer
│   ├── Internal
│   ├── External
│   └── Resources
├── Issues
│   ├── All
│   ├── Critical
│   ├── Warnings
│   └── Opportunities
├── On-Page
│   ├── Titles
│   ├── Meta Descriptions
│   ├── H1
│   ├── H2
│   ├── Content
│   ├── Images
│   └── URLs
├── Indexability
│   ├── Robots
│   ├── Directives
│   ├── Canonicals
│   ├── Sitemaps
│   ├── Hreflang
│   └── Response Codes
├── Links
│   ├── Internal
│   ├── External
│   ├── Inlinks
│   ├── Outlinks
│   ├── Orphans
│   ├── Crawl Depth
│   └── Link Score
├── Technical
│   ├── JavaScript
│   ├── Structured Data
│   ├── Security
│   ├── Headers
│   ├── Resources
│   └── Cookies
├── Performance
│   ├── PageSpeed
│   ├── Core Web Vitals
│   ├── Lighthouse
│   ├── Mobile
│   └── Response Times
├── Content Quality
│   ├── Duplicates
│   ├── Near Duplicates
│   ├── Readability
│   ├── Spelling
│   ├── Grammar
│   └── N-grams
├── Search Data
│   ├── Search Console
│   └── Analytics
├── Site Structure
├── Change Detection
├── URL Detail
└── Exports
```

------------------------------------------------------------------------

# 5. Crawl Engine

## 5.1 Crawl algorithm

Use a breadth-first crawl by default:

``` text
Depth 0
  homepage

Depth 1
  directly linked URLs

Depth 2
  URLs linked from depth 1

Depth 3
  URLs linked from depth 2

...
```

Screaming Frog publicly documents breadth-first crawling based on crawl
depth.

Recommended queue record:

``` ts
type CrawlQueueItem = {
  url: string
  normalizedUrl: string
  discoveredFrom?: string
  discoveryType: DiscoveryType
  depth: number
  priority: number
  discoveredAt: string
}
```

## 5.2 Discovery sources

Discover URLs from:

### HTML

-   `<a href>`
-   canonical
-   hreflang
-   pagination
-   images
-   scripts
-   stylesheets
-   iframes
-   media
-   `<source>`
-   `<object>`
-   `<embed>`

### JavaScript

-   rendered anchors
-   dynamically injected links
-   SPA routes
-   navigation events
-   dynamically loaded resources

### XML

-   robots.txt sitemap references
-   sitemap XML
-   sitemap indexes
-   image sitemaps

### Optional integrations

-   Google Search Console
-   Google Analytics
-   backlink providers
-   manually uploaded URL lists

------------------------------------------------------------------------

# 6. Crawl Scope

Default:

``` text
same protocol + same hostname
```

Allow:

``` text
entire domain
subdomain
subfolder
exact URL
URL list
sitemap
sitemap index
multiple seeds
```

Advanced:

``` text
include regex
exclude regex
include path
exclude path
query parameter rules
```

"Scan all URLs" means all **discoverable URLs inside the configured
scope**, not every possible query-string permutation or every URL on the
internet.

------------------------------------------------------------------------

# 7. Unlimited Paid Crawling

Do not copy Screaming Frog's 500-URL free restriction into Riviso.

Riviso should enforce plan entitlements:

``` text
Plan
→ max URLs/crawl
→ max concurrent requests
→ max render count
→ max duration
→ max storage
→ max API enrichment
```

Example product configuration:

``` text
Starter: 10,000
Growth: 100,000
Agency: 1,000,000
Enterprise: Custom
```

These are example limits only. Keep them configurable in billing.

Even Enterprise should have safety ceilings to prevent crawler traps and
runaway costs.

------------------------------------------------------------------------

# 8. URL Normalisation

Every discovered URL must pass through:

``` text
raw URL
→ parse
→ resolve relative URL
→ remove fragment
→ normalize scheme
→ normalize hostname
→ remove default ports
→ normalize percent encoding
→ resolve dot segments
→ trailing-slash policy
→ query-parameter policy
→ crawl key
```

Store both:

``` text
original discovered URL
normalized crawl URL
```

Fragments should normally not create separate crawl URLs:

``` text
/page
/page#about
/page#contact
```

→ `/page`

unless explicit SPA/fragment-routing behaviour is configured.

------------------------------------------------------------------------

# 9. Query Parameters and Crawl Traps

Support:

``` text
allow all
ignore all
allow selected parameters
ignore selected parameters
```

Recognise configurable tracking parameters:

``` text
utm_source
utm_medium
utm_campaign
utm_term
utm_content
gclid
fbclid
```

Do not remove business-critical parameters automatically.

Detect crawler traps:

-   faceted navigation
-   session IDs
-   calendars
-   infinite search URLs
-   rapidly growing query combinations
-   URL generators
-   repeated parameter permutations

When expansion becomes abnormal:

``` text
warn
pause
exclude pattern
continue
```

------------------------------------------------------------------------

# 10. Robots.txt

Default:

``` text
Respect robots.txt
```

Fetch:

``` text
https://host/robots.txt
```

Parse:

-   User-agent
-   Allow
-   Disallow
-   Sitemap
-   groups
-   wildcard rules

Store:

``` ts
type RobotsPolicy = {
  host: string
  fetchedAt: string
  statusCode: number
  rawContent: string
  sitemapUrls: string[]
  groups: RobotsGroup[]
}
```

Advanced modes:

``` text
Respect
Ignore
Custom policy
```

If ignoring robots, display an explicit warning.

------------------------------------------------------------------------

# 11. HTTP Fetcher

The HTTP layer must support:

-   HTTP/1.1
-   HTTP/2 where available
-   redirects
-   gzip/br compression
-   cookies
-   connection pooling
-   timeout
-   retry
-   TLS validation
-   response headers
-   content type
-   transfer size
-   response timing

Capture:

``` text
DNS time
TCP time
TLS time
TTFB
download time
total response time
status
size
transferred bytes
content type
content encoding
HTTP version
```

Retry transient failures:

``` text
408
429
502
503
504
timeout
connection reset
```

Use exponential backoff and a maximum retry count.

------------------------------------------------------------------------

# 12. Crawl Politeness

Use per-host concurrency.

Recommended starting point:

``` text
8 concurrent requests/host
```

Make configurable.

Adaptive behaviour:

``` text
healthy responses → gradually increase

429 / 503 / slow server → reduce concurrency
```

Paid crawling does not mean unlimited request speed.

------------------------------------------------------------------------

# 13. Redirects

Track:

``` text
source URL
status
location
redirect type
redirect chain
hop count
final URL
```

Support:

``` text
301
302
303
307
308
HSTS
JavaScript redirect
Meta refresh
```

Detect:

``` text
redirect chains
redirect loops
long redirect chains
internal links to redirects
```

Example:

``` text
A → 301 → B → 301 → C → 200
```

Store chain length = 2.

------------------------------------------------------------------------

# 14. HTML Parsing

For each HTML response parse:

``` text
doctype
html/head/body
title
meta
canonical
robots
X-Robots
headings
anchors
images
scripts
stylesheets
iframes
media
forms
language
hreflang
pagination
structured data
Open Graph
Twitter metadata
```

Malformed HTML must not terminate the crawl.

------------------------------------------------------------------------

# 15. Raw HTML and JavaScript Rendering

When rendering is enabled, store:

``` text
raw HTML
rendered DOM
```

Compare them for:

-   title added/changed by JS
-   meta description added/changed by JS
-   H1 added/changed by JS
-   canonical added/changed by JS
-   robots changes
-   links added by JS
-   content changes
-   blocked resources
-   console errors

This is required for JavaScript SEO parity.

------------------------------------------------------------------------

# 16. JavaScript Rendering

Use an isolated Chromium worker, preferably Playwright.

Flow:

``` text
HTTP fetch
→ raw HTML analysis
→ browser navigation
→ DOMContentLoaded
→ configured wait
→ optional interaction
→ final DOM
→ console capture
→ network capture
→ screenshot
→ rendered link discovery
```

Modes:

``` text
HTML-only
JavaScript
```

Future:

``` text
mobile viewport
desktop viewport
Googlebot Smartphone UA
custom UA
```

Rendering must use a separate worker queue so browser work does not
block normal HTTP crawling.

------------------------------------------------------------------------

# 17. Browser Security

Never expose:

``` text
database credentials
cloud credentials
API keys
application secrets
```

to browser page JavaScript.

Browser workers must be sandboxed and network restricted.

Protect against:

``` text
SSRF
DNS rebinding
private IP access
redirect-to-private-IP
localhost access
cloud metadata access
```

Validate every redirect destination.

------------------------------------------------------------------------

# 18. URL Data Model

Recommended:

``` ts
type CrawlUrl = {
  id: string
  auditId: string

  url: string
  normalizedUrl: string
  encodedUrl: string

  discoveredFrom: string | null
  discoveryType: string
  crawlDepth: number
  folderDepth: number

  contentType: string | null

  statusCode: number | null
  statusText: string | null

  indexability: string
  indexabilityReason: string | null

  title: string | null
  titleLength: number | null
  titlePixelWidth: number | null

  metaDescription: string | null
  metaDescriptionLength: number | null
  metaDescriptionPixelWidth: number | null

  h1: string | null
  h1Count: number
  h2: string | null
  h2Count: number

  canonical: string | null
  robotsMeta: string | null
  xRobotsTag: string | null

  wordCount: number | null
  textRatio: number | null

  sizeBytes: number | null
  transferredBytes: number | null
  totalTransferredBytes: number | null

  responseTimeMs: number | null
  ttfbMs: number | null

  lastModified: string | null

  redirectUrl: string | null
  redirectType: string | null
  httpVersion: string | null

  hash: string | null
  linkScore: number | null
}
```

------------------------------------------------------------------------

# 19. Relationship Data Model

Links must be a first-class graph, not comma-separated URL fields.

``` ts
type CrawlLink = {
  auditId: string
  sourceUrlId: string
  targetUrlId: string | null
  targetUrl: string

  type:
    | "anchor"
    | "canonical"
    | "hreflang"
    | "pagination"
    | "image"
    | "script"
    | "stylesheet"
    | "iframe"
    | "media"
    | "redirect"
    | "sitemap"
    | "javascript"

  anchorText: string | null
  rel: string[]
  followable: boolean

  discoveredIn:
    | "raw_html"
    | "rendered_html"
    | "http_header"
    | "robots"
    | "sitemap"
    | "api"
}
```

This powers:

``` text
inlinks
outlinks
crawl depth
orphan pages
broken links
anchor text
Link Score
site structure
```

------------------------------------------------------------------------

# 20. Internal URL Explorer

Riviso's equivalent of the Internal tab must expose:

``` text
URL
Content Type
Status Code
Status
Indexability
Indexability Reason
Title
Title Length
Title Pixel Width
Meta Description
Meta Description Length
Meta Description Pixel Width
H1
H1 Length
H2
H2 Length
Meta Robots
X-Robots-Tag
Canonical
rel=next
rel=prev
HTTP next/prev
Size
Transferred
Total Transferred
Word Count
Text Ratio
Crawl Depth
Folder Depth
Link Score
Inlinks
Unique Inlinks
JS Inlinks
Inlink %
Outlinks
Unique Outlinks
JS Outlinks
External Outlinks
Unique External Outlinks
JS External Outlinks
Closest Similarity
Near Duplicate Count
Spelling Errors
Grammar Errors
Hash
Response Time
Last Modified
Redirect URI
Redirect Type
HTTP Version
Encoded URL
```

Advanced columns should be selectable rather than all visible at once.

------------------------------------------------------------------------

# 21. External URL Explorer

Track:

``` text
URL
source page
content type
status
response time
crawl depth
inlinks
redirect URL
redirect type
blocked
size
```

Group by:

``` text
domain
subdomain
content type
status
```

------------------------------------------------------------------------

# 22. Response Code Audit

Support:

``` text
Blocked by robots.txt
Blocked resource
No response
2XX
3XX
4XX
5XX
JavaScript redirect
Meta refresh
```

Record exact status codes and response text.

Detect:

``` text
internal 4XX
external 4XX
internal 5XX
external 5XX
redirect chains
redirect loops
internal links to redirects
```

------------------------------------------------------------------------

# 23. Security Audit

Check:

``` text
HTTP URLs
HTTPS URLs
mixed content
HTTP forms
HSTS
Content-Security-Policy
X-Content-Type-Options
X-Frame-Options
Referrer-Policy
Permissions-Policy
bad MIME type
insecure resources
insecure canonical
insecure hreflang
insecure pagination
```

Separate:

``` text
critical
high
medium
informational
```

Do not make every missing security header an SEO-critical issue.

------------------------------------------------------------------------

# 24. URL Audit

Detect:

``` text
long URL
non-ASCII
uppercase
underscores
spaces
repeated slashes
repetitive paths
parameters
session IDs
tracking parameters
unsafe characters
redirected URL
duplicate URL forms
```

------------------------------------------------------------------------

# 25. Page Title Audit

Collect:

``` text
occurrences
title 1
title 2
length
pixel width
indexability
```

Detect:

``` text
missing
duplicate
over 60 characters
below 30 characters
multiple
outside <head>
```

Use both character length and pixel width.

------------------------------------------------------------------------

# 26. Meta Description Audit

Collect:

``` text
occurrences
description 1
description 2
length
pixel width
indexability
```

Detect:

``` text
missing
duplicate
over 155 characters
below 70 characters
over pixel threshold
below pixel threshold
multiple
outside <head>
```

------------------------------------------------------------------------

# 27. Meta Keywords

For feature parity collect:

``` text
occurrences
keywords
length
duplicates
multiple
missing
```

Classify this as legacy/informational. Do not give it meaningful Google
SEO weight.

------------------------------------------------------------------------

# 28. H1 Audit

Collect:

``` text
count
H1-1
H1-2
length
```

Detect:

``` text
missing
duplicate
over 70 characters
multiple
alt text inside H1
non-sequential
H1 only in rendered HTML
H1 changed by JavaScript
```

------------------------------------------------------------------------

# 29. H2 Audit

Collect:

``` text
count
H2-1
H2-2
length
```

Detect:

``` text
missing
duplicate
over 70 characters
multiple
non-sequential
```

Build a heading tree:

``` text
H1
 ├─ H2
 │   ├─ H3
 │   └─ H3
 └─ H2
```

------------------------------------------------------------------------

# 30. Content Audit

Calculate:

``` text
word count
sentence count
average words/sentence
text ratio
Flesch Reading Ease
readability class
exact hash
near-duplicate similarity
language
spelling errors
grammar errors
```

Content area should support configurable selectors and default exclusion
of:

``` text
header
nav
footer
```

------------------------------------------------------------------------

# 31. Exact Duplicate Content

Normalize content and calculate a cryptographic hash.

Recommended:

``` text
SHA-256
```

Group identical hashes.

Show:

``` text
duplicate group
URL count
canonical
indexability
```

------------------------------------------------------------------------

# 32. Near Duplicate Content

Use:

``` text
tokenization
shingling
MinHash/SimHash
candidate grouping
similarity calculation
```

Default similarity threshold:

``` text
90%
```

Make threshold configurable.

For large sites, never compare every page against every other page.

------------------------------------------------------------------------

# 33. Image Audit

For each image:

``` text
URL
source page
status
content type
size
dimensions
format
alt
alt length
title
lazy loading
srcset
sizes
inlinks
```

Detect:

``` text
missing alt
empty alt
long alt
broken image
large image
missing dimensions
incorrect dimensions
HTTP image
mixed content
```

Calculate:

``` text
total image weight/page
image count/page
format distribution
largest image
```

------------------------------------------------------------------------

# 34. Canonical Audit

Extract:

``` text
HTML rel=canonical
HTTP Link canonical
```

Detect:

``` text
missing
multiple
canonicalised
canonical to 4XX
canonical to 5XX
canonical to redirect
canonical to non-indexable
canonical chain
canonical loop
HTTP canonical
relative canonical
```

Store:

``` text
source
target
target status
target indexability
```

------------------------------------------------------------------------

# 35. Pagination Audit

Support:

``` text
rel=next
rel=prev
HTML headers
HTTP headers
```

Detect:

``` text
non-200 pagination target
non-indexable pagination target
broken sequence
loop
missing relationship
self-reference
```

------------------------------------------------------------------------

# 36. Directives / Robots Meta

Parse:

``` text
meta robots
googlebot
bingbot
X-Robots-Tag
```

Support:

``` text
noindex
nofollow
none
noarchive
nosnippet
max-snippet
max-image-preview
max-video-preview
notranslate
noimageindex
indexifembedded
unavailable_after
```

Store raw and parsed forms.

------------------------------------------------------------------------

# 37. Indexability Engine

Indexability must be derived from:

``` text
HTTP status
robots.txt
meta robots
X-Robots-Tag
canonical
redirect
content type
```

Output:

``` text
Indexable
Non-indexable
Blocked
Unknown
```

with an exact reason.

Do not confuse:

``` text
robots block
```

with:

``` text
noindex
```

------------------------------------------------------------------------

# 38. Hreflang

Extract:

``` text
HTML hreflang
HTTP hreflang
sitemap hreflang
```

Validate:

``` text
language code
region code
x-default
self-reference
return links
target response
target indexability
duplicate language-region
cluster consistency
```

Detect:

``` text
missing return tag
invalid code
non-200 target
non-indexable target
missing self-reference
inconsistent cluster
```

------------------------------------------------------------------------

# 39. Hreflang Graph

Represent clusters:

``` text
/en/ ↔ /fr/ ↔ /de/ ↔ /es/
```

Detect asymmetric relationships.

Store:

``` text
source
target
language
region
reciprocal
status
```

------------------------------------------------------------------------

# 40. JavaScript SEO

When rendering is enabled, detect:

``` text
blocked JS
blocked CSS
blocked images
JS-only content
JS-only title
JS-only meta
JS-only H1
JS-only canonical
JS-only links
JS-modified title
JS-modified meta
JS-modified H1
old AJAX crawling scheme
JS errors
network errors
```

Capture Chrome console messages and failed resource requests.

------------------------------------------------------------------------

# 41. Link Audit

Collect every link:

``` text
source
destination
anchor
rel
follow/nofollow
position
element
status
indexability
depth
```

Detect:

``` text
broken internal links
broken external links
nofollow/follow conflicts
empty anchors
generic anchors
non-descriptive anchors
high crawl depth
no internal outlinks
excessive outlinks
```

------------------------------------------------------------------------

# 42. Anchor Text

Normalize anchor text and classify:

``` text
descriptive
generic
empty
URL-only
image-only
branded
exact match
partial match
```

Generic examples:

``` text
click here
read more
learn more
here
```

------------------------------------------------------------------------

# 43. Link Position

Store approximate DOM area:

``` text
header
navigation
main
sidebar
footer
body
unknown
```

Future enhancement:

``` text
DOM coordinate
```

------------------------------------------------------------------------

# 44. Inlinks / Outlinks

For each URL store:

``` text
total inlinks
unique inlinks
follow inlinks
nofollow inlinks
JS inlinks
canonical inlinks
redirect inlinks

internal outlinks
unique internal outlinks
external outlinks
unique external outlinks
nofollow outlinks
JS outlinks
```

------------------------------------------------------------------------

# 45. Orphan URL Detection

Known URL sources:

``` text
crawl
XML sitemap
Google Search Console
Google Analytics
backlinks
manual list
```

An orphan is a URL found in one or more external sources but not
discovered through the normal internal-link crawl.

Output:

``` text
URL
discovery sources
status
indexability
traffic
impressions
clicks
```

------------------------------------------------------------------------

# 46. Crawl Depth

Calculate shortest path from seed:

``` text
homepage = 0
direct link = 1
second level = 2
...
```

Store:

``` text
crawl depth
shortest path
discovery path
```

Keep this separate from:

``` text
folder depth
```

------------------------------------------------------------------------

# 47. Link Score

Implement a Riviso internal-link equity metric.

Comparable baseline:

``` text
eligible:
internal
non-redirect
non-canonicalised
connected by followable links
```

Initialize:

``` text
1 / N
```

Iterate:

``` text
score(i) =
(1-D)/N
+
D × sum(score(j)/outlinks(j))
```

Use:

``` text
D = 0.85
10 iterations
```

Normalize:

``` text
1–100
```

Label it:

``` text
Riviso Link Score
```

Never call it Google PageRank.

------------------------------------------------------------------------

# 48. XML Sitemap Audit

Discover sitemaps from:

``` text
robots.txt
/sitemap.xml
sitemap indexes
```

Parse:

``` text
loc
lastmod
changefreq
priority
image/video/news extensions where supported
```

Detect:

``` text
URL not in sitemap
orphan in sitemap
non-indexable URL in sitemap
redirect in sitemap
4XX in sitemap
5XX in sitemap
URL in multiple sitemaps
sitemap > 50,000 URLs
sitemap > 50MB
invalid XML
```

Reconcile:

``` text
crawl URLs
vs sitemap URLs
vs indexable URLs
vs canonical URLs
```

------------------------------------------------------------------------

# 49. Structured Data

Extract:

``` text
JSON-LD
Microdata
RDFa
```

Parse:

``` text
@context
@type
properties
nested objects
arrays
URLs
```

Validate:

``` text
Schema.org
Google rich result requirements
```

Per URL:

``` text
errors
warnings
total types
unique types
type list
```

Store each validation finding:

``` text
schema type
property
severity
issue
expected
actual
```

------------------------------------------------------------------------

# 50. AMP

For parity:

``` text
amphtml
AMP URL discovery
AMP validation
AMP status
AMP errors
AMP warnings
```

Treat AMP as an optional/legacy audit category, not a universal
requirement.

------------------------------------------------------------------------

# 51. PageSpeed / Lighthouse

Optional enrichment per URL.

### CrUX

``` text
CWV assessment
FCP
LCP
CLS
INP
TTFB
categories
origin metrics
```

### Lighthouse

``` text
Performance score
FCP
FCP score
Speed Index
Speed Index score
LCP
LCP score
TTI
TTI score
Max Potential FID
TBT
TBT score
CLS
CLS score
```

### Insights

``` text
redirect count
server responds quickly
text compression
LCP request discovery
LCP breakdown
render-blocking requests
preconnect candidates
critical path latency
cache lifetime
layout shift culprits
DOM size
image delivery
forced reflow
legacy JavaScript
duplicated JavaScript
third parties
```

### Diagnostics

``` text
minify CSS
minify JavaScript
unused CSS
unused JavaScript
JavaScript execution
cache policy
main-thread work
network payload
user timing
```

Keep:

``` text
CrUX field data
```

separate from:

``` text
Lighthouse lab data
```

------------------------------------------------------------------------

# 52. Mobile Audit

Check:

``` text
viewport
content width
tap targets
font sizing
horizontal overflow
mobile usability
```

If Search Console is connected, store Google's mobile usability result
separately.

------------------------------------------------------------------------

# 53. Accessibility

Use:

``` text
axe-core
```

against rendered pages.

Collect:

``` text
rule
guideline
impact
selector
HTML snippet
description
help
help URL
```

Support:

``` text
WCAG 2.0 A
WCAG 2.0 AA
WCAG 2.1 A
WCAG 2.1 AA
WCAG 2.2 A
WCAG 2.2 AA
Best Practices
```

Do not use color alone to communicate severity.

------------------------------------------------------------------------

# 54. Custom Search

Provide advanced source search:

``` text
contains
does not contain
text
regex
HTML
visible text
element
XPath
CSS selector
```

Examples:

``` text
find pages containing "out of stock"
find pages missing GTM
find pages containing a tracking snippet
```

Make the number of saved searches plan-dependent, not a hard 100-filter
product limit.

------------------------------------------------------------------------

# 55. Custom Extraction

Support:

``` text
XPath
CSS selector
regex
attribute extraction
text extraction
HTML extraction
```

Examples:

``` text
price
author
SKU
custom CMS field
schema property
custom heading
```

Run against raw or rendered HTML.

------------------------------------------------------------------------

# 56. Custom JavaScript

Support controlled browser snippets:

``` text
Extraction
Action
```

Examples:

``` text
click cookie banner
open navigation
scroll
trigger interaction
extract hidden content
```

Never execute customer JavaScript directly on the API server. Use a
sandboxed browser worker.

------------------------------------------------------------------------

# 57. Google Analytics

Support GA4 enrichment where the user's account permits it.

Possible metrics:

``` text
sessions
users
new users
engagement
page views
average engagement time
conversions
revenue
```

Use for:

``` text
orphan discovery
high-traffic non-indexable URLs
traffic-at-risk prioritisation
business impact
```

------------------------------------------------------------------------

# 58. Google Search Console

Search Analytics:

``` text
clicks
impressions
CTR
position
```

URL Inspection:

``` text
URL on Google
coverage
last crawl
crawled as
crawl allowed
page fetch
user canonical
Google-selected canonical
mobile usability
AMP
rich results
```

Track API quotas and queue inspections rather than assuming unlimited
API calls.

------------------------------------------------------------------------

# 59. Link Metrics Integrations

Optional:

``` text
Moz
Ahrefs
Majestic
```

Store:

``` text
backlinks
referring domains
authority metrics
trust metrics
spam metrics
linking root domains
```

These are enrichment data, not native crawl facts.

------------------------------------------------------------------------

# 60. AI Layer

AI must interpret deterministic data; it must not invent crawl facts.

Correct:

``` text
Crawler
→ Rule
→ Evidence
→ Priority
→ AI explanation
```

AI may generate:

``` text
summary
business impact
recommendation
remediation plan
```

AI must not determine:

``` text
status code
canonical
title length
indexability
word count
```

------------------------------------------------------------------------

# 61. Issue Engine

Build a versioned rule registry.

``` ts
type AuditRule = {
  id: string
  category: string
  name: string
  severity: "issue" | "warning" | "opportunity"
  defaultPriority: "high" | "medium" | "low"
  appliesTo: string[]
  evaluate: (context: AuditContext) => RuleResult
  explanation: string
  recommendation: string
}
```

Every issue stores:

``` text
rule ID
rule version
category
severity
priority
URL
evidence
recommendation
```

Do not put SEO rules inside React components.

------------------------------------------------------------------------

# 62. Required Rule Categories

The parity registry must cover:

``` text
Response Codes
Security
URL
Page Titles
Meta Description
Meta Keywords
H1
H2
Content
Images
Canonicals
Pagination
Directives
Hreflang
JavaScript
Links
AMP
Structured Data
Sitemaps
PageSpeed
Mobile
Accessibility
Analytics
Search Console
Validation
```

This matches the current public Screaming Frog issue taxonomy.

------------------------------------------------------------------------

# 63. Issue Types

Use:

``` text
Issue
Warning
Opportunity
```

Priority:

``` text
High
Medium
Low
```

The three issue types and priority model should be compatible with the
public Screaming Frog concept, while Riviso can add its own dynamic
impact scoring.

------------------------------------------------------------------------

# 64. Dynamic Priority

Do not rank issues by count alone.

Use:

``` text
severity
× URL importance
× traffic
× impressions
× Link Score
× indexability
× business value
```

A 404 on a high-value service page should outrank a 404 on an unlinked
low-value archive page.

------------------------------------------------------------------------

# 65. URL Importance

Calculate:

``` text
Link Score
+
traffic
+
impressions
+
crawl depth inverse
+
indexability
+
business classification
```

Normalize to:

``` text
0–100
```

Use this in prioritisation.

------------------------------------------------------------------------

# 66. Issue Evidence

Every issue must answer:

``` text
What is wrong?
Why was it flagged?
What is the current value?
What should it be?
Which URLs are affected?
What should be done?
```

Example:

``` text
Duplicate Titles

73 URLs affected

Evidence:
73 indexable URLs share the same normalized title.

Action:
Create unique titles based on page intent.
```

------------------------------------------------------------------------

# 67. URL Detail

Every URL must have a complete technical profile:

``` text
Overview
Response
Indexability
Metadata
Content
Links
Canonicals
Directives
Hreflang
Structured Data
Images
JavaScript
Resources
Performance
Security
Search Console
Analytics
Issues
Raw HTML
Rendered HTML
Screenshot
Headers
Cookies
```

------------------------------------------------------------------------

# 68. URL Overview

Display:

``` text
URL
Status
Indexability
Crawl depth
Folder depth
Link Score
Response time
Content type
Size
```

Also:

``` text
First discovered from
Discovery type
Shortest crawl path
All important referring URLs
```

------------------------------------------------------------------------

# 69. Resource Analysis

For every page list:

``` text
HTML
CSS
JavaScript
Images
Fonts
Media
Other
```

Per resource:

``` text
URL
type
status
size
transferred
response time
initiator
blocked
```

------------------------------------------------------------------------

# 70. HTTP Headers

Store full headers, including:

``` text
cache-control
content-type
content-length
content-encoding
location
server
etag
last-modified
strict-transport-security
content-security-policy
x-frame-options
x-content-type-options
referrer-policy
permissions-policy
```

Do not log authorization secrets.

------------------------------------------------------------------------

# 71. Cookies

Where browser crawling is enabled, capture metadata:

``` text
name
domain
path
secure
httpOnly
sameSite
expiry
first/third party
```

Do not store cookie values by default.

------------------------------------------------------------------------

# 72. SERP Snippet

For every relevant indexable URL show:

``` text
title
URL
meta description
```

Modes:

``` text
desktop
mobile
tablet
```

Use pixel-width calculations.

Allow simulated edits without changing the website.

------------------------------------------------------------------------

# 73. Rendered Page

Show:

``` text
screenshot
rendered DOM
blocked resources
console errors
network failures
```

Provide:

``` text
Raw HTML
vs
Rendered HTML
```

------------------------------------------------------------------------

# 74. Spelling and Grammar

When enabled:

``` text
error
type
detail
suggestion
language
text context
```

Show exact location in the page.

------------------------------------------------------------------------

# 75. N-Grams

Support:

``` text
1-gram
2-gram
3-gram
4-gram
5-gram
6-gram
```

Show:

``` text
phrase
frequency
URLs
```

Useful for:

``` text
topic analysis
template detection
overused terms
content patterns
```

------------------------------------------------------------------------

# 76. Change Detection

Compare audits for:

``` text
indexability
title
meta description
H1
word count
crawl depth
inlinks
unique inlinks
internal outlinks
unique internal outlinks
external outlinks
structured-data types
content similarity
status
canonical
robots
hreflang
```

Show:

``` text
new URLs
removed URLs
changed URLs
new issues
resolved issues
regressions
improvements
```

------------------------------------------------------------------------

# 77. Site Structure

Provide:

``` text
Tree
Directory
Sunburst
Graph
```

Every visualization must be interactive.

Tree node data:

``` text
URL count
indexable
non-indexable
4XX
5XX
redirects
```

------------------------------------------------------------------------

# 78. Crawl Depth Chart

Example:

``` text
Depth 0   1
Depth 1   18
Depth 2   87
Depth 3   142
Depth 4   56
Depth 5   12
```

Clicking a bar filters the URL explorer.

------------------------------------------------------------------------

# 79. Link Graph

Nodes:

``` text
URLs
```

Edges:

``` text
internal links
```

Node size:

``` text
Riviso Link Score
```

Node colour:

``` text
indexability
```

Clicking a node opens URL detail.

------------------------------------------------------------------------

# 80. Template Detection

Group pages using:

``` text
DOM structure
URL patterns
title patterns
H1 patterns
content structure
resource profile
```

Examples:

``` text
product template
article template
service template
category template
landing page template
```

Template-level issues should be surfaced:

``` text
"Missing canonical on 612 product pages"
```

rather than only showing 612 individual rows.

------------------------------------------------------------------------

# 81. Crawl State

Use:

``` text
CREATED
QUEUED
INITIALISING
FETCHING
DISCOVERING
CRAWLING
RENDERING
ANALYSING
POST_PROCESSING
COMPLETED
PARTIAL
CANCELLED
FAILED
```

------------------------------------------------------------------------

# 82. Crawl Progress

Show:

``` text
Crawl Progress 63%

Discovered       2,014
Fetched          1,283
Queued             781
Blocked             42
Failed              11
Rendered           216
Resources        5,813
```

Do not display fake percentage progress.

The percentage must derive from the actual crawl state.

------------------------------------------------------------------------

# 83. Crawl Completion

Only mark the crawl complete when:

``` text
frontier empty
active requests = 0
render queue complete
required post-processing complete
```

If enrichment is still running:

``` text
Crawl Complete
PageSpeed Processing
```

Do not block the entire SEO audit because one enrichment API is delayed.

------------------------------------------------------------------------

# 84. Pause / Resume / Cancel

Pause:

``` text
stop scheduling new requests
finish safe active requests
persist queue
```

Resume:

``` text
restore queue
continue crawl
```

Cancel:

``` text
stop scheduling
terminate workers safely
persist completed results
mark remaining URLs pending
```

------------------------------------------------------------------------

# 85. Crawl Reconciliation

At completion:

``` text
discovered =
fetched
+
blocked
+
excluded
+
failed
+
out-of-scope
```

and:

``` text
queued = 0
active = 0
```

unless a configured crawl limit intentionally stopped the job.

------------------------------------------------------------------------

# 86. Database Architecture

Recommended entities:

``` text
projects
seo_audits
crawl_jobs
crawl_urls
crawl_links
crawl_resources
crawl_headers
crawl_cookies
crawl_issues
crawl_issue_urls
crawl_sitemaps
crawl_hreflang
crawl_structured_data
crawl_images
crawl_javascript
crawl_pagespeed
crawl_search_console
crawl_analytics
crawl_change_sets
crawl_raw_documents
```

Use PostgreSQL or the existing Riviso database.

Use object storage for:

``` text
raw HTML
rendered HTML
screenshots
large response bodies
exports
```

------------------------------------------------------------------------

# 87. Database Indexes

At minimum:

``` text
audit_id
normalized_url
status_code
content_type
indexability
crawl_depth
canonical_url
source_url_id
target_url_id
issue_rule_id
issue_severity
issue_priority
```

Composite:

``` text
(audit_id, normalized_url)
(audit_id, status_code)
(audit_id, indexability)
(audit_id, issue_rule_id)
```

------------------------------------------------------------------------

# 88. Large Site Architecture

For 100K+ URLs use:

``` text
Crawler workers
→ message queue
→ parser workers
→ browser workers
→ analysis workers
→ database
```

Separate queues:

``` text
crawl.fetch
crawl.parse
crawl.render
crawl.resources
crawl.pagespeed
crawl.searchconsole
crawl.analytics
crawl.analysis
crawl.exports
```

A slow PageSpeed request must never block the main crawl queue.

------------------------------------------------------------------------

# 89. Large-Site Duplicate Detection

Never compare all pages pairwise.

Use:

``` text
hash buckets
MinHash
SimHash
LSH
```

Then perform exact similarity only on candidates.

------------------------------------------------------------------------

# 90. URL Table Performance

Use server-side:

``` text
search
filter
sort
pagination
aggregation
```

For very large crawls, use cursor pagination and virtualized rows.

Do not send 100,000 URL rows to the browser at once.

------------------------------------------------------------------------

# 91. API Architecture

Frontend:

``` text
Riviso Web App
      ↓
Audit API
      ↓
Crawl Job
      ↓
Queue
      ↓
Workers
      ↓
Database
```

Suggested endpoints:

``` text
POST /api/seo-audits
GET  /api/seo-audits/:id
POST /api/seo-audits/:id/start
POST /api/seo-audits/:id/pause
POST /api/seo-audits/:id/resume
POST /api/seo-audits/:id/cancel
GET  /api/seo-audits/:id/progress
GET  /api/seo-audits/:id/urls
GET  /api/seo-audits/:id/issues
GET  /api/seo-audits/:id/issues/:issueId
GET  /api/seo-audits/:id/urls/:urlId
GET  /api/seo-audits/:id/links
GET  /api/seo-audits/:id/structure
GET  /api/seo-audits/:id/history
POST /api/seo-audits/:id/compare
GET  /api/seo-audits/:id/export
```

Use WebSocket or SSE for progress updates.

------------------------------------------------------------------------

# 92. Security / SSRF

The crawler is an SSRF-sensitive system.

Block private and loopback networks by default:

``` text
127.0.0.0/8
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
169.254.0.0/16
::1
fc00::/7
fe80::/10
```

Also protect against:

``` text
DNS rebinding
redirect-to-private-IP
cloud metadata access
localhost
```

Revalidate every redirect target.

------------------------------------------------------------------------

# 93. Multi-Tenant Security

Every dataset must be scoped by:

``` text
organization_id
project_id
audit_id
```

Apply authorization to:

``` text
audit
URL
issue
resource
export
```

Never rely solely on frontend permissions.

------------------------------------------------------------------------

# 94. Crawl Metadata

Store:

``` text
crawler version
parser version
rule engine version
configuration version
user agent
rendering mode
viewport
start time
end time
duration
```

This is required for reproducibility.

------------------------------------------------------------------------

# 95. Audit Immutability

Completed audits are immutable crawl snapshots.

User actions such as:

``` text
ignore
assign
mark resolved
add note
```

must be stored as separate audit metadata.

Do not mutate raw crawl facts.

------------------------------------------------------------------------

# 96. Rule Versioning

Every result stores:

``` text
rule_id
rule_version
```

If a rule changes later, old audits remain interpretable.

------------------------------------------------------------------------

# 97. Reprocess vs Re-Crawl

Two separate actions:

### Re-run Audit

Fetch website again.

### Re-analyse

Use existing crawl data with the current rule/scoring configuration.

This allows scoring/rule changes without making network requests.

------------------------------------------------------------------------

# 98. Issue Workflow

Each issue supports:

``` text
Open
In Review
Ignored
Resolved
Reopened
```

Allow:

``` text
assign
note
export
view URLs
ignore URL
ignore pattern
```

------------------------------------------------------------------------

# 99. Saved Views

Allow saved filters such as:

``` text
High Priority 404s
Indexable Pages Missing Titles
Duplicate Titles
Orphan Pages
Slow Pages
Pages With No H1
Canonical Problems
Sitemap Problems
```

------------------------------------------------------------------------

# 100. Export System

Support:

``` text
CSV
XLSX
JSON
```

Optional:

``` text
PDF
Google Sheets
```

Required exports:

``` text
all URLs
internal
external
4XX
5XX
redirects
missing titles
duplicate titles
missing meta
duplicate meta
missing H1
duplicate H1
canonical issues
hreflang issues
robots issues
broken links
orphans
sitemap issues
structured-data issues
images
JavaScript
security
PageSpeed
accessibility
duplicates
near duplicates
issues
warnings
opportunities
```

------------------------------------------------------------------------

# 101. Audit Overview UI

Use the previously approved UberSuggest-inspired information hierarchy
with Riviso branding.

Top KPI strip:

``` text
SEO HEALTH
CRAWLED
INDEXABLE
NON-INDEXABLE
ISSUES
WARNINGS
OPPORTUNITIES
```

Then:

``` text
Riviso Audit Summary
```

Then:

``` text
Next Actions
```

Then:

``` text
Crawl Health
Indexability
On-Page
Links
Technical
Performance
Content
Site Structure
History
```

The UX should prioritise:

``` text
What is wrong?
How important is it?
What should I fix first?
```

------------------------------------------------------------------------

# 102. Next Actions

Do not expose a wall of hundreds of raw issues.

Use:

``` text
[Critical]
[Quick Wins]
[On-Page]
[Technical]
[Content]
[Links]
```

Each row:

``` text
Issue
Impact
Effort
Affected URLs
Evidence
Action
```

Example:

``` text
Broken internal links
High
Low
34 URLs
[View Fix]

Duplicate title tags
Medium
Medium
73 URLs
[Review]

Render-blocking resources
High
Medium
18 URLs
[View Performance]
```

------------------------------------------------------------------------

# 103. Issue Detail UI

``` text
Duplicate Titles

73 URLs affected
High priority

Why this matters
...

Detected pattern
...

Affected URLs
URL | Current Title | Status | Link Score

Recommended action
...

[Export URLs]
[Mark Resolved]
```

------------------------------------------------------------------------

# 104. URL Detail UI

Use a right-side drawer on desktop and full-screen sheet on mobile.

Sections:

``` text
Overview
Response
Indexability
Metadata
Content
Links
Canonicals
Directives
Hreflang
Schema
Images
JavaScript
Resources
Performance
Security
GSC
GA4
Issues
Raw HTML
Rendered HTML
Screenshot
Headers
Cookies
```

------------------------------------------------------------------------

# 105. Site Structure UI

Provide:

``` text
tree
directory
sunburst
graph
crawl depth
```

Every visualization must filter the URL explorer when clicked.

------------------------------------------------------------------------

# 106. SEO Health Score

Do not simply count issues.

Recommended dimensions:

``` text
Crawlability
Indexability
On-Page
Internal Linking
Content
Structured Data
Security
Performance
Accessibility
```

Each:

``` text
0–100
```

Overall score is weighted and explainable.

Initial example:

``` text
Crawlability   15%
Indexability   20%
On-Page        20%
Links          15%
Content        10%
Schema          5%
Security        5%
Performance    10%
```

Treat these as product defaults to calibrate with real audits.

------------------------------------------------------------------------

# 107. Score Transparency

Never show only:

``` text
SEO Health 78
```

Show:

``` text
Crawlability     91
Indexability     82
On-Page          74
Internal Links   88
Content          76
Schema           94
Security         81
Performance      68
```

Each score must link to its issues.

------------------------------------------------------------------------

# 108. Issue Impact

Dynamic priority should consider:

``` text
severity
URL importance
traffic
impressions
Link Score
indexability
business value
affected URL count
```

A large number of low-value issues must not automatically outrank a
small number of critical issues.

------------------------------------------------------------------------

# 109. Template-Level Intelligence

If a rule affects hundreds of URLs sharing a template, show:

``` text
Template Issue
```

Example:

``` text
Missing canonical
612 product pages
```

Then show representative examples and allow drilling into all affected
URLs.

------------------------------------------------------------------------

# 110. Integrations as Enrichment

The crawl must remain useful without:

``` text
PageSpeed
GSC
GA4
backlinks
AI
```

If an integration fails:

``` text
SEO crawl still completes.
```

Show:

``` text
Crawl ✓
PageSpeed ⚠
GSC —
GA4 ✓
```

------------------------------------------------------------------------

# 111. Search Console Quota Handling

If URL Inspection quota is limited:

``` text
prioritise indexable URLs
prioritise high Link Score
prioritise high traffic
prioritise high impressions
prioritise recently changed pages
```

Track remaining quota.

Never imply Riviso's own unlimited crawl means unlimited Google API
quota.

------------------------------------------------------------------------

# 112. Crawl Cost Tracking

Track per audit:

``` text
HTTP requests
browser seconds
rendered pages
PageSpeed calls
AI tokens
storage
```

This is required for paid-plan economics.

------------------------------------------------------------------------

# 113. Scheduled Audits

Support:

``` text
daily
weekly
monthly
custom
```

Each scheduled crawl:

``` text
runs
stores snapshot
compares
generates regression report
notifies user
```

------------------------------------------------------------------------

# 114. Regression Monitoring

Notify when:

``` text
SEO score drops
4XX increases
5XX increases
indexable URLs decrease
robots changes
sitemap changes
canonical problems increase
CWV regress
new high-priority issue appears
```

------------------------------------------------------------------------

# 115. Benchmarking

Create known test websites/fixtures for:

``` text
missing title
duplicate title
long title
missing meta
missing H1
duplicate H1
canonical chain
redirect loop
404
robots block
noindex
hreflang mismatch
schema error
broken image
missing alt
JS title
JS link
```

Each fixture must have expected results.

------------------------------------------------------------------------

# 116. Crawl Accuracy Tests

Test:

``` text
relative URLs
absolute URLs
protocol-relative URLs
fragments
query parameters
encoded URLs
redirects
redirect loops
robots
sitemaps
duplicate URLs
```

------------------------------------------------------------------------

# 117. Browser Tests

Test:

``` text
React
Next.js
Vue
Angular
SPA
lazy-loaded links
dynamic title
dynamic canonical
cookie banner
blocked JS
JS error
network error
```

------------------------------------------------------------------------

# 118. Scale Tests

Benchmark:

``` text
1K URLs
10K URLs
100K URLs
1M URLs
```

Measure:

``` text
URLs/min
memory
CPU
database growth
queue latency
browser worker utilisation
```

------------------------------------------------------------------------

# 119. Required Feature Parity Matrix

  Screaming Frog Area       Riviso
  ------------------------- -----------------------
  Internal                  Required
  External                  Required
  Security                  Required
  Response Codes            Required
  URL                       Required
  Page Titles               Required
  Meta Description          Required
  Meta Keywords             Required
  H1                        Required
  H2                        Required
  Content                   Required
  Images                    Required
  Canonicals                Required
  Pagination                Required
  Directives                Required
  Hreflang                  Required
  JavaScript                Required
  Links                     Required
  AMP                       Required / legacy
  Structured Data           Required
  Sitemaps                  Required
  PageSpeed                 Required
  Mobile                    Required
  Accessibility             Required
  Custom Search             Required
  Custom Extraction         Required
  Custom JavaScript         Advanced
  Analytics                 Integration
  Search Console            Integration
  Validation                Required
  Link Metrics              Optional integrations
  AI                        Riviso enhancement
  Change Detection          Required
  URL Details               Required
  Inlinks                   Required
  Outlinks                  Required
  Image Details             Required
  Duplicate Details         Required
  Resources                 Required
  SERP Snippet              Required
  Rendered Page             Required
  View Source               Required
  HTTP Headers              Required
  Cookies                   Advanced
  Structured Data Details   Required
  Lighthouse Details        Required
  Accessibility Details     Required
  Spelling & Grammar        Required
  N-Grams                   Advanced

------------------------------------------------------------------------

# 120. Development Phases

## Phase 1 --- Crawl Foundation

``` text
seed URL
URL normalization
scope
robots
queue
HTTP fetcher
HTML parser
URL discovery
deduplication
status codes
```

## Phase 2 --- Core SEO

``` text
titles
meta
H1
H2
canonical
robots directives
URL analysis
response times
links
crawl depth
```

## Phase 3 --- Graph

``` text
inlinks
outlinks
broken links
orphans
site structure
Link Score
```

## Phase 4 --- Technical

``` text
sitemaps
hreflang
pagination
structured data
security
JavaScript
images
resources
```

## Phase 5 --- Content

``` text
word count
readability
duplicates
near duplicates
spelling
grammar
n-grams
```

## Phase 6 --- Rendering

``` text
Playwright
render queue
raw vs rendered
screenshots
console
blocked resources
JS SEO
```

## Phase 7 --- Integrations

``` text
PageSpeed
Search Console
GA4
backlinks
```

## Phase 8 --- Intelligence

``` text
issue engine
priority
URL importance
SEO score
AI summary
recommendations
```

## Phase 9 --- Product UX

``` text
overview
URL explorer
issue explorer
URL drawer
issue drawer
site structure
exports
saved views
```

## Phase 10 --- Scale

``` text
distributed workers
queues
large-site storage
resume
adaptive concurrency
distributed rendering
cost controls
```

------------------------------------------------------------------------

# 121. MVP Full SEO Audit

The first serious production release should include:

``` text
✓ full-domain crawl
✓ plan-based unlimited crawling
✓ robots.txt
✓ URL normalization
✓ status codes
✓ redirects
✓ titles
✓ meta descriptions
✓ H1/H2
✓ URLs
✓ canonicals
✓ robots directives
✓ hreflang
✓ images
✓ internal links
✓ external links
✓ crawl depth
✓ sitemap audit
✓ orphan detection via sitemap
✓ structured data
✓ security
✓ duplicate content
✓ PageSpeed
✓ accessibility
✓ issue engine
✓ SEO score
✓ URL detail
✓ issue detail
✓ exports
✓ audit history
```

------------------------------------------------------------------------

# 122. Post-MVP

Add:

``` text
JavaScript rendering
GA4
GSC
URL Inspection
backlinks
custom extraction
custom search
custom JS
AI
n-grams
change detection
scheduled crawling
template detection
advanced site structure
migration audits
ecommerce audits
international SEO
```

------------------------------------------------------------------------

# 123. Critical Engineering Rules

### Rule 1 --- Crawler first

Do not build a beautiful dashboard over incomplete data.

### Rule 2 --- Relationship data is first-class

Do not store only URLs. Store links and discovery relationships.

### Rule 3 --- Deterministic facts first

Crawler/parser facts must never be generated by AI.

### Rule 4 --- Every issue needs evidence

Every finding must be traceable to a URL and rule input.

### Rule 5 --- No fake data

Never fabricate:

``` text
scores
URLs
dates
traffic
savings
historical results
```

### Rule 6 --- Separate crawl from enrichment

PageSpeed/GSC/GA4 must not block the core crawler.

### Rule 7 --- Separate lab and field data

Never mix Lighthouse and CrUX.

### Rule 8 --- Separate crawl depth and folder depth

They measure different things.

### Rule 9 --- Reprocess without recrawling

Rule/scoring changes should not require a new network crawl.

### Rule 10 --- Paid does not mean uncontrolled

Unlimited within plan entitlement still requires:

``` text
rate limits
SSRF protection
crawl traps
cost controls
server safety
```

------------------------------------------------------------------------

# 124. Final Product Definition

Riviso SEO Audit should be:

> **A full-site technical SEO crawler and intelligence platform that
> discovers, crawls, renders, analyses, prioritises and explains every
> relevant URL and relationship across a website.**

The product should combine:

``` text
Screaming Frog-level crawling breadth
+
UberSuggest-style SaaS UX
+
Google PageSpeed data
+
Google Search Console data
+
GA4 data
+
Riviso prioritisation
+
Riviso AI explanations
+
Historical monitoring
```

The user should be able to move from:

``` text
Website
→ issue
→ affected URLs
→ evidence
→ recommendation
→ remediation
→ re-crawl
→ comparison
```

without leaving Riviso.

------------------------------------------------------------------------

# 125. Final Implementation Instruction

Do not begin by recreating Screaming Frog screenshots.

Begin with:

``` text
1. Crawl data model
2. URL normalization
3. Crawl frontier
4. HTTP fetcher
5. HTML parser
6. Link graph
7. Rule engine
8. Post-crawl analysis
9. API
10. UI
```

The UI is the presentation layer of the audit engine.

The underlying crawler, graph, rule registry and evidence model are the
product.

**Build the crawler first. Build the intelligence second. Build the UI
around the resulting data model.**
