"""
RIVISO proprietary linguistic analysis & structural humanization (no external LLM APIs).
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

_SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
_WS_RE = re.compile(r"\s+")
_HEADING_RE = re.compile(r"^#{1,6}\s")

# Editorial corpus benchmarks (internal Riviso profiles)
_HUMAN_AVG_SENT_LEN = 23.2
_AI_AVG_SENT_LEN = 29.2
_HUMAN_VERY_LONG_PCT = 6.2
_AI_VERY_LONG_PCT = 17.0
_HUMAN_VERY_SHORT_PCT = 5.8
_AI_VERY_SHORT_PCT = 2.4
_HUMAN_LONG_WORD_PCT = 23.1
_AI_LONG_WORD_PCT = 30.7
_HUMAN_MEAN_WORD_LEN = 5.24
_AI_MEAN_WORD_LEN = 5.86
_HUMAN_FUNCTION_RATIO = 0.40
_AI_FUNCTION_RATIO = 0.33

_VERY_LONG_WORDS = 40
_VERY_SHORT_WORDS = 8
_LONG_WORD_CHARS = 8

_FUNCTION_WORDS = frozenset(
    """
    a an the and or but if while because although though as at by for from in into of on onto
    to with without within over under about after before between through during is are was were
    be been being am have has had do does did will would could should may might must can shall
    that which who whom whose this these those it its they them their we our you your he she his
    her not no nor so than then also just only even still yet already
    """.split()
)

_AI_MARKERS = [
    "delve",
    "testament",
    "moreover",
    "furthermore",
    "additionally",
    "in summary",
    "in conclusion",
    "it is important to note",
    "it is worth noting",
    "plays a crucial role",
    "plays a vital role",
    "comprehensive guide",
    "designed to help",
    "navigate the complexities",
    "landscape of",
    "emerging trends",
    "key legal takeaways",
    "conceptual overview",
    "robust",
    "leverage",
    "utilize",
    "foster",
    "tapestry",
    "seamlessly",
    "holistic",
    "myriad",
    "plethora",
    "underscores",
    "paramount",
    "staying informed",
    "ensuring protection",
    "elevate your",
    "personality and flair",
    "effortless charm",
    "wonderful way",
    "transform your look",
    "signature piece",
    "in practice,",
    "at its core",
    "game-changer",
    "watch how it",
    "take your style to the next level",
    "unlock the potential",
    "offers a wonderful",
]

_AI_HEADING_PATTERNS = [
    re.compile(r"^conceptual overview\b", re.I),
    re.compile(r"^key legal takeaways\b", re.I),
    re.compile(r"^emerging trends\b", re.I),
    re.compile(r"^judicial interpretation\b", re.I),
    re.compile(r"^procedural aspects\b", re.I),
]

_FORMAL_TRIM = [
    (re.compile(r"\bfurthermore,?\s*", re.I), ""),
    (re.compile(r"\badditionally,?\s*", re.I), ""),
    (re.compile(r"\bmoreover,?\s*", re.I), ""),
    (re.compile(r"\bit is important to note that\s*", re.I), ""),
    (re.compile(r"\bit is worth noting that\s*", re.I), ""),
    (re.compile(r"\bin today's digital landscape,?\s*", re.I), ""),
    (re.compile(r"\bplays a (?:crucial|vital) role in\b", re.I), "matters for"),
    (re.compile(r"\bdesigned to help\b", re.I), "helps"),
    (re.compile(r"\bnavigate the complexities of\b", re.I), "work through"),
    (re.compile(r"\bstaying informed about emerging trends\b", re.I), "keeping up with changes"),
    (re.compile(r"\bensuring protection of\b", re.I), "protecting"),
]

_STARTER_REPLACEMENTS = [
    (re.compile(r"^This demonstrates that\b", re.I), "That shows"),
    (re.compile(r"^It is essential to\b", re.I), "You need to"),
    (re.compile(r"^Choosing the right\b", re.I), "Picking the right"),
    (re.compile(r"^These judgments highlight\b", re.I), "Courts have stressed"),
]


def _tokens(text: str) -> list[str]:
    return [w.lower() for w in re.split(r"[^\w']+", text or "") if w]


def _split_sentences(text: str) -> list[str]:
    s = _WS_RE.sub(" ", (text or "").strip())
    if not s:
        return []
    return [x.strip() for x in _SENT_SPLIT_RE.split(s) if x.strip()]


def compute_linguistic_metrics(text: str) -> dict[str, float]:
    """Document/paragraph-level Riviso linguistic profile."""
    sents = _split_sentences(text)
    words: list[str] = []
    long_word_count = 0
    char_sum = 0
    function_count = 0

    for w in _tokens(text):
        words.append(w)
        if len(w) >= _LONG_WORD_CHARS:
            long_word_count += 1
        char_sum += len(w)
        if w in _FUNCTION_WORDS:
            function_count += 1

    wc = len(words) or 1
    sent_lens = [len(_tokens(s)) for s in sents if _tokens(s)]
    avg_sent = sum(sent_lens) / len(sent_lens) if sent_lens else 0.0
    very_long = sum(1 for n in sent_lens if n > _VERY_LONG_WORDS)
    very_short = sum(1 for n in sent_lens if n <= _VERY_SHORT_WORDS)
    n_sent = len(sent_lens) or 1

    return {
        "avg_sentence_length": round(avg_sent, 2),
        "very_long_sentence_pct": round(100.0 * very_long / n_sent, 2),
        "very_short_sentence_pct": round(100.0 * very_short / n_sent, 2),
        "long_word_pct": round(100.0 * long_word_count / wc, 2),
        "mean_word_length": round(char_sum / wc, 2),
        "function_word_ratio": round(function_count / wc, 3),
        "burstiness": round(_burstiness(sent_lens), 3),
        "sentence_count": float(len(sent_lens)),
        "word_count": float(wc),
    }


def _burstiness(sent_lens: list[int]) -> float:
    if len(sent_lens) < 2:
        return 0.0
    mean = sum(sent_lens) / len(sent_lens)
    if mean <= 0:
        return 0.0
    var = sum((x - mean) ** 2 for x in sent_lens) / (len(sent_lens) - 1)
    stdev = math.sqrt(max(0.0, var))
    return max(0.0, min(1.0, stdev / mean / 0.32))


def _cosine_tf(a: str, b: str) -> float:
    """Term-frequency cosine similarity for SEO / semantic preservation checks."""
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 1.0 if not ta and not tb else 0.0
    freq_a: dict[str, float] = {}
    freq_b: dict[str, float] = {}
    for w in ta:
        freq_a[w] = freq_a.get(w, 0.0) + 1.0
    for w in tb:
        freq_b[w] = freq_b.get(w, 0.0) + 1.0
    dot = sum(freq_a.get(k, 0.0) * freq_b.get(k, 0.0) for k in set(freq_a) | set(freq_b))
    na = math.sqrt(sum(v * v for v in freq_a.values()))
    nb = math.sqrt(sum(v * v for v in freq_b.values()))
    if na <= 0 or nb <= 0:
        return 0.0
    return max(0.0, min(1.0, dot / (na * nb)))


def _marker_hits(text: str) -> list[str]:
    low = (text or "").lower()
    return [m for m in _AI_MARKERS if m in low]


def _ai_profile_distance(metrics: dict[str, float]) -> float:
    """0 = human-like, 1 = AI-like (weighted distance from human benchmarks)."""
    parts: list[float] = []

    def band(val: float, human: float, ai: float) -> float:
        if ai == human:
            return 0.0
        t = (val - human) / (ai - human)
        return max(0.0, min(1.0, t))

    parts.append(band(metrics["avg_sentence_length"], _HUMAN_AVG_SENT_LEN, _AI_AVG_SENT_LEN))
    parts.append(band(metrics["very_long_sentence_pct"], _HUMAN_VERY_LONG_PCT, _AI_VERY_LONG_PCT))
    short_gap = max(0.0, _HUMAN_VERY_SHORT_PCT - metrics["very_short_sentence_pct"])
    parts.append(min(1.0, short_gap / max(_HUMAN_VERY_SHORT_PCT, 1.0)))
    parts.append(band(metrics["long_word_pct"], _HUMAN_LONG_WORD_PCT, _AI_LONG_WORD_PCT))
    parts.append(band(metrics["mean_word_length"], _HUMAN_MEAN_WORD_LEN, _AI_MEAN_WORD_LEN))
    func_gap = max(0.0, _HUMAN_FUNCTION_RATIO - metrics["function_word_ratio"])
    parts.append(min(1.0, func_gap / 0.15))
    parts.append(max(0.0, 1.0 - metrics["burstiness"]))

    return max(0.0, min(1.0, sum(parts) / len(parts)))


def analyze_paragraph_signals(text: str) -> tuple[float, list[dict[str, str]]]:
    """Return AI-likeness score in [0,1] and human-readable signals with excerpts."""
    metrics = compute_linguistic_metrics(text)
    score = _ai_profile_distance(metrics)
    signals: list[dict[str, str]] = []
    sents = _split_sentences(text)

    if metrics["avg_sentence_length"] >= 27:
        ex = sents[0][:160] if sents else text[:160]
        signals.append(
            {
                "label": "Sentence length",
                "detail": (
                    f"Average sentence length ~{metrics['avg_sentence_length']:.1f} words vs typical human "
                    f"~{_HUMAN_AVG_SENT_LEN:.1f} (AI-styled sustained exposition)."
                ),
                "excerpt": ex,
            }
        )

    if metrics["very_long_sentence_pct"] >= 12:
        long_sent = next((s for s in sents if len(_tokens(s)) > _VERY_LONG_WORDS), sents[0] if sents else "")
        signals.append(
            {
                "label": "Very long sentences",
                "detail": (
                    f"Very long sentences present ({metrics['very_long_sentence_pct']:.1f}% vs human "
                    f"~{_HUMAN_VERY_LONG_PCT:.1f}%)."
                ),
                "excerpt": (long_sent or "")[:160],
            }
        )

    if metrics["very_short_sentence_pct"] < 3.5 and metrics["sentence_count"] >= 3:
        signals.append(
            {
                "label": "Few short sentences",
                "detail": (
                    f"Few punchy sentences ≤{_VERY_SHORT_WORDS} words ({metrics['very_short_sentence_pct']:.1f}% vs "
                    f"human ~{_HUMAN_VERY_SHORT_PCT:.1f}%)."
                ),
                "excerpt": (sents[-1] if sents else "")[:160],
            }
        )

    hits = _marker_hits(text)
    if hits:
        signals.append(
            {
                "label": "AI signal phrasing",
                "detail": f"Templated / formal signal terms: {', '.join(hits[:4])}.",
                "excerpt": text[:160],
            }
        )

    if metrics["long_word_pct"] >= 28:
        signals.append(
            {
                "label": "Long-word density",
                "detail": (
                    f"Long words (8+ chars) at {metrics['long_word_pct']:.1f}% vs human "
                    f"~{_HUMAN_LONG_WORD_PCT:.1f}%."
                ),
                "excerpt": text[:160],
            }
        )

    if metrics["mean_word_length"] >= 5.6:
        signals.append(
            {
                "label": "Mean word length",
                "detail": (
                    f"Mean word length ~{metrics['mean_word_length']:.2f} chars vs human "
                    f"~{_HUMAN_MEAN_WORD_LEN:.2f}."
                ),
                "excerpt": text[:160],
            }
        )

    if metrics["function_word_ratio"] < 0.36:
        signals.append(
            {
                "label": "Function-word ratio",
                "detail": (
                    f"Low function-word ratio ~{metrics['function_word_ratio'] * 100:.0f}% vs human "
                    f"~{_HUMAN_FUNCTION_RATIO * 100:.0f}% (dense nominal style)."
                ),
                "excerpt": text[:160],
            }
        )

    if metrics["burstiness"] < 0.28:
        signals.append(
            {
                "label": "Low burstiness",
                "detail": "Uniform sentence rhythm (low burstiness).",
                "excerpt": (sents[0] if sents else "")[:160],
            }
        )

    stripped = text.strip()
    for pat in _AI_HEADING_PATTERNS:
        if pat.search(stripped):
            signals.append(
                {
                    "label": "AI-style heading",
                    "detail": "Formal header-like phrasing typical of templated AI outlines.",
                    "excerpt": stripped[:160],
                }
            )
            score = max(score, 0.55)
            break

    return score, signals


@dataclass
class FlaggedParagraph:
    index: int
    text: str
    reason: str
    signals: list[dict[str, str]]


class AIDetectionAuditor:
    """RIVISO linguistic integrity auditor (internal heuristics)."""

    def __init__(self, *, predictability_threshold: float = 0.48) -> None:
        self.predictability_threshold = max(0.0, min(1.0, predictability_threshold))

    def audit_markdown(self, md: str) -> dict[str, Any]:
        paras = split_markdown_paragraphs(md)
        if not paras:
            return {"ai_percentage": 0.0, "flagged_paragraphs": [], "metrics": {"burstiness": 0.0, "predictability": 0.0}}

        flags: list[FlaggedParagraph] = []
        total_words = 0
        flagged_words = 0
        para_scores: list[float] = []
        threshold = self.predictability_threshold

        for i, p in enumerate(paras):
            wc = len(p.split())
            total_words += wc
            score, signals = analyze_paragraph_signals(p)
            para_scores.append(score)
            is_heading = bool(_HEADING_RE.match(p.strip()))
            should_flag = wc >= 8 and (
                score >= threshold or (is_heading and score >= 0.52) or len(signals) >= 3
            )
            if should_flag:
                flagged_words += wc
                reason_parts = [s["detail"] for s in signals[:3]] or ["Elevated AI-style linguistic profile."]
                flags.append(FlaggedParagraph(index=i, text=p, reason=" ".join(reason_parts), signals=signals))

        doc_metrics = compute_linguistic_metrics("\n\n".join(paras))
        doc_pred = sum(para_scores) / len(para_scores)
        word_pct = (flagged_words / total_words * 100.0) if total_words > 0 else doc_pred * 100.0
        ai_pct = max(0.0, min(100.0, round(word_pct, 1)))

        return {
            "ai_percentage": ai_pct,
            "flagged_paragraphs": [
                {"index": f.index, "text": f.text, "reason": f.reason, "signals": f.signals} for f in flags
            ],
            "metrics": {
                "burstiness": doc_metrics.get("burstiness", 0.0),
                "predictability": round(doc_pred, 3),
                "paragraphs": len(paras),
                "flagged": len(flags),
                "avg_sentence_length": doc_metrics.get("avg_sentence_length"),
                "long_word_pct": doc_metrics.get("long_word_pct"),
                "function_word_ratio": doc_metrics.get("function_word_ratio"),
                "mean_word_length": doc_metrics.get("mean_word_length"),
            },
        }


def _apply_formal_trims(sentence: str) -> str:
    out = sentence
    for pat, repl in _FORMAL_TRIM:
        out = pat.sub(repl, out)
    return _WS_RE.sub(" ", out).strip()


_LIST_LINE_RE = re.compile(r"^(\s*[-*•]\s+)(.*)$")


def split_markdown_paragraphs(md: str) -> list[str]:
    """Split markdown into audit blocks (headings, paragraphs, long blocks chunked by sentences)."""
    raw = (md or "").replace("\r\n", "\n")
    blocks: list[str] = []
    buf: list[str] = []

    def flush_buf() -> None:
        nonlocal buf
        joined = "\n".join(buf).strip()
        buf = []
        if joined:
            blocks.append(joined)

    for line in raw.split("\n"):
        t = line.strip()
        if _HEADING_RE.match(t):
            flush_buf()
            blocks.append(t)
        elif not t:
            flush_buf()
        else:
            buf.append(line)
    flush_buf()

    expanded: list[str] = []
    for block in blocks:
        words = block.split()
        if len(words) > 180:
            sentences = [x.strip() for x in _SENT_SPLIT_RE.split(block) if x.strip()]
            chunk: list[str] = []
            chunk_words = 0
            for sent in sentences:
                w = len(sent.split())
                if chunk_words + w > 90 and chunk:
                    expanded.append(" ".join(chunk))
                    chunk = []
                    chunk_words = 0
                chunk.append(sent)
                chunk_words += w
            if chunk:
                expanded.append(" ".join(chunk))
        else:
            expanded.append(block)

    return [b for b in expanded if b.strip()]


def _is_list_block(text: str) -> bool:
    return bool(re.match(r"^\s*[-*•]\s+", (text or "").strip()))


def join_markdown_paragraphs(paras: list[str]) -> str:
    """Rejoin blocks preserving list line breaks (critical for full-article fidelity)."""
    chunks = [p.rstrip() for p in paras if (p or "").strip()]
    if not chunks:
        return ""
    parts: list[str] = [chunks[0]]
    for i in range(1, len(chunks)):
        prev, cur = chunks[i - 1], chunks[i]
        if _is_list_block(prev) and _is_list_block(cur):
            parts.append("\n" + cur)
        elif _HEADING_RE.match(cur.strip()) or _HEADING_RE.match(prev.strip()):
            parts.append("\n\n" + cur)
        else:
            parts.append("\n\n" + cur)
    joined = "".join(parts).strip()
    return joined + ("\n" if joined else "")


def _split_long_sentence_conservative(sentence: str, max_words: int = 48) -> str:
    """Split only extremely long sentences at strong boundaries; return single flowing text."""
    words = sentence.split()
    if len(words) <= max_words:
        return sentence
    parts = re.split(r";\s+|\s+—\s+|\s+-\s+(?=[A-Z])", sentence, maxsplit=1)
    if len(parts) == 2 and all(p.strip() for p in parts):
        a, b = parts[0].strip().rstrip(","), parts[1].strip()
        if not a.endswith((".", "!", "?")):
            a += "."
        if b and b[0].islower():
            b = b[0].upper() + b[1:]
        if not b.endswith((".", "!", "?")):
            b += "."
        return f"{a} {b}"
    # Split before coordinating conjunction near middle
    mid = len(words) // 2
    for i in range(mid - 4, min(mid + 8, len(words) - 2)):
        if words[i].lower() in {"and", "but", "because", "while", "although", "so"}:
            a = " ".join(words[:i]).rstrip(",") + "."
            b = " ".join(words[i:])
            if b and b[0].islower():
                b = b[0].upper() + b[1:]
            if not b.endswith((".", "!", "?")):
                b += "."
            return f"{a} {b}"
    return sentence




def humanize_heading(line: str) -> str:
    m = _HEADING_RE.match(line.strip())
    if not m:
        return line
    prefix = m.group(0).split()[0]
    title = _HEADING_RE.sub("", line.strip()).strip()
    for pat in _AI_HEADING_PATTERNS:
        if pat.search(title):
            title = re.sub(r"^Conceptual Overview of\s+", "", title, flags=re.I)
            title = re.sub(r"^Conceptual Overview\s*$", "Overview", title, flags=re.I)
            title = re.sub(r"^Key Legal Takeaways\s*$", "Main points", title, flags=re.I)
            title = re.sub(r"^Key Takeaways\s*$", "Main points", title, flags=re.I)
            title = re.sub(r"^Emerging Trends\s*$", "What's changing", title, flags=re.I)
            title = re.sub(r"^Judicial Interpretation and\s+", "How courts view ", title, flags=re.I)
            break
    if len(title) > 60:
        title = title[:57].rstrip() + "…"
    return f"{prefix} {title}".strip()


def humanize_paragraph(
    text: str,
    *,
    synonym_strength: float = 0.68,
    protected_terms: list[str] | None = None,
    force_change: bool = False,
) -> str:
    """RIVISO Paraphrase + Grammar (internal, industry-neutral)."""
    from app.services.riviso_paraphrase_engine import paraphrase_block

    raw = (text or "").strip()
    if not raw:
        return raw
    if _HEADING_RE.match(raw):
        from app.services.riviso_grammar_engine import run_grammar_pipeline

        return run_grammar_pipeline(humanize_heading(raw))

    from app.services.riviso_human_profile import (
        _apply_contractions,
        _split_long_sentences_only,
        _vary_openers,
    )
    from app.services.riviso_paraphrase_engine import scrub_ai_markers

    after = paraphrase_block(raw, strength=synonym_strength, protected_terms=protected_terms or [])
    if force_change and after.strip() == raw.strip() and len(raw.split()) > 6:
        after = paraphrase_block(raw, strength=min(0.88, synonym_strength + 0.12), protected_terms=protected_terms or [])
    from app.services.riviso_human_profile import (
        _add_one_short_sentence_if_needed,
        _naturalize_function_words_once,
    )

    after = scrub_ai_markers(after)
    after = _split_long_sentences_only(after)
    after = _vary_openers(after)
    after = _naturalize_function_words_once(after)
    after = _add_one_short_sentence_if_needed(after)
    after = _apply_contractions(after)
    from app.services.riviso_grammar_engine import run_grammar_pipeline

    return run_grammar_pipeline(after)


def humanize_markdown_blocks(
    paras: list[str],
    indices: list[int],
    *,
    synonym_strength: float = 0.68,
    protected_terms: list[str] | None = None,
    force_change: bool = False,
) -> tuple[list[str], list[dict[str, Any]]]:
    rewritten: list[dict[str, Any]] = []
    out = list(paras)
    for i in indices:
        if i < 0 or i >= len(out):
            continue
        before = out[i]
        after = humanize_paragraph(
            before,
            synonym_strength=synonym_strength,
            protected_terms=protected_terms,
            force_change=force_change,
        )
        if after and after.strip() != before.strip():
            sim = _cosine_tf(before, after)
            out[i] = after
            rewritten.append(
                {
                    "index": i,
                    "before": before,
                    "after": after,
                    "semantic_similarity": round(sim, 3),
                }
            )
    return out, rewritten
