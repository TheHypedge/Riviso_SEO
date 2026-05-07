"""
Sanitize generated/edited article content so that SEO meta fields, AI preamble,
and other generic AI commentary never leak into the published body.

The goal of this module is to keep the article body free of:
- ``Meta Title``, ``Meta Description``, ``SEO Title`` blocks
- ``Focus Keyphrase``, ``Keywords``, ``Tags``, ``Slug`` lines
- ``AI suggested keywords``, ``Recommended keywords`` blocks
- Generic AI preamble/postamble (``Here's the article…``, ``Let me know if…``,
  ``As an AI language model…``)
- Stray code fences that wrap the entire article (e.g. ```` ```html ... ``` ````)

It also normalizes ``meta_title`` and ``meta_description`` strings by stripping
any leading ``Meta Title:`` / ``Meta Description:`` echo and surrounding quotes.

Sanitization is best-effort and conservative — it only removes lines that match
well-known patterns at line starts, so legitimate inline mentions of the word
"keyword" inside a paragraph are kept.
"""

from __future__ import annotations

import re

__all__ = [
    "sanitize_article_body",
    "sanitize_meta_title",
    "sanitize_meta_description",
    "sanitize_generation_bundle",
]

# Lines that look like SEO/meta blocks at the start of a line — these get dropped.
_BANNED_LINE_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE) for p in (
        # Meta / SEO heading-style lines
        r"^\s*(?:[#>*\-]+\s*)?\**\s*(?:meta\s*title|seo\s*title|seo\s*meta\s*title)\s*\**\s*[:\-—–]",
        r"^\s*(?:[#>*\-]+\s*)?\**\s*(?:meta\s*description|seo\s*description|seo\s*meta\s*description)\s*\**\s*[:\-—–]",
        r"^\s*(?:[#>*\-]+\s*)?\**\s*(?:focus\s*keyphrase|focus\s*keyword|seo\s*keyphrase|primary\s*keyword)\s*\**\s*[:\-—–]",
        r"^\s*(?:[#>*\-]+\s*)?\**\s*(?:keywords?|target(?:ed|ing)?\s*keywords?|seo\s*keywords?|tags?|categor(?:y|ies))\s*\**\s*[:\-—–]",
        r"^\s*(?:[#>*\-]+\s*)?\**\s*(?:ai[\s\-]*(?:suggested|recommended|generated)\s*keywords?|suggested\s*keywords?|recommended\s*keywords?|keyword\s*suggestions?)\s*\**\s*[:\-—–]?",
        r"^\s*(?:[#>*\-]+\s*)?\**\s*(?:slug|permalink|url[\s-]*slug)\s*\**\s*[:\-—–]",
        r"^\s*(?:[#>*\-]+\s*)?\**\s*(?:excerpt|summary|description)\s*\**\s*[:\-—–]\s*$",
        # Heading-only SEO sections (e.g. "## SEO Information")
        r"^\s*#{1,6}\s*(?:seo\s*(?:information|details|metadata|meta)|meta\s*(?:information|details|fields))\s*$",
        # Generic AI preamble/postamble
        r"^\s*(?:sure|certainly|of\s*course|absolutely|great)[,!\.\s].{0,120}$",
        r"^\s*here(?:'|’|\s+i)s\s+(?:the|your|a)\s+(?:article|content|blog\s*post|draft).{0,200}$",
        r"^\s*here\s+is\s+(?:the|your|a)\s+(?:article|content|blog\s*post|draft).{0,200}$",
        r"^\s*below\s+is\s+(?:the|your|a)\s+(?:article|content|draft).{0,200}$",
        r"^\s*i(?:'|’)?\s*ve\s+(?:written|created|drafted|prepared)\b.{0,200}$",
        r"^\s*i(?:'|’)?\s*ll\s+(?:write|create|draft|prepare)\b.{0,200}$",
        r"^\s*i\s+have\s+(?:written|created|drafted|prepared)\b.{0,200}$",
        r"^\s*as\s+an?\s+(?:ai|language\s*model|ai\s*language\s*model)\b.{0,200}$",
        r"^\s*i(?:'|’)?\s*m\s+an?\s+(?:ai|language\s*model)\b.{0,200}$",
        r"^\s*let\s+me\s+know\s+if\b.{0,200}$",
        r"^\s*feel\s+free\s+to\b.{0,200}$",
        r"^\s*i\s+hope\s+(?:this|the\s+article)\s+(?:helps|meets|works)\b.{0,200}$",
        r"^\s*please\s+let\s+me\s+know\b.{0,200}$",
        # JSON envelope echoes accidentally written into the body
        r"^\s*\"?article_markdown\"?\s*[:=]",
        r"^\s*\{?\s*\"meta_title\"\s*:",
        r"^\s*\"?meta_description\"?\s*[:=]",
    )
)

# Heading lines that introduce a forbidden block — when matched, drop the
# heading AND everything until the next heading / blank-line break.
_BANNED_SECTION_HEADINGS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE) for p in (
        r"^\s*#{1,6}\s*(?:meta\s*title|meta\s*description|seo\s*meta(?:data)?|seo\s*information|seo\s*details)\s*$",
        r"^\s*#{1,6}\s*(?:keywords?|tags?|categor(?:y|ies)|focus\s*keyphrase|focus\s*keyword)\s*$",
        r"^\s*#{1,6}\s*(?:ai[\s\-]*(?:suggested|recommended)\s*keywords?|suggested\s*keywords?|recommended\s*keywords?)\s*$",
    )
)

# Code fence patterns to strip when they wrap the whole article.
_CODE_FENCE_OPEN = re.compile(r"^\s*```[a-zA-Z0-9_+-]*\s*$")
_CODE_FENCE_CLOSE = re.compile(r"^\s*```\s*$")

# Quotes/colons we strip from the start of meta_title / meta_description.
_META_PREFIX = re.compile(
    r"^\s*(?:meta\s*title|meta\s*description|seo\s*title|seo\s*description|title|description)\s*[:\-—–]\s*",
    re.IGNORECASE,
)
_SURROUNDING_QUOTES = re.compile(r"^[\s\"'“”‘’`]+|[\s\"'“”‘’`]+$")


def _strip_outer_code_fence(text: str) -> str:
    """If the body is wrapped by a single ``` ... ``` block, strip the fences."""
    lines = text.splitlines()
    # Trim leading/trailing blank lines for fence detection.
    start = 0
    end = len(lines)
    while start < end and lines[start].strip() == "":
        start += 1
    while end > start and lines[end - 1].strip() == "":
        end -= 1
    if end - start < 2:
        return text
    if _CODE_FENCE_OPEN.match(lines[start]) and _CODE_FENCE_CLOSE.match(lines[end - 1]):
        return "\n".join(lines[start + 1 : end - 1])
    return text


def _is_blank(line: str) -> bool:
    return line.strip() == ""


def _line_is_banned(line: str) -> bool:
    return any(p.match(line) for p in _BANNED_LINE_PATTERNS)


def _line_starts_banned_section(line: str) -> bool:
    return any(p.match(line) for p in _BANNED_SECTION_HEADINGS)


def _line_is_heading(line: str) -> bool:
    s = line.lstrip()
    return s.startswith("#")


def sanitize_article_body(text: str | None) -> str:
    """Remove forbidden meta blocks and AI preamble from a generated/edited article body.

    The function preserves the rest of the document (paragraphs, lists, headings)
    untouched. It only drops lines that look like SEO meta fields, AI commentary,
    or whole sections that introduce such fields.
    """
    if not text:
        return ""

    raw = _strip_outer_code_fence(str(text))
    lines = raw.splitlines()
    cleaned: list[str] = []

    skip_section = False
    for line in lines:
        # Are we inside a forbidden section started by a heading?
        if skip_section:
            if _line_is_heading(line) and not _line_starts_banned_section(line):
                skip_section = False
                # fall through to evaluate this heading line normally
            else:
                continue

        # Heading that starts a banned section? Begin skipping.
        if _line_starts_banned_section(line):
            skip_section = True
            continue

        # Banned line patterns (single-line meta echoes / preamble).
        if _line_is_banned(line):
            continue

        cleaned.append(line)

    # Trim leading and trailing blank lines and collapse 3+ blank lines to 2.
    out: list[str] = []
    blank_run = 0
    for ln in cleaned:
        if _is_blank(ln):
            blank_run += 1
            if blank_run > 2:
                continue
        else:
            blank_run = 0
        out.append(ln)
    while out and _is_blank(out[0]):
        out.pop(0)
    while out and _is_blank(out[-1]):
        out.pop()

    return "\n".join(out)


def _strip_meta_string(text: str | None) -> str:
    if not text:
        return ""
    s = str(text).strip()
    # Drop wrapping code fences (rare).
    if s.startswith("```") and s.endswith("```"):
        s = s[3:-3].strip()
    # Drop a single "Meta Title: ..." prefix if the model echoed it.
    s = _META_PREFIX.sub("", s, count=1)
    # Strip surrounding quotes / smart quotes / backticks.
    s = _SURROUNDING_QUOTES.sub("", s)
    # Collapse internal whitespace.
    s = re.sub(r"\s+", " ", s).strip()
    return s


def sanitize_meta_title(text: str | None, *, max_len: int = 160) -> str:
    """Normalize an SEO meta title — drop ``Meta Title:`` echoes, quotes, length cap."""
    s = _strip_meta_string(text)
    return s[:max_len].strip()


def sanitize_meta_description(text: str | None, *, max_len: int = 320) -> str:
    """Normalize an SEO meta description — drop echoes, quotes, length cap."""
    s = _strip_meta_string(text)
    return s[:max_len].strip()


def sanitize_generation_bundle(bundle: dict) -> dict:
    """Sanitize the dict returned by ``generate_article_bundle`` in-place and return it."""
    if not isinstance(bundle, dict):
        return bundle
    if "article" in bundle:
        bundle["article"] = sanitize_article_body(bundle.get("article"))
    if "meta_title" in bundle:
        bundle["meta_title"] = sanitize_meta_title(bundle.get("meta_title"))
    if "meta_description" in bundle:
        bundle["meta_description"] = sanitize_meta_description(bundle.get("meta_description"))
    return bundle
