"""
Build AI-citation check prompts from a project's *existing* keyword data --
no new prompt-authoring UI in v1 (see the AI Citation Tracking plan).

Sources, in order:
  - articles.focus_keyphrase / articles.keywords (via storage.load_articles_listing_for_project)
  - topic_clusters.pillar.keywords / topic_clusters.clusters[].keywords
"""

from __future__ import annotations

from typing import Any

_TEMPLATES = (
    "what is the best tool for {keyword}",
    "recommend a {keyword} solution",
    "what are the top options for {keyword}",
)


def _collect_keywords(st, project_id: str) -> list[tuple[str, str]]:
    """Returns [(keyword, source)] in discovery order, not yet deduped."""
    out: list[tuple[str, str]] = []

    articles = []
    try:
        articles = st.load_articles_listing_for_project(project_id, limit=5000) or []
    except Exception:
        articles = []
    for a in articles:
        if not isinstance(a, dict):
            continue
        fk = (a.get("focus_keyphrase") or "").strip()
        if fk:
            out.append((fk, "article_focus_keyphrase"))
        for kw in a.get("keywords") or []:
            kw = (kw or "").strip() if isinstance(kw, str) else ""
            if kw:
                out.append((kw, "article_keyword"))

    clusters_docs = []
    try:
        clusters_docs = st.list_topic_clusters_for_project(project_id, limit=100) or []
    except Exception:
        clusters_docs = []
    for doc in clusters_docs:
        if not isinstance(doc, dict):
            continue
        pillar = doc.get("pillar") or {}
        if isinstance(pillar, dict):
            for kw in pillar.get("keywords") or []:
                kw = (kw or "").strip() if isinstance(kw, str) else ""
                if kw:
                    out.append((kw, "topic_cluster_keyword"))
        for slot in doc.get("clusters") or []:
            if not isinstance(slot, dict):
                continue
            for kw in slot.get("keywords") or []:
                kw = (kw or "").strip() if isinstance(kw, str) else ""
                if kw:
                    out.append((kw, "topic_cluster_keyword"))

    return out


def build_check_prompts(
    project_id: str,
    st: Any,
    *,
    max_keywords: int = 10,
    exclude_keywords: set[str] | None = None,
) -> list[dict[str, str]]:
    """
    Dedupe (casefold) the project's existing keywords, cap at `max_keywords`
    (plan-gated by the caller), expand each into the fixed template set.

    `exclude_keywords` (already-casefolded) skips keywords a previous run
    already checked, so each click of "Check more" covers new ground instead
    of re-checking the same top keywords -- the caller decides what "already
    checked" means (see ai_citation.py's /run, which wraps around to a full
    refresh once every keyword has been covered rather than ever returning
    nothing here).

    # ponytail: 3 templates x up to `max_keywords` keywords -- this is exactly why
    # the plan-gated cap on max_keywords matters, not a knob to add "later".
    """
    pid = (project_id or "").strip()
    if not pid:
        return []

    excluded = exclude_keywords or set()
    seen: set[str] = set()
    keywords: list[tuple[str, str]] = []
    for kw, source in _collect_keywords(st, pid):
        key = kw.casefold()
        if key in seen or key in excluded:
            continue
        seen.add(key)
        keywords.append((kw, source))
        if len(keywords) >= max(1, int(max_keywords or 10)):
            break

    return expand_prompts_for_keywords(keywords)


def expand_prompts_for_keywords(keywords: list[tuple[str, str]]) -> list[dict[str, str]]:
    """Applies the fixed template set to an already-resolved [(keyword, source)]
    list -- shared by build_check_prompts above and the LLM-expansion path
    (ai_citation.py's /run, once the project's own content runs out of new
    keywords) so both produce prompts the same way."""
    prompts: list[dict[str, str]] = []
    for kw, source in keywords:
        for template in _TEMPLATES:
            prompts.append({"prompt": template.format(keyword=kw), "keyword": kw, "keyword_source": source})
    return prompts
