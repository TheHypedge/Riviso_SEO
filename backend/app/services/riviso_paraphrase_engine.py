"""
RIVISO Paraphrase Engine — industry-neutral, global editorial rephrasing (no external APIs).
"""
from __future__ import annotations

import hashlib
import re
from typing import Iterable

from app.services.riviso_grammar_engine import run_grammar_pipeline
from app.services.riviso_linguistics import _apply_formal_trims, _split_sentences

_WORD = re.compile(r"\b[\w']+\b")
_HEADING_LINE = re.compile(r"^#{1,6}\s")
_LIST_LINE = re.compile(r"^\s*[-*•]\s+")

# Universal editorial synonym map (all industries — not legal-specific).
_SYNONYMS: dict[str, tuple[str, ...]] = {
    "important": ("key", "vital", "central", "major"),
    "critical": ("crucial", "essential", "pressing"),
    "essential": ("vital", "key", "necessary"),
    "choose": ("pick", "select", "decide on"),
    "choosing": ("picking", "selecting"),
    "right": ("suitable", "best", "fitting", "ideal"),
    "good": ("solid", "strong", "sound"),
    "great": ("excellent", "strong", "notable"),
    "help": ("support", "assist", "aid"),
    "helps": ("supports", "assists", "aids"),
    "need": ("require", "call for"),
    "needs": ("requires", "calls for"),
    "use": ("apply", "employ", "work with"),
    "using": ("applying", "working with"),
    "make": ("create", "build", "produce"),
    "made": ("built", "created", "produced"),
    "get": ("obtain", "receive", "gain"),
    "show": ("reveal", "display", "present"),
    "shows": ("reveals", "displays", "presents"),
    "provide": ("offer", "give", "supply", "deliver"),
    "provides": ("offers", "gives", "supplies"),
    "understand": ("grasp", "see", "recognize"),
    "understanding": ("grasp", "sense", "view"),
    "learn": ("discover", "find out", "pick up"),
    "know": ("recognize", "see", "understand"),
    "think": ("believe", "feel", "consider"),
    "believe": ("think", "feel", "hold"),
    "work": ("function", "operate", "run"),
    "works": ("functions", "operates", "runs"),
    "working": ("operating", "running", "functioning"),
    "start": ("begin", "launch", "kick off"),
    "begin": ("start", "open", "launch"),
    "end": ("finish", "close", "wrap up"),
    "finish": ("complete", "wrap up", "close"),
    "complete": ("finish", "wrap up", "fulfill"),
    "create": ("build", "make", "develop"),
    "build": ("create", "make", "develop"),
    "develop": ("build", "create", "grow"),
    "grow": ("expand", "increase", "build"),
    "increase": ("raise", "boost", "grow"),
    "reduce": ("lower", "cut", "ease"),
    "improve": ("boost", "strengthen", "upgrade"),
    "change": ("shift", "update", "alter"),
    "update": ("refresh", "revise", "change"),
    "new": ("fresh", "recent", "latest"),
    "old": ("earlier", "previous", "past"),
    "large": ("big", "wide", "broad"),
    "small": ("compact", "tight", "minor"),
    "fast": ("quick", "rapid", "swift"),
    "slow": ("gradual", "steady", "measured"),
    "easy": ("simple", "straightforward", "smooth"),
    "hard": ("tough", "difficult", "challenging"),
    "simple": ("straightforward", "clear", "plain"),
    "clear": ("plain", "obvious", "evident"),
    "common": ("typical", "usual", "frequent"),
    "different": ("distinct", "separate", "other"),
    "similar": ("alike", "comparable", "close"),
    "best": ("top", "leading", "finest"),
    "better": ("stronger", "improved", "smarter"),
    "many": ("numerous", "several", "plenty of"),
    "several": ("many", "a few", "multiple"),
    "various": ("different", "several", "many"),
    "numerous": ("many", "several", "countless"),
    "significant": ("major", "notable", "substantial"),
    "major": ("significant", "primary", "main"),
    "main": ("primary", "core", "chief"),
    "primary": ("main", "core", "chief"),
    "key": ("main", "core", "central"),
    "specific": ("particular", "defined", "clear"),
    "general": ("broad", "overall", "wide"),
    "overall": ("on the whole", "in general", "broadly"),
    "local": ("regional", "nearby", "area"),
    "global": ("worldwide", "international", "broad"),
    "world": ("globe", "planet", "global market"),
    "market": ("sector", "space", "field"),
    "business": ("company", "operation", "venture"),
    "company": ("firm", "business", "organization"),
    "customer": ("client", "buyer", "user"),
    "customers": ("clients", "buyers", "users"),
    "client": ("customer", "buyer", "partner"),
    "clients": ("customers", "buyers", "partners"),
    "product": ("offering", "solution", "item"),
    "products": ("offerings", "solutions", "items"),
    "service": ("offering", "support", "solution"),
    "services": ("offerings", "solutions", "support"),
    "team": ("group", "crew", "staff"),
    "people": ("folks", "individuals", "users"),
    "person": ("individual", "someone", "user"),
    "user": ("customer", "client", "reader"),
    "users": ("customers", "clients", "readers"),
    "reader": ("visitor", "user", "audience"),
    "readers": ("visitors", "users", "audience"),
    "website": ("site", "web page", "platform"),
    "online": ("on the web", "digital", "virtual"),
    "digital": ("online", "web-based", "virtual"),
    "content": ("material", "copy", "writing"),
    "article": ("piece", "post", "write-up"),
    "guide": ("overview", "walkthrough", "primer"),
    "overview": ("outline", "snapshot", "summary"),
    "summary": ("overview", "recap", "wrap-up"),
    "example": ("instance", "case", "sample"),
    "examples": ("instances", "cases", "samples"),
    "process": ("steps", "workflow", "method"),
    "processes": ("workflows", "methods", "steps"),
    "method": ("approach", "way", "process"),
    "approach": ("method", "way", "strategy"),
    "strategy": ("plan", "approach", "roadmap"),
    "plan": ("strategy", "roadmap", "approach"),
    "goal": ("aim", "target", "objective"),
    "goals": ("aims", "targets", "objectives"),
    "result": ("outcome", "effect", "impact"),
    "results": ("outcomes", "effects", "impacts"),
    "benefit": ("advantage", "plus", "gain"),
    "benefits": ("advantages", "gains", "upsides"),
    "advantage": ("edge", "benefit", "plus"),
    "problem": ("issue", "challenge", "pain point"),
    "problems": ("issues", "challenges", "pain points"),
    "issue": ("problem", "challenge", "gap"),
    "issues": ("problems", "challenges", "gaps"),
    "solution": ("fix", "answer", "remedy"),
    "solutions": ("fixes", "answers", "remedies"),
    "ensure": ("make sure", "help", "see that"),
    "ensuring": ("making sure", "helping"),
    "avoid": ("skip", "prevent", "sidestep"),
    "prevent": ("stop", "block", "avoid"),
    "include": ("cover", "feature", "contain"),
    "includes": ("covers", "features", "contains"),
    "offer": ("provide", "give", "include"),
    "offers": ("provides", "gives", "includes"),
    "allow": ("let", "enable", "permit"),
    "allows": ("lets", "enables", "permits"),
    "enable": ("allow", "power", "support"),
    "support": ("back", "help", "assist"),
    "facilitate": ("help", "ease", "enable"),
    "access": ("reach", "use", "entry to"),
    "available": ("on hand", "ready", "open"),
    "effective": ("strong", "solid", "useful"),
    "efficient": ("streamlined", "lean", "smart"),
    "successful": ("strong", "winning", "solid"),
    "professional": ("skilled", "expert", "trained"),
    "quality": ("standard", "caliber", "grade"),
    "experience": ("background", "track record", "history"),
    "industry": ("sector", "field", "space"),
    "sector": ("industry", "field", "space"),
    "field": ("area", "space", "sector"),
    "technology": ("tech", "tools", "systems"),
    "tool": ("resource", "utility", "solution"),
    "tools": ("resources", "utilities", "solutions"),
    "data": ("information", "insights", "figures"),
    "information": ("details", "info", "data"),
    "research": ("study", "analysis", "review"),
    "study": ("analysis", "review", "look"),
    "report": ("brief", "summary", "write-up"),
    "reported": ("noted", "said", "found"),
    "according": ("based", "per", "from"),
    "however": ("still", "yet", "but"),
    "therefore": ("so", "thus", "as a result"),
    "additionally": ("also", "plus", "on top of that"),
    "furthermore": ("also", "plus", "what is more"),
    "moreover": ("also", "besides", "on top of that"),
    "utilize": ("use", "apply", "employ"),
    "leverage": ("use", "tap", "draw on"),
    "robust": ("strong", "solid", "reliable"),
    "comprehensive": ("full", "complete", "thorough"),
    "holistic": ("full", "whole", "complete"),
    "seamlessly": ("smoothly", "easily", "without friction"),
    "landscape": ("space", "field", "scene"),
    "framework": ("system", "model", "setup"),
    "mechanism": ("process", "method", "system"),
    "aspect": ("part", "side", "angle"),
    "aspects": ("parts", "sides", "angles"),
    "implications": ("effects", "impact", "takeaways"),
    "practical": ("real-world", "hands-on", "everyday"),
    "informed": ("aware", "up to date", "in the loop"),
    "decision": ("choice", "call", "move"),
    "decisions": ("choices", "calls", "moves"),
    "particularly": ("especially", "notably", "in particular"),
    "especially": ("particularly", "notably", "chiefly"),
    "typically": ("usually", "often", "generally"),
    "usually": ("typically", "often", "generally"),
    "often": ("frequently", "commonly", "regularly"),
    "always": ("consistently", "every time", "without fail"),
    "never": ("not once", "at no time", "not ever"),
    "today": ("now", "these days", "right now"),
    "future": ("ahead", "down the road", "coming"),
    "past": ("earlier", "previous", "prior"),
    "current": ("present", "today's", "existing"),
    "modern": ("today's", "current", "up to date"),
    "traditional": ("classic", "established", "long-standing"),
    "innovative": ("fresh", "new", "forward-looking"),
    "unique": ("distinct", "one-of-a-kind", "standout"),
    "popular": ("widely used", "in demand", "common"),
    "leading": ("top", "premier", "front-running"),
    "top": ("leading", "best", "premier"),
}

# Global AI-template phrase removals (all verticals).
_PHRASE_REWRITES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bin today's (?:digital )?(?:landscape|world)\b", re.I), "today"),
    (re.compile(r"\bin the modern (?:digital )?era\b", re.I), "today"),
    (re.compile(r"\bin order to\b", re.I), "to"),
    (re.compile(r"\bdue to the fact that\b", re.I), "because"),
    (re.compile(r"\bat this point in time\b", re.I), "now"),
    (re.compile(r"\bit is important to note that\s*", re.I), ""),
    (re.compile(r"\bit is worth noting that\s*", re.I), ""),
    (re.compile(r"\bit is essential to note that\s*", re.I), ""),
    (re.compile(r"\bplays a (?:crucial|vital|key) role\b", re.I), "matters"),
    (re.compile(r"\bwhen it comes to\b", re.I), "for"),
    (re.compile(r"\bone of the most important\b", re.I), "a key"),
    (re.compile(r"\ba comprehensive guide to\b", re.I), "a practical guide to"),
    (re.compile(r"\bthis article (?:will|aims to)\b", re.I), "this piece"),
    (re.compile(r"\bthis guide (?:will|aims to)\b", re.I), "this overview"),
    (re.compile(r"\bunderstanding how\b", re.I), "seeing how"),
    (re.compile(r"\bunderstanding the\b", re.I), "grasping the"),
    (re.compile(r"\bdelve into\b", re.I), "look at"),
    (re.compile(r"\bdelve\b", re.I), "explore"),
    (re.compile(r"\bfurthermore,?\s*", re.I), "Also, "),
    (re.compile(r"\bmoreover,?\s*", re.I), "Also, "),
    (re.compile(r"\badditionally,?\s*", re.I), "Also, "),
    (re.compile(r"\bin summary,?\s*", re.I), "To sum up, "),
    (re.compile(r"\bin conclusion,?\s*", re.I), "Overall, "),
    (re.compile(r"\bchoosing the right\b", re.I), "picking the right"),
    (re.compile(r"\bis critical when\b", re.I), "matters when"),
    (re.compile(r"\bis critical for\b", re.I), "matters for"),
    (re.compile(r"\bis essential for\b", re.I), "works best for"),
    (re.compile(r"\bis essential to\b", re.I), "matters to"),
    (re.compile(r"\bdesigned to help\b", re.I), "helps"),
    (re.compile(r"\bdesigned to provide\b", re.I), "provides"),
    (re.compile(r"\bnavigate the complexities of\b", re.I), "work through"),
    (re.compile(r"\bstaying informed about\b", re.I), "keeping up with"),
    (re.compile(r"\bensuring protection of\b", re.I), "protecting"),
    (re.compile(r"\bwhether you are\b", re.I), "if you're"),
    (re.compile(r"\bkey takeaways\b", re.I), "main points"),
    (re.compile(r"\bconceptual overview\b", re.I), "overview"),
    (re.compile(r"\bemerging trends\b", re.I), "new trends"),
    (re.compile(r"\belevate your (?:wardrobe|style|look)\b", re.I), "upgrade your"),
    (re.compile(r"\belevate the\b", re.I), "improve the"),
    (re.compile(r"\bpersonality and flair\b", re.I), "personal style"),
    (re.compile(r"\beffortless charm\b", re.I), "easy style"),
    (re.compile(r"\ba wonderful way to\b", re.I), "a good way to"),
    (re.compile(r"\bwonderful way\b", re.I), "good way"),
    (re.compile(r"\btransform your look\b", re.I), "change how you look"),
    (re.compile(r"\bwatch how it transforms\b", re.I), "see how it changes"),
    (re.compile(r"\bstart with a signature piece\b", re.I), "try one piece"),
    (re.compile(r"\bsignature piece like\b", re.I), "piece like"),
    (re.compile(r"\bin practice,\s*", re.I), ""),
    (re.compile(r"\bat its core,?\s*", re.I), ""),
    (re.compile(r"\bit's no secret that\b", re.I), ""),
    (re.compile(r"\bgame-changer\b", re.I), "big shift"),
    (re.compile(r"\btake your .+ to the next level\b", re.I), "step up your style"),
    (re.compile(r"\bunlock the potential\b", re.I), "get more from"),
    (re.compile(r"\blet's dive in\b", re.I), ""),
    (re.compile(r"\blet us explore\b", re.I), ""),
]

_STRUCTURE_RULES: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(
            r"^(?P<subject>.{6,90}?)\s+is\s+(?:critical|essential|important|vital)\s+when\s+(?P<rest>.+?)[.!?]\s*$",
            re.I,
        ),
        r"When \g<rest>, \g<subject> matters.",
    ),
    (
        re.compile(
            r"^(?P<subject>.{6,90}?)\s+is\s+(?:critical|essential|important|vital)\s+for\s+(?P<rest>.+?)[.!?]\s*$",
            re.I,
        ),
        r"For \g<rest>, \g<subject> is a priority.",
    ),
    (re.compile(r"^It is (?:important|essential|critical) to (?:note that )?(?P<rest>.+?)[.!?]\s*$", re.I), r"\g<rest>."),
    (re.compile(r"^There are (?:several|many|numerous) (?P<rest>.+?)[.!?]\s*$", re.I), r"You'll find \g<rest>."),
    (re.compile(r"^This (?:article|guide|post) (?:explains|covers|discusses) (?P<rest>.+?)[.!?]\s*$", re.I), r"Here's \g<rest>."),
]


def _stable_pick(key: str, options: tuple[str, ...]) -> str:
    if not options:
        return key
    h = int(hashlib.md5(key.encode("utf-8")).hexdigest(), 16)
    return options[h % len(options)]


def _extract_protected(text: str, extra: Iterable[str] | None = None) -> set[str]:
    protected: set[str] = set()
    for m in re.finditer(r"https?://\S+", text):
        protected.add(m.group(0).lower())
    for m in re.finditer(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b", text):
        protected.add(m.group(0).lower())
    for m in re.finditer(r"\b[A-Z]{2,}\b", text):
        protected.add(m.group(0).lower())
    for m in re.finditer(r"`[^`]+`", text):
        protected.add(m.group(0).lower())
    if extra:
        for term in extra:
            t = (term or "").strip().lower()
            if not t:
                continue
            protected.add(t)
            for part in t.split():
                if len(part) > 3:
                    protected.add(part)
    return protected


def _apply_phrase_rewrites(text: str) -> str:
    out = text
    for pat, repl in _PHRASE_REWRITES:
        out = pat.sub(repl, out)
    return out


def _apply_structure_rules(sentence: str) -> str:
    s = sentence.strip()
    for pat, repl in _STRUCTURE_RULES:
        if pat.search(s):
            return pat.sub(repl, s)
    return s


def _apply_synonyms(sentence: str, strength: float, protected: set[str], sent_idx: int) -> str:
    if strength <= 0:
        return sentence

    def repl(m: re.Match[str]) -> str:
        word = m.group(0)
        low = word.lower()
        if low in protected or len(low) <= 3 or "-" in word:
            return word
        options = _SYNONYMS.get(low)
        if not options:
            return word
        gate = int(hashlib.md5(f"{sent_idx}:{low}".encode()).hexdigest(), 16) % 100
        # Higher strength => more replacements (was inverted before).
        keep_threshold = int((1.0 - min(0.95, strength)) * 100)
        if gate >= keep_threshold:
            return word
        alt = _stable_pick(f"{sent_idx}:{low}", options)
        if word[0].isupper():
            return alt.capitalize()
        return alt

    return _WORD.sub(repl, sentence)


def _split_long_sentences_in_list(sentences: list[str], max_words: int = 28) -> list[str]:
    """Split long sentences for rhythm — never append template punch lines."""
    out: list[str] = []
    for sent in sentences:
        words = sent.split()
        if len(words) <= max_words:
            out.append(sent)
            continue
        split_done = False
        if ", " in sent:
            parts = [p.strip() for p in re.split(r",\s+(?=[a-z])", sent, maxsplit=1)]
            if len(parts) == 2 and len(parts[0].split()) > 8:
                a, b = parts[0].rstrip(",") + ".", parts[1]
                if b and b[0].islower():
                    b = b[0].upper() + b[1:]
                if not b.endswith((".", "!", "?")):
                    b += "."
                out.extend([a, b])
                split_done = True
        if not split_done and " and " in sent.lower():
            parts = re.split(r"\s+and\s+", sent, maxsplit=1, flags=re.I)
            if len(parts) == 2 and len(parts[0].split()) > 8:
                a, b = parts[0].rstrip(",") + ".", parts[1].strip()
                if b and b[0].islower():
                    b = b[0].upper() + b[1:]
                if not b.endswith((".", "!", "?")):
                    b += "."
                out.extend([a, b])
                split_done = True
        if not split_done:
            out.append(sent)
    return out


def paraphrase_sentence(sentence: str, sent_idx: int, *, strength: float, protected: set[str]) -> str:
    s = _apply_formal_trims(sentence)
    s = _apply_phrase_rewrites(s)
    s = _apply_structure_rules(s)
    s = _apply_synonyms(s, strength, protected, sent_idx)
    return run_grammar_pipeline(s)


def paraphrase_prose(paragraph: str, *, strength: float = 0.68, protected_terms: Iterable[str] | None = None) -> str:
    protected = _extract_protected(paragraph, protected_terms)
    sentences = _split_sentences(paragraph)
    if not sentences:
        body = _apply_phrase_rewrites(_apply_formal_trims(paragraph))
        return run_grammar_pipeline(_apply_synonyms(body, strength, protected, 0))

    paraphrased = [paraphrase_sentence(s, i, strength=strength, protected=protected) for i, s in enumerate(sentences)]
    paraphrased = _split_long_sentences_in_list(paraphrased)
    return run_grammar_pipeline(" ".join(s.strip() for s in paraphrased if s.strip()))


def paraphrase_line(line: str, *, strength: float = 0.58, protected_terms: Iterable[str] | None = None) -> str:
    m = re.match(r"^(\s*[-*•]\s+)(.*)$", line)
    if m:
        return f"{m.group(1)}{paraphrase_prose(m.group(2), strength=strength, protected_terms=protected_terms)}"
    if _HEADING_LINE.match(line.strip()):
        title = re.sub(r"^#{1,6}\s+", "", line.strip()).strip()
        title = _apply_phrase_rewrites(_apply_formal_trims(title))
        title = run_grammar_pipeline(title)
        prefix = line.strip().split()[0]
        return f"{prefix} {title}"
    return paraphrase_prose(line.strip(), strength=strength, protected_terms=protected_terms)


def scrub_ai_markers(text: str) -> str:
    """Last-pass removal of high-signal AI template words (all industries)."""
    out = _apply_phrase_rewrites(text or "")
    marker_swap = {
        "utilize": "use",
        "leverage": "use",
        "robust": "solid",
        "seamless": "smooth",
        "comprehensive": "full",
        "fostering": "building",
        "holistic": "full",
        "delve": "explore",
        "myriad": "many",
        "plethora": "many",
        "paramount": "key",
        "underscores": "shows",
        "tapestry": "mix",
    }
    for src, dst in marker_swap.items():
        out = re.sub(rf"\b{re.escape(src)}\b", dst, out, flags=re.IGNORECASE)
    out = re.sub(r"\bensure protection of\b", "protect", out, flags=re.IGNORECASE)
    out = re.sub(r"\bfostering seamless\b", "building smooth", out, flags=re.IGNORECASE)
    return run_grammar_pipeline(out)


def paraphrase_block(text: str, *, strength: float = 0.68, protected_terms: Iterable[str] | None = None) -> str:
    raw = (text or "").strip()
    if not raw:
        return raw
    if "\n" in raw and re.search(r"^\s*[-*•]\s", raw, re.MULTILINE):
        return "\n".join(
            paraphrase_line(ln, strength=strength, protected_terms=protected_terms) if ln.strip() else ln
            for ln in raw.split("\n")
        )
    body = paraphrase_prose(raw, strength=strength, protected_terms=protected_terms)
    return scrub_ai_markers(body)
