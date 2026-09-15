"""Versioned rule registry (Site-Audit-Design.md §61-§66).

Each rule is plain metadata + an explanation/recommendation string -- deliberately
*not* logic embedded in a React component (§61: "Do not put SEO rules inside React
components"). `issues.py` evaluates crawled data against these definitions and
produces the actual `seo_audit_issues` records; every stored issue carries
`rule_id` + `RULE_ENGINE_VERSION` so a later rule-copy change never rewrites the
meaning of an old, immutable audit (§96).
"""

from __future__ import annotations

from dataclasses import dataclass

RULE_ENGINE_VERSION = "2026.08.1"


@dataclass(frozen=True)
class RuleMeta:
    id: str
    category: str
    name: str
    severity: str  # "issue" | "warning" | "opportunity"
    priority: str  # "high" | "medium" | "low" -- shown as "Impact" in the UI
    effort: str  # "low" | "medium" | "high" -- how much work fixing one instance takes
    explanation: str
    recommendation: str


# Phase 1+2 scope only: response codes, on-page (titles/meta/H1/H2), canonicals,
# links. Sitemap/hreflang/structured-data/security/images/content rules are later
# phases (see the approved plan's phase-by-phase breakdown).
RULES: dict[str, RuleMeta] = {
    r.id: r
    for r in [
        RuleMeta(
            id="response_4xx",
            category="Response Codes",
            name="Broken page (4XX)",
            severity="issue",
            priority="high",
            effort="medium",
            explanation="The page returned a client error status and is unreachable for users and search engines.",
            recommendation="Fix the broken link/route, or 301-redirect it to a working, relevant URL.",
        ),
        RuleMeta(
            id="response_5xx",
            category="Response Codes",
            name="Server error (5XX)",
            severity="issue",
            priority="high",
            effort="high",
            explanation="The server failed to generate a response for this URL.",
            recommendation="Investigate the server/application error for this route.",
        ),
        RuleMeta(
            id="title_missing",
            category="Page Titles",
            name="Missing title tag",
            severity="issue",
            priority="high",
            effort="low",
            explanation="Indexable pages without a title tag lose their SERP headline and a strong on-page relevance signal.",
            recommendation="Add a unique, descriptive <title> (30-60 characters).",
        ),
        RuleMeta(
            id="title_duplicate",
            category="Page Titles",
            name="Duplicate title tag",
            severity="warning",
            priority="medium",
            effort="medium",
            explanation="Multiple indexable URLs share the same title, diluting relevance signals and confusing search engines about which page to rank.",
            recommendation="Give each page a unique title based on its specific intent.",
        ),
        RuleMeta(
            id="title_too_long",
            category="Page Titles",
            name="Title over 60 characters",
            severity="opportunity",
            priority="low",
            effort="low",
            explanation="Long titles are commonly truncated in search results.",
            recommendation="Trim the title to the important keywords and brand, ideally under 60 characters.",
        ),
        RuleMeta(
            id="title_too_short",
            category="Page Titles",
            name="Title under 30 characters",
            severity="opportunity",
            priority="low",
            effort="low",
            explanation="Very short titles often under-describe the page and waste available SERP space.",
            recommendation="Expand the title to better describe the page's content.",
        ),
        RuleMeta(
            id="title_multiple",
            category="Page Titles",
            name="Multiple title tags",
            severity="warning",
            priority="low",
            effort="low",
            explanation="More than one <title> element exists; browsers and search engines only use one, and which one is used is not guaranteed.",
            recommendation="Remove the extra <title> tags so exactly one remains.",
        ),
        RuleMeta(
            id="meta_description_missing",
            category="Meta Description",
            name="Missing meta description",
            severity="warning",
            priority="medium",
            effort="low",
            explanation="Without a meta description, search engines auto-generate a snippet that may not represent the page well.",
            recommendation="Write a unique meta description (roughly 70-155 characters) that summarizes the page and encourages clicks.",
        ),
        RuleMeta(
            id="meta_description_duplicate",
            category="Meta Description",
            name="Duplicate meta description",
            severity="warning",
            priority="medium",
            effort="medium",
            explanation="Multiple indexable URLs share the same meta description.",
            recommendation="Write a distinct description for each page.",
        ),
        RuleMeta(
            id="meta_description_too_long",
            category="Meta Description",
            name="Meta description over 155 characters",
            severity="opportunity",
            priority="low",
            effort="low",
            explanation="Long descriptions are commonly truncated in search results.",
            recommendation="Shorten the description to the essential summary.",
        ),
        RuleMeta(
            id="h1_missing",
            category="H1",
            name="Missing H1",
            severity="warning",
            priority="medium",
            effort="low",
            explanation="The page has no H1 heading, weakening its topical signal and document structure.",
            recommendation="Add a single, descriptive H1 that reflects the page's main topic.",
        ),
        RuleMeta(
            id="h1_multiple",
            category="H1",
            name="Multiple H1 tags",
            severity="warning",
            priority="low",
            effort="low",
            explanation="More than one H1 exists, which can dilute the page's primary topical signal.",
            recommendation="Use a single H1 for the page's main heading; use H2/H3 for subsections.",
        ),
        RuleMeta(
            id="h1_duplicate",
            category="H1",
            name="Duplicate H1",
            severity="warning",
            priority="low",
            effort="medium",
            explanation="Multiple indexable URLs share the same H1 text.",
            recommendation="Give each page a distinct H1 aligned with its specific content.",
        ),
        RuleMeta(
            id="canonical_missing",
            category="Canonicals",
            name="Missing canonical tag",
            severity="opportunity",
            priority="low",
            effort="low",
            explanation="No rel=canonical is set; search engines must infer the canonical version themselves.",
            recommendation="Add a self-referencing canonical tag to make the preferred URL explicit.",
        ),
        RuleMeta(
            id="canonical_to_non_indexable",
            category="Canonicals",
            name="Canonical points to a non-indexable URL",
            severity="warning",
            priority="medium",
            effort="medium",
            explanation="The canonical target is blocked, errors out, or is itself non-indexable, so the canonical signal can't be honored.",
            recommendation="Point the canonical at a real, indexable 200-status URL.",
        ),
        RuleMeta(
            id="broken_internal_link",
            category="Links",
            name="Broken internal link",
            severity="issue",
            priority="high",
            effort="medium",
            explanation="An internal link points to a URL that returned a 4XX/5XX status during this crawl.",
            recommendation="Update or remove the link, or fix/restore the target page.",
        ),
        RuleMeta(
            id="orphan_page",
            category="Links",
            name="Orphan page",
            severity="warning",
            priority="medium",
            effort="medium",
            explanation="This page was crawled but has no internal links pointing to it from any other crawled page, making it hard for users and search engines to discover.",
            recommendation="Add internal links to this page from relevant, already-linked pages.",
        ),
        RuleMeta(
            id="redirect_chain",
            category="Response Codes",
            name="Redirect chain",
            severity="warning",
            priority="low",
            effort="low",
            explanation="This URL redirects through multiple hops before reaching its final destination, wasting crawl budget and link equity.",
            recommendation="Point the original link directly at the final destination URL.",
        ),
        RuleMeta(
            id="noindex_indexable_target",
            category="Directives",
            name="noindex page still receiving internal links",
            severity="opportunity",
            priority="low",
            effort="low",
            explanation="This page is marked noindex but other crawled pages still link to it, which is often unintentional.",
            recommendation="Confirm the noindex is intentional; if not, remove it, or update the internal links to point elsewhere.",
        ),
    ]
}
