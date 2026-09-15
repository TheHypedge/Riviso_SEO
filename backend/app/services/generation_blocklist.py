"""
Banned phrases for AI article generation.

Operators can extend the built-in list via ``GENERATION_BANNED_PHRASES`` (comma-separated)
in the environment. Phrases are enforced in the system prompt and stripped from output
(headings, parentheticals, and inline labels) during sanitization.
"""

from __future__ import annotations

import re
from functools import lru_cache

from app.core.config import settings

# Built-in defaults — always active; env adds more (does not replace these).
DEFAULT_GENERATION_BANNED_PHRASES: tuple[str, ...] = (
    "aeo-optimized",
    "aeo optimized",
    "aeo-friendly",
    "aeo friendly",
    "for aeo",
    "answer engine optimization",
    "geo-optimized",
    "geo optimized",
    "llm-optimized",
    "llm optimized",
    "ai suggested keywords",
    "ai-suggested keywords",
    "ai recommended keywords",
    "ai-generated keywords",
    "suggested keywords",
    "recommended keywords",
    "keyword suggestions",
    "seo-optimized faq",
    "optimized for aeo",
    "optimized for geo",
    "optimized for llms",
    "written for ai",
    "ai-optimized",
    "ai optimized",
    "elevate your wardrobe",
    "effortless charm",
    "personality and flair",
    "transform your look",
    "in practice,",
    "let's dive in",
    "game-changer",
)


def _parse_env_phrases(raw: str) -> list[str]:
    out: list[str] = []
    for part in (raw or "").replace("\n", ",").split(","):
        p = part.strip()
        if p and p not in out:
            out.append(p)
    return out


@lru_cache(maxsize=1)
def get_generation_banned_phrases() -> tuple[str, ...]:
    """Merged built-in + env phrases (lowercased for matching, original casing kept for prompt)."""
    merged: list[str] = []
    seen: set[str] = set()
    for p in list(DEFAULT_GENERATION_BANNED_PHRASES) + _parse_env_phrases(settings.generation_banned_phrases):
        key = p.strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(p.strip())
    return tuple(merged)


def _phrase_to_flexible_pattern(phrase: str) -> str:
    """Allow hyphen/space variants when matching (e.g. aeo-optimized vs aeo optimized)."""
    parts = [re.escape(x) for x in re.split(r"[\s\-–—]+", phrase.strip()) if x]
    if not parts:
        return re.escape(phrase)
    return r"[\s\-–—]*".join(parts)


def format_banned_phrases_for_prompt(phrases: tuple[str, ...] | None = None) -> str:
    """System-prompt block listing forbidden labels and parentheticals."""
    items = phrases or get_generation_banned_phrases()
    if not items:
        return ""
    display = [p for p in items[:40]]
    bullets = "\n".join(f"- {p}" for p in display)
    extra = ""
    if len(items) > 40:
        extra = f"\n- …and {len(items) - 40} more configured phrases"
    return (
        "\nFORBIDDEN LABELS (never use in headings, section titles, parentheticals, or body copy):\n"
        f"{bullets}{extra}\n"
        "- Do NOT tag headings with optimization hints in parentheses or brackets "
        '(e.g. avoid "(AEO-Optimized)", "[AI Suggested Keywords]", "(SEO FAQ)").\n'
        "- Write natural reader-facing headings only; never expose internal SEO/AEO workflow labels.\n"
    )


_PAREN_GROUP = re.compile(r"[\(\[\{]([^)\]\}]{0,120})[\)\]\}]")


def strip_banned_phrases_from_text(text: str | None, phrases: tuple[str, ...] | None = None) -> str:
    """
    Remove banned phrases and parenthetical/bracket groups that contain them.

    Example: ``Frequently Asked Questions (AEO-Optimized)`` → ``Frequently Asked Questions``.
    """
    if not text:
        return ""
    items = phrases or get_generation_banned_phrases()
    if not items:
        return str(text).strip()

    out = str(text)

    def _group_has_banned(inner: str) -> bool:
        low = inner.lower()
        return any(p.lower() in low for p in items)

    # Drop parenthetical/bracket groups that mention a banned phrase.
    for _ in range(8):
        prev = out

        def _repl(m: re.Match[str]) -> str:
            return "" if _group_has_banned(m.group(1)) else m.group(0)

        out = _PAREN_GROUP.sub(_repl, out)
        if out == prev:
            break

    for phrase in items:
        if not phrase:
            continue
        core = _phrase_to_flexible_pattern(phrase)
        out = re.sub(core, "", out, flags=re.IGNORECASE)

    # Cleanup spacing and orphaned punctuation after removals.
    out = re.sub(r"\s{2,}", " ", out)
    out = re.sub(r"\s+([,.;:!?])", r"\1", out)
    out = re.sub(r"\(\s*\)", "", out)
    out = re.sub(r"\[\s*\]", "", out)
    return out.strip()


def strip_em_dashes(text: str | None) -> str:
    """Hard guarantee against em dashes (—) in any AI-generated text.

    The system prompt for every generation path already instructs the model to
    never use them, but LLMs sometimes ignore that instruction — this is the
    last-resort backstop. A leading/trailing em dash is dropped outright (a
    replacement hyphen there would just read as a stray bullet fragment);
    a mid-string one becomes " - ", matching the prompt's own suggested substitute.
    """
    if not text:
        return text or ""
    s = str(text)
    s = re.sub(r"^\s*—\s*", "", s)
    s = re.sub(r"\s*—\s*$", "", s)
    s = re.sub(r"\s*—\s*", " - ", s)
    s = re.sub(r"\s{2,}", " ", s)
    return s.strip()


def sanitize_line_banned_phrases(line: str) -> str:
    """Strip banned phrases from a single markdown line (preserves leading heading markers)."""
    if not line.strip():
        return line
    m = re.match(r"^(\s*(?:#{1,6}\s+)?)(.*)$", line)
    if not m:
        return strip_em_dashes(strip_banned_phrases_from_text(line))
    prefix, body = m.group(1), m.group(2)
    cleaned = strip_em_dashes(strip_banned_phrases_from_text(body))
    return f"{prefix}{cleaned}".rstrip()
