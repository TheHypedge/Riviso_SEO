"""
Humanizer + integrity guardrails for planning-layer titles (clusters, research, strategy maps).

Does not alter keyword targeting, focus-keyphrase rules, or meta-tag structural validation.
"""
from __future__ import annotations

import re
from typing import Any, Literal

from app.services.human_writing_guardrail import AI_DETECTOR_BANNED_PHRASES

TitleRole = Literal["pillar", "cluster", "research"]

# Required ban-list (case-insensitive word boundaries).
TITLE_AI_CLICHE_BANNED_WORDS: tuple[str, ...] = (
    "ultimate",
    "comprehensive",
    "mastering",
    "delve",
    "revolutionize",
    "transforming",
    "unlocking",
    "navigating",
    "definitive",
    "complete guide",
    "everything you need to know",
    "in-depth guide",
    "step-by-step guide",
)

# Extend with overlapping article-body bans that commonly leak into titles.
_TITLE_EXTRA_BANS: tuple[str, ...] = tuple(
    p
    for p in AI_DETECTOR_BANNED_PHRASES
    if p
    in {
        "comprehensive guide",
        "game-changer",
        "landscape of",
        "leverage",
        "utilize",
        "holistic",
        "myriad",
        "plethora",
        "robust",
        "seamlessly",
        "unlock the potential",
        "let's dive in",
        "in this article, we will",
        "this article will explore",
    }
)

_ALL_TITLE_BANS: tuple[str, ...] = tuple(
    dict.fromkeys([*TITLE_AI_CLICHE_BANNED_WORDS, *_TITLE_EXTRA_BANS]).keys()
)

_PILLAR_FORBIDDEN_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\ban introduction to\b", re.I),
    re.compile(r"\bintroducing\b", re.I),
    re.compile(r"\bthe ultimate guide to\b", re.I),
    re.compile(r"\bultimate guide to\b", re.I),
    re.compile(r"\ba complete guide to\b", re.I),
    re.compile(r"\bcomplete guide to\b", re.I),
    re.compile(r"\beverything you need to know about\b", re.I),
    re.compile(r"\bthe definitive guide to\b", re.I),
    re.compile(r"\bmastering\b", re.I),
    re.compile(r"\bcomprehensive overview of\b", re.I),
)

_CLUSTER_FORBIDDEN_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^\d+\s+(benefits|reasons|ways|tips|steps)\s+(of|to|for)\b", re.I),
    re.compile(r"^how to\b", re.I),
    re.compile(r"^why you need\b", re.I),
    re.compile(r"^why you should\b", re.I),
    re.compile(r"^what is\b", re.I),
    re.compile(r"^what are\b", re.I),
    re.compile(r"^the benefits of\b", re.I),
    re.compile(r"^top \d+\b", re.I),
    re.compile(r"^best \d+\b", re.I),
    re.compile(r"\bultimate\b", re.I),
    re.compile(r"\bcomprehensive\b", re.I),
)

_BAN_WORD_RES: list[tuple[re.Pattern[str], str]] = []
for _phrase in _ALL_TITLE_BANS:
    if " " in _phrase:
        _BAN_WORD_RES.append((re.compile(re.escape(_phrase), re.I), ""))
    else:
        _BAN_WORD_RES.append((re.compile(rf"\b{re.escape(_phrase)}\b", re.I), ""))


def _normalize_title(title: str) -> str:
    return " ".join((title or "").strip().split())[:300]


def extract_competitor_titles_from_serp(serp_rows: list[dict[str, Any]] | None) -> list[str]:
    """Pull live competitor titles from SERP rows (Research + Cluster modules)."""
    out: list[str] = []
    seen: set[str] = set()
    for row in serp_rows or []:
        if not isinstance(row, dict):
            continue
        raw = row.get("title") or row.get("link_title") or ""
        t = _normalize_title(str(raw))[:200]
        if not t:
            continue
        key = t.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
        if len(out) >= 12:
            break
    return out


def summarize_serp_title_formulas(titles: list[str]) -> str:
    """Lightweight structural read of competitor titles for prompt injection."""
    if not titles:
        return "No live SERP titles available — infer common formulas from the niche, then break them."
    formulas: list[str] = []
    for t in titles[:8]:
        tl = t.lower()
        if tl.startswith("how to"):
            formulas.append("How to …")
        elif re.match(r"^\d+\s", t):
            formulas.append("Numbered list headline")
        elif " vs " in tl or " versus " in tl:
            formulas.append("X vs Y comparison")
        elif tl.startswith("what is") or tl.startswith("what are"):
            formulas.append("What is/are … definition")
        elif "guide" in tl:
            formulas.append("… Guide")
        elif "best" in tl:
            formulas.append("Best …")
        elif "benefits" in tl:
            formulas.append("… Benefits …")
        else:
            formulas.append("Declarative keyword headline")
    uniq = list(dict.fromkeys(formulas))
    return "Dominant SERP title formulas observed: " + "; ".join(uniq[:6]) + "."


def title_has_banned_cliche(title: str) -> bool:
    t = (title or "").casefold()
    if not t:
        return True
    for phrase in _ALL_TITLE_BANS:
        if phrase in t:
            return True
    return False


def title_has_forbidden_template(title: str, role: TitleRole) -> bool:
    t = _normalize_title(title)
    if not t:
        return True
    patterns = _PILLAR_FORBIDDEN_PATTERNS if role == "pillar" else _CLUSTER_FORBIDDEN_PATTERNS
    if role == "research":
        patterns = _CLUSTER_FORBIDDEN_PATTERNS
    return any(p.search(t) for p in patterns)


def scrub_title_linguistics(title: str) -> str:
    """Remove AI cliché tokens/phrases from a title string."""
    out = _normalize_title(title)
    if not out:
        return ""
    for pat, repl in _BAN_WORD_RES:
        out = pat.sub(repl, out)
    out = re.sub(r"\s{2,}", " ", out)
    out = re.sub(r"\s+([:?,!])", r"\1", out)
    out = re.sub(r"^\s*to\s+", "", out, flags=re.I)
    out = out.strip(" -–—:|,")
    return _normalize_title(out)


def build_semantic_fallback_title(*, keyword: str, role: TitleRole = "cluster") -> str:
    """
    Safe fallback when humanized titles fail validation — keyword-first, no template fluff.
    """
    kw = _normalize_title(keyword)[:90]
    if not kw:
        return "Topic overview" if role == "pillar" else "Related topic"
    # Light title case on first character only; preserve acronyms and mid-phrase casing.
    if kw[0].islower():
        kw = kw[0].upper() + kw[1:]
    if role == "pillar":
        return kw[:90]
    return kw[:90]


def humanize_planning_title(
    title: str,
    *,
    role: TitleRole,
    keyword_fallback: str,
) -> str:
    """
    Validate → scrub → semantic fallback. Never raises; safe for background queues.
    """
    candidate = _normalize_title(title)
    if candidate and not title_has_banned_cliche(candidate) and not title_has_forbidden_template(candidate, role):
        return candidate[:300]

    scrubbed = scrub_title_linguistics(candidate)
    if scrubbed and not title_has_banned_cliche(scrubbed) and not title_has_forbidden_template(scrubbed, role):
        return scrubbed[:300]

    return build_semantic_fallback_title(keyword=keyword_fallback or candidate, role=role)[:300]


def format_title_ban_list_for_prompt() -> str:
    bullets = "\n".join(f"- {w}" for w in TITLE_AI_CLICHE_BANNED_WORDS)
    return (
        "TITLE BAN-LIST (reject any title containing these words/phrases, any casing):\n"
        f"{bullets}\n"
    )


def format_pillar_title_constraints() -> str:
    return (
        "PILLAR TITLE RULES (authority page — not academic):\n"
        "- FORBID passive/academic openers: 'An Introduction to…', 'The Ultimate Guide to…', "
        "'A Complete Guide to…', 'Everything You Need to Know About…'.\n"
        "- FORBID filler positioning: comprehensive, ultimate, mastering, definitive, navigating.\n"
        "- REQUIRE: authoritative, paradigm-shifting, punchy industry positioning — reads like a "
        "senior operator naming a flagship reference, not a textbook chapter.\n"
        "- Max 90 characters. Include the core topic keyword naturally.\n"
    )


def format_cluster_title_constraints() -> str:
    return (
        "CLUSTER TITLE RULES (supporting articles — not formula blogs):\n"
        "- FORBID repetitive templates: 'X Benefits of…', 'How to…', 'Why You Need…', "
        "'What Is…', 'Top N…', numbered list headlines.\n"
        "- FORBID symmetric SEO-blog cadence; vary syntax across the cluster set.\n"
        "- REQUIRE: asymmetric hooks — specific real-world problem framing, sharp trade-off, "
        "contrarian angle, or natural first-person professional phrasing ('I stopped…', "
        "'Most teams miss…') when tone allows.\n"
        "- Max 90 characters. Each cluster title must be structurally distinct from the others.\n"
    )


def format_competitor_pattern_breaking_block(competitor_titles: list[str]) -> str:
    summary = summarize_serp_title_formulas(competitor_titles)
    listed = "\n".join(f"- {t}" for t in competitor_titles[:10]) or "- (none captured)"
    return (
        "SERP COMPETITOR TITLE ANALYSIS (mandatory):\n"
        f"{summary}\n"
        "Live competitor titles:\n"
        f"{listed}\n"
        "Write titles that DELIBERATELY BREAK the dominant SERP formula so they stand out in "
        "results and AI overviews — same intent and keyword coverage, different visual shape.\n"
    )


def format_cluster_planning_title_guardrail_system_appendix(
    *,
    serp_results: list[dict[str, Any]] | None,
) -> str:
    competitors = extract_competitor_titles_from_serp(serp_results)
    return (
        "\n\n# MANDATORY: HUMAN-CURATED TITLE GUARDRAIL (Topic Cluster / Strategy Map)\n"
        "Eliminate generic, predictable, formulaic AI title structures from pillar headers and "
        "cluster topic names. Do NOT change keyword lists or focus-keyphrase fields.\n\n"
        f"{format_title_ban_list_for_prompt()}\n"
        f"{format_pillar_title_constraints()}\n"
        f"{format_cluster_title_constraints()}\n"
        f"{format_competitor_pattern_breaking_block(competitors)}\n"
    )


def format_research_curation_title_guardrail_system_appendix(
    *,
    serp_blobs: list[dict[str, Any]] | None,
) -> str:
    competitors = extract_competitor_titles_from_serp(serp_blobs)
    return (
        "\n\n# MANDATORY: HUMAN-CURATED TITLE GUARDRAIL (Research Curation)\n"
        "Article idea titles must sound editor-picked, not auto-generated SEO templates.\n\n"
        f"{format_title_ban_list_for_prompt()}\n"
        f"{format_cluster_title_constraints()}\n"
        f"{format_competitor_pattern_breaking_block(competitors)}\n"
        "- Each idea title must differ structurally from the others in the batch.\n"
    )


def apply_cluster_map_title_guardrails(
    derived: dict[str, Any],
    *,
    seed_intent: str,
) -> dict[str, Any]:
    """Post-process LLM cluster map titles with scrub + semantic fallback."""
    pillar = dict(derived.get("pillar") or {})
    clusters = [dict(c) for c in (derived.get("clusters") or []) if isinstance(c, dict)]
    seed = _normalize_title(seed_intent)

    pillar_kw = seed
    p_kws = pillar.get("keywords")
    if isinstance(p_kws, list) and p_kws:
        pillar_kw = _normalize_title(str(p_kws[0])) or seed

    if pillar:
        pillar["title"] = humanize_planning_title(
            str(pillar.get("title") or ""),
            role="pillar",
            keyword_fallback=pillar_kw or seed,
        )

    for c in clusters:
        fk = _normalize_title(str(c.get("intent") or ""))
        kws = c.get("keywords")
        if isinstance(kws, list) and kws:
            fk = _normalize_title(str(kws[0])) or fk
        c["title"] = humanize_planning_title(
            str(c.get("title") or ""),
            role="cluster",
            keyword_fallback=fk or seed,
        )

    return {"pillar": pillar, "clusters": clusters}


def apply_research_idea_title_guardrails(
    ideas: list[dict[str, Any]],
    *,
    seed_keywords: list[str] | None,
) -> list[dict[str, Any]]:
    """Post-process research idea titles; preserve focus_keyphrase + keywords untouched."""
    seeds = [_normalize_title(str(k)) for k in (seed_keywords or []) if str(k).strip()]
    default_kw = seeds[0] if seeds else "topic"
    out: list[dict[str, Any]] = []
    for it in ideas:
        row = dict(it)
        fk = _normalize_title(str(row.get("focus_keyphrase") or "")) or default_kw
        row["title"] = humanize_planning_title(
            str(row.get("title") or ""),
            role="research",
            keyword_fallback=fk,
        )
        out.append(row)
    return out
