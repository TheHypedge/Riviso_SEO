"""
RIVISO Grammatical Engine — post-humanization cleanup (internal, no external APIs).

Fixes broken phrasing from structural edits: duplicates, orphans, punctuation, casing.
"""
from __future__ import annotations

import re

_WS = re.compile(r"\s+")
_MULTI_SPACE = re.compile(r" {2,}")
_DUPE_WORD = re.compile(r"\b(\w+)\s+\1\b", re.IGNORECASE)
_DUPE_PHRASE_2 = re.compile(r"\b([\w']+(?:\s+[\w']+){1,2})\s+\1\b", re.IGNORECASE)
_DUPE_PHRASE_3 = re.compile(r"\b([\w']+(?:\s+[\w']+){2,3})\s+\1\b", re.IGNORECASE)

# Broken injections / duplicates from legacy humanizer
_WHICH_MEANS_LOOP = re.compile(r"(?:\bwhich means\s+)+", re.IGNORECASE)
_ORPHAN_VERB_FRAGMENT = re.compile(
    r"\.\s+([A-Z][a-z]{3,14})\.\s+(?=[A-Z])",
)
_SPACE_BEFORE_PUNCT = re.compile(r"\s+([,.;:!?])")
_PUNCT_RUN = re.compile(r"([,.!?]){2,}")
_DOT_LOWERCASE = re.compile(r"\.\s+([a-z])")
_HYPHEN_SPACE = re.compile(r"\s+-\s+")
_BROKEN_LIST_JOIN = re.compile(r"\.\s+-\s+")

# AI filler remnants to strip in grammar pass
_FILLER_TAIL = re.compile(
    r"\b(?:which means|in order to|due to the fact that|at this point in time)\b",
    re.IGNORECASE,
)

# Template lines the old humanizer injected — strip entirely
_AI_FILLER_LINE = re.compile(
    r"(?:^|\.\s+)(?:Simple as that\.|That matters\.|Worth noting\.|Keep this in mind\.|"
    r"Worth a look\.|Good to know\.|Makes sense\.|Simple enough\.|That helps\.)\s*",
    re.IGNORECASE,
)
_STACKED_FILLER = re.compile(
    r"(?:\b(?:Simple as that|Keep this in mind|Worth noting|That matters|if you're weighing this|"
    r"In the real world)\b[.\s]*){2,}",
    re.IGNORECASE,
)
_WEIGHING_THIS = re.compile(r"\bif you're weighing this,?\s*", re.I)
_IN_REAL_WORLD = re.compile(r"\bIn the real world,\s*", re.I)
_TEAMS_NOTICE = re.compile(r",\s*and that is what most teams notice\.?", re.I)


def _collapse_ws(text: str) -> str:
    return _WS.sub(" ", (text or "").strip())


def remove_duplicate_words(text: str) -> str:
    out = text
    for _ in range(8):
        n = _DUPE_WORD.sub(r"\1", out)
        if n == out:
            break
        out = n
    return out


def remove_ai_filler_spam(text: str) -> str:
    """Remove stacked template punch-lines and legacy humanizer injections."""
    out = text
    for _ in range(12):
        n = _AI_FILLER_LINE.sub(". ", out)
        n = _STACKED_FILLER.sub(" ", n)
        n = re.sub(r"(?:\.\s*){2,}", ". ", n)
        if n == out:
            break
        out = n
    while True:
        n = _WEIGHING_THIS.sub("", out, count=1)
        if n == out:
            break
        out = n
    while True:
        n = _IN_REAL_WORLD.sub("", out, count=1)
        if n == out:
            break
        out = n
    out = _TEAMS_NOTICE.sub("", out)
    return _collapse_ws(out)


def dedupe_sentences(text: str) -> str:
    """Drop consecutive or over-repeated identical sentences (any length)."""
    sents = re.split(r"(?<=[.!?])\s+", text)
    if len(sents) < 2:
        return text
    kept: list[str] = []
    prev_key = ""
    counts: dict[str, int] = {}
    for sent in sents:
        s = sent.strip()
        if not s:
            continue
        key = re.sub(r"\s+", " ", s.lower())
        if key == prev_key:
            continue
        counts[key] = counts.get(key, 0) + 1
        max_allowed = 1 if len(key.split()) <= 10 else 2
        if counts[key] > max_allowed:
            continue
        kept.append(s)
        prev_key = key
    return " ".join(kept)


def remove_duplicate_phrases(text: str) -> str:
    out = text
    for pat in (_DUPE_PHRASE_3, _DUPE_PHRASE_2):
        for _ in range(6):
            n = pat.sub(r"\1", out)
            if n == out:
                break
            out = n
    out = _WHICH_MEANS_LOOP.sub("which means ", out)
    out = re.sub(r"\bwhich means\s+which\b", "which", out, flags=re.IGNORECASE)
    return out


def fix_hyphen_artifacts(text: str) -> str:
    out = re.sub(r"\b(\w+)-\1\b", r"\1", text, flags=re.IGNORECASE)
    out = re.sub(r"-law-law\b", " law", out, flags=re.IGNORECASE)
    out = re.sub(r"\bhandling with\b", "dealing with", out, flags=re.IGNORECASE)
    out = re.sub(r"\blegal support issues\b", "legal representation", out, flags=re.IGNORECASE)
    out = re.sub(r"\bIt you should\b", "You should", out, flags=re.IGNORECASE)
    out = re.sub(r"\bIt you need\b", "You need", out, flags=re.IGNORECASE)
    out = re.sub(r"\b(\w+) supports organizations\b", r"\1 help organizations", out, flags=re.IGNORECASE)
    out = re.sub(r"\bsolutions helps\b", "solutions help", out, flags=re.IGNORECASE)
    out = re.sub(r"\btools helps\b", "tools help", out, flags=re.IGNORECASE)
    out = re.sub(r"\b(\w+) help teams\b", r"\1 helps teams", out, flags=re.IGNORECASE)
    out = re.sub(r"\bapply wrap up\b", "use complete", out, flags=re.IGNORECASE)
    out = re.sub(r"\bproduce sure\b", "make sure", out, flags=re.IGNORECASE)
    out = re.sub(r"\boperates top for\b", "drives", out, flags=re.IGNORECASE)
    out = re.sub(r"\bplay a crucial role\b", "matter", out, flags=re.IGNORECASE)
    out = re.sub(r"\bThis piece look at\b", "This piece looks at", out, flags=re.IGNORECASE)
    out = re.sub(r"\bThis overview look at\b", "This overview looks at", out, flags=re.IGNORECASE)
    return out


def fix_punctuation(text: str) -> str:
    out = text
    out = _SPACE_BEFORE_PUNCT.sub(r"\1", out)
    out = _PUNCT_RUN.sub(r"\1", out)
    out = re.sub(r",\s*,", ",", out)
    out = re.sub(r"\.\s*\.", ".", out)
    out = _BROKEN_LIST_JOIN.sub(" - ", out)
    out = _HYPHEN_SPACE.sub(" - ", out)
    # Single-letter sentence fragments after period (e.g. ". Checking. Confirming")
    out = re.sub(
        r"\.\s+([A-Z][a-z]{2,12})\.\s+",
        ". ",
        out,
    )
    return out


def fix_sentence_casing(text: str) -> str:
    """Capitalize after sentence-ending punctuation."""
    parts = re.split(r"(\.\s+|\!\s+|\?\s+)", text)
    if len(parts) == 1:
        t = text.strip()
        if t and t[0].islower():
            return t[0].upper() + t[1:]
        return text

    out: list[str] = []
    for i, part in enumerate(parts):
        if i == 0:
            p = part.strip()
            if p and p[0].islower():
                p = p[0].upper() + p[1:]
            out.append(p)
        elif re.match(r"^[.!?]\s+$", part):
            out.append(part)
        else:
            p = part.strip()
            if p and p[0].islower():
                p = p[0].upper() + p[1:]
            out.append((" " if out else "") + p)
    return "".join(out).strip()


def trim_filler_phrases(text: str) -> str:
    out = _FILLER_TAIL.sub("", text)
    out = re.sub(r"\s+,", ",", out)
    out = re.sub(r",\s*,", ",", out)
    out = re.sub(r"\s+\.", ".", out)
    return _collapse_ws(out)


def fix_comma_splices_light(text: str) -> str:
    """Replace only egregious ', and , which means' style breaks."""
    out = re.sub(r",\s*which means\s*,", ",", text, flags=re.IGNORECASE)
    out = re.sub(r",\s*which means\b", "", out, flags=re.IGNORECASE)
    return out


def validate_sentence_integrity(text: str) -> str:
    """
    Drop ultra-short orphan 'sentences' that are likely artifacts (1-2 words between periods).
    Keep legitimate short sentences like 'Yes.' or 'It matters.'
    """
    sents = re.split(r"(?<=[.!?])\s+", text)
    if len(sents) < 3:
        return text

    kept: list[str] = []
    for sent in sents:
        words = [w for w in re.split(r"[^\w']+", sent) if w]
        if len(words) <= 2 and len(sents) > 2:
            # merge orphan into previous if previous exists
            if kept:
                prev = kept[-1].rstrip(".!?")
                kept[-1] = f"{prev} {sent.strip()}".strip()
                continue
        kept.append(sent.strip())
    return " ".join(kept)


def run_grammar_pipeline(text: str) -> str:
    """Full RIVISO grammatical pass on a paragraph or line."""
    if not (text or "").strip():
        return text or ""

    raw = text
    # Preserve leading markdown heading markers / list prefix on first line
    list_m = re.match(r"^(\s*[-*•]\s+)(.*)$", raw)
    heading_m = re.match(r"^(#{1,6}\s+)(.*)$", raw)

    prefix = ""
    body = raw
    if list_m:
        prefix, body = list_m.group(1), list_m.group(2)
    elif heading_m:
        prefix, body = heading_m.group(1), heading_m.group(2)

    out = body
    out = remove_ai_filler_spam(out)
    out = trim_filler_phrases(out)
    out = dedupe_sentences(out)
    out = fix_hyphen_artifacts(out)
    out = remove_duplicate_phrases(out)
    out = remove_duplicate_words(out)
    out = fix_comma_splices_light(out)
    out = fix_punctuation(out)
    out = validate_sentence_integrity(out)
    out = fix_sentence_casing(out)
    out = _collapse_ws(out)
    out = _MULTI_SPACE.sub(" ", out)

    return f"{prefix}{out}".strip() if prefix else out
