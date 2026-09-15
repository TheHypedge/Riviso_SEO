"""Post-crawl link-graph analysis (Site-Audit-Design.md §44-§46).

Runs once after the crawl frontier is exhausted: computes inlink counts for every
crawled URL and flags orphans (crawled pages with zero internal inlinks other than
the seed itself). Link Score (§47) and sitemap-based orphan detection are later
phases -- this pass only uses the crawl's own link graph, which is honestly all
Phase 1+2 has.
"""

from __future__ import annotations

from typing import Any


def run_post_crawl_analysis(st: Any, *, audit_id: str, seed_normalized_url: str, on_progress: Any = None) -> dict[str, Any]:
    urls = st.load_all_seo_audit_urls(audit_id, on_progress=on_progress)
    inlink_agg = st.aggregate_seo_audit_inlink_counts(audit_id)

    full_counts = {u["normalized_url"]: inlink_agg.get(u["normalized_url"], 0) for u in urls if u.get("normalized_url")}
    st.update_seo_audit_url_inlink_counts(audit_id, full_counts)

    # Merge the freshly-computed inlink counts into the in-memory list too, so the
    # caller (seo_crawl_worker._run_one_audit) can reuse `urls` for issue evaluation
    # instead of fetching the whole collection a second time right after this returns.
    for u in urls:
        nu = u.get("normalized_url")
        if nu:
            u["inlink_count"] = full_counts.get(nu, 0)

    orphans = {
        u["normalized_url"]
        for u in urls
        if u.get("normalized_url") != seed_normalized_url and full_counts.get(u.get("normalized_url"), 0) == 0
    }
    return {"orphan_count": len(orphans), "orphan_urls": orphans, "urls": urls}
