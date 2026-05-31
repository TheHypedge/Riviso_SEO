"""
RIVISO natural polish — varied rhythm without template filler (all industries).
"""
from __future__ import annotations

import hashlib
import re
from typing import Iterable

from app.services.riviso_grammar_engine import run_grammar_pipeline
from app.services.riviso_linguistics import (
    _LONG_WORD_CHARS,
    _WS_RE,
    _split_sentences,
    compute_linguistic_metrics,
)
from app.services.riviso_paraphrase_engine import paraphrase_block, scrub_ai_markers

_WORD = re.compile(r"\b[\w']+\b")
_HEADING_RE = re.compile(r"^#{1,6}\s")

_SHORT_WORD_SWAP: dict[str, str] = {
    "organizations": "teams",
    "organization": "team",
    "utilize": "use",
    "utilizes": "uses",
    "leverage": "use",
    "leverages": "uses",
    "comprehensive": "full",
    "facilitate": "help",
    "facilitates": "helps",
    "implementation": "setup",
    "operational": "day-to-day",
    "collaboration": "teamwork",
    "approximately": "about",
    "demonstrate": "show",
    "demonstrates": "shows",
    "significant": "major",
    "substantial": "solid",
    "strategies": "plans",
    "strategy": "plan",
    "solutions": "tools",
    "solution": "tool",
    "navigate": "handle",
    "understanding": "knowing",
}

_CONTRACTIONS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bit is\b", re.I), "it's"),
    (re.compile(r"\bthat is\b", re.I), "that's"),
    (re.compile(r"\bthey are\b", re.I), "they're"),
    (re.compile(r"\bwe are\b", re.I), "we're"),
    (re.compile(r"\byou are\b", re.I), "you're"),
    (re.compile(r"\bdo not\b", re.I), "don't"),
    (re.compile(r"\bdoes not\b", re.I), "doesn't"),
    (re.compile(r"\bcannot\b", re.I), "can't"),
    (re.compile(r"\bwill not\b", re.I), "won't"),
]


def _split_long_sentences_only(text: str, max_words: int = 26) -> str:
    """Split run-on sentences only — never inject template punch lines."""
    parts: list[str] = []
    for sent in _split_sentences(text):
        words = sent.split()
        if len(words) <= max_words:
            parts.append(sent)
            continue
        split_done = False
        for sep in (r";\s+", r",\s+(?=[a-z])", r"\s+—\s+", r"\s+but\s+", r"\s+because\s+", r"\s+and\s+"):
            chunks = re.split(sep, sent, maxsplit=1, flags=re.I)
            if len(chunks) == 2 and len(chunks[0].split()) >= 10:
                a = chunks[0].strip().rstrip(",") + "."
                b = chunks[1].strip()
                if b and b[0].islower():
                    b = b[0].upper() + b[1:]
                if not b.endswith((".", "!", "?")):
                    b += "."
                parts.extend([a, b])
                split_done = True
                break
        if not split_done:
            parts.append(sent)
    return " ".join(p.strip() for p in parts if p.strip())


def _shorten_long_words(text: str, protected: set[str]) -> str:
    def repl(m: re.Match[str]) -> str:
        w = m.group(0)
        low = w.lower()
        if low in protected or len(w) < _LONG_WORD_CHARS:
            return w
        alt = _SHORT_WORD_SWAP.get(low)
        if not alt:
            return w
        return alt.capitalize() if w[0].isupper() else alt

    return _WORD.sub(repl, text)


def _apply_contractions(text: str) -> str:
    out = text
    for pat, repl in _CONTRACTIONS:
        out = pat.sub(repl, out)
    return out


def _stable_pick(key: str, options: tuple[str, ...]) -> str:
    if not options:
        return key
    h = int(hashlib.md5(key.encode("utf-8")).hexdigest(), 16)
    return options[h % len(options)]


def _naturalize_function_words_once(text: str) -> str:
    """One light lead-in with articles/prepositions — never stacked."""
    metrics = compute_linguistic_metrics(text)
    if metrics.get("function_word_ratio", 0) >= 0.38:
        return text
    sents = _split_sentences(text)
    if not sents:
        return text
    lead = sents[0]
    low = lead.lower()
    if low.startswith(("for ", "in ", "on ", "when ", "if ", "the ")):
        return text
    prefix = _stable_pick(
        text[:24],
        ("For most readers, ", "In practice, ", "On many matters, "),
    )
    if lead and lead[0].isupper():
        sents[0] = prefix + lead[0].lower() + lead[1:]
    else:
        sents[0] = prefix + lead
    return " ".join(sents)


def _add_one_short_sentence_if_needed(text: str) -> str:
    """At most one short sentence for rhythm (not repeated templates)."""
    metrics = compute_linguistic_metrics(text)
    if metrics.get("burstiness", 0) >= 0.3 or metrics.get("sentence_count", 0) < 2:
        return text
    sents = _split_sentences(text)
    for i, sent in enumerate(sents):
        if len(sent.split()) > 16:
            bridge = _stable_pick(
                sent[:20],
                ("That detail matters.", "Timing often counts.", "Costs can add up fast."),
            )
            return " ".join(sents[: i + 1] + [bridge] + sents[i + 1 :])
    return text


def _vary_openers(text: str) -> str:
    """Reduce same-sentence-starter repetition (common AI tell)."""
    sents = _split_sentences(text)
    if len(sents) < 3:
        return text
    starters = [s.split()[0].lower() if s.split() else "" for s in sents]
    out: list[str] = []
    prev_starter = ""
    for i, sent in enumerate(sents):
        s = sent
        starter = starters[i]
        if starter == prev_starter and len(s.split()) > 8:
            if starter in {"the", "this", "it", "in", "a"}:
                s = re.sub(r"^The\s+", "For many readers, the ", s, count=1)
            elif starter == "if":
                s = re.sub(r"^If\s+", "When ", s, count=1, flags=re.I)
        out.append(s)
        prev_starter = starter
    return " ".join(out)


def polish_paragraph_natural(
    text: str,
    *,
    protected_terms: Iterable[str] | None = None,
    strength: float = 0.76,
) -> str:
    """Light natural polish: paraphrase, split long lines, contractions — no filler spam."""
    raw = (text or "").strip()
    if not raw or len(raw.split()) < 4:
        return raw
    if _HEADING_RE.match(raw):
        return run_grammar_pipeline(raw)

    protected: set[str] = set()
    if protected_terms:
        for term in protected_terms:
            t = (term or "").strip().lower()
            if t:
                protected.add(t)
                for part in t.split():
                    if len(part) > 3:
                        protected.add(part)

    out = paraphrase_block(raw, strength=strength, protected_terms=protected_terms)
    out = scrub_ai_markers(out)
    out = _split_long_sentences_only(out)
    out = _vary_openers(out)
    out = _naturalize_function_words_once(out)
    out = _add_one_short_sentence_if_needed(out)

    metrics = compute_linguistic_metrics(out)
    if metrics.get("mean_word_length", 0) > 5.5 or metrics.get("long_word_pct", 0) > 27:
        out = _shorten_long_words(out, protected)

    out = _apply_contractions(out)
    out = run_grammar_pipeline(_WS_RE.sub(" ", out).strip())
    return out


# Back-compat alias used by older imports
shape_paragraph_human_profile = polish_paragraph_natural
