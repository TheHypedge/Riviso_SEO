"""Post-generation quality pass for article markdown.

* ``structure_report`` measures the shape editors flag as machine-written: sections that open
  with a list or a one-line lead, list-heavy bodies, flat sentence rhythm, banned phrases.
* ``verify_external_links`` checks every outbound link the model wrote and unlinks the dead
  ones (keeping the anchor text), so a hallucinated URL never reaches a live post.
"""

from __future__ import annotations

import asyncio
import logging
import re
import statistics
from urllib.parse import urlsplit

import httpx

from app.services.human_writing_guardrail import AI_DETECTOR_BANNED_PHRASES
from app.services.url_guard import SsrfError, assert_public_http_url, ssrf_guarded_event_hooks

log = logging.getLogger(__name__)

_LINK_RE = re.compile(r"(?<!!)\[([^\[\]\n]+)\]\((https?://[^\s)]+)\)")
_LIST_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
_SENT_RE = re.compile(r"[^.!?:]+[.!?:]+(?=\s|$)")
_FAQ_RE = re.compile(r"faq|frequently asked|^sources$|^references$|^key takeaways$", re.IGNORECASE)


def _plain(text: str) -> str:
    text = _LINK_RE.sub(r"\1", text)
    return re.sub(r"[*_`#>]", "", text)


def _sentences(text: str) -> list[str]:
    found = [s.strip() for s in _SENT_RE.findall(_plain(text)) if s.strip()]
    return found or ([text.strip()] if text.strip() else [])


def structure_report(md: str) -> dict:
    """Measure section anatomy and rhythm. ``passed`` mirrors SECTION_ANATOMY_RULES."""
    lines = (md or "").splitlines()
    sections: list[dict] = []
    prose_words = list_words = 0
    prose_text: list[str] = []
    cur: dict | None = None
    for raw in lines:
        line = raw.rstrip()
        if re.match(r"^#{2,3}\s", line):
            cur = {"heading": line.lstrip("# ").strip(), "level": len(line) - len(line.lstrip("#")),
                   "lead": [], "lead_done": False, "starts_with_list": False}
            sections.append(cur)
            continue
        if not line.strip() or line.lstrip().startswith(("|", "![", "<")):
            if cur is not None and cur["lead"] and line.lstrip().startswith("|"):
                cur["lead_done"] = True
            continue
        words = len(_plain(line).split())
        if _LIST_RE.match(line):
            list_words += words
            if cur is not None and not cur["lead_done"]:
                cur["starts_with_list"] = not cur["lead"]
                cur["lead_done"] = True
            continue
        prose_words += words
        prose_text.append(line)
        if cur is not None and not cur["lead_done"]:
            cur["lead"].append(line)

    checked = [s for s in sections if not _FAQ_RE.search(s["heading"]) and not s["heading"].endswith("?")]
    thin = []
    for s in checked:
        need = 3 if s["level"] == 2 else 2
        if s["starts_with_list"] or len(_sentences(" ".join(s["lead"]))) < need:
            thin.append(s["heading"])

    lengths = [len(x.split()) for x in _sentences(" ".join(prose_text))]
    total = prose_words + list_words
    lower = (md or "").lower()
    report = {
        "sections_checked": len(checked),
        "thin_lead_sections": thin,
        "sections_opening_with_list": [s["heading"] for s in checked if s["starts_with_list"]],
        "list_word_ratio": round(list_words / total, 2) if total else 0.0,
        "avg_sentence_words": round(statistics.mean(lengths), 1) if lengths else 0.0,
        # Burstiness: human prose mixes short and long sentences; AI text is uniform.
        "sentence_length_stdev": round(statistics.pstdev(lengths), 1) if len(lengths) > 1 else 0.0,
        "banned_phrases_found": sorted({p for p in AI_DETECTOR_BANNED_PHRASES if p in lower}),
        "links": len(_LINK_RE.findall(md or "")),
    }
    report["passed"] = (
        not thin
        and report["list_word_ratio"] <= 0.30
        and report["sentence_length_stdev"] >= 5
        and not report["banned_phrases_found"]
    )
    return report


async def _link_is_dead(client: httpx.AsyncClient, url: str) -> bool:
    try:
        assert_public_http_url(url)
    except SsrfError:
        return True
    try:
        res = await client.head(url)
        if res.status_code in (405, 501) or res.status_code >= 500:
            res = await client.get(url)
    except (httpx.ConnectError, httpx.UnsupportedProtocol, httpx.InvalidURL, SsrfError):
        return True  # no such host: the classic hallucinated domain
    except httpx.HTTPError:
        return False  # timeout / transient: don't punish a real site for being slow
    # 401/403/429 are usually bot walls on real government sites, so only "not found" kills a link.
    return res.status_code in (404, 410)


async def verify_external_links(md: str, *, trusted_urls: set[str] | frozenset[str] = frozenset()) -> tuple[str, list[str]]:
    """Unlink outbound links that don't resolve. Returns (markdown, removed_urls)."""
    urls = {u for _, u in _LINK_RE.findall(md or "") if u not in trusted_urls}
    sem = asyncio.Semaphore(6)
    headers = {"user-agent": "Mozilla/5.0 (compatible; RivisoLinkCheck/1.0; +https://riviso.cloud)"}
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(8.0), follow_redirects=True, headers=headers, event_hooks=ssrf_guarded_event_hooks()
    ) as client:

        async def check(u: str) -> tuple[str, bool]:
            async with sem:
                return u, await _link_is_dead(client, u)

        results = await asyncio.gather(*(check(u) for u in sorted(urls)))
    dead = {u for u, is_dead in results if is_dead}
    if dead:
        log.info("Removed %d dead external link(s): %s", len(dead), ", ".join(urlsplit(u).netloc for u in dead))
    seen: set[str] = set()

    def keep(m: re.Match) -> str:
        url = m.group(2)
        if url in dead or (url in seen and url not in trusted_urls):
            return m.group(1)  # dead, or the same source linked twice
        seen.add(url)
        return m.group(0)

    return _LINK_RE.sub(keep, md), sorted(dead)


# ---------------------------------------------------------------- SEO / AEO / GEO score

_BCI_BANNED = re.compile(
    r"\b(best|top|no\.?\s?1|number one|leading|most trusted)\s+(lawyers?|advocates?|law firms?|attorneys?)\b"
    r"|\bguarantee[sd]?\s+(?:(?:a|an|the|your|you)\s+)?(?:bail|acquittal|success|results?|outcomes?|win|victory|relief|divorce|favourable)\b"
    r"|\b(?:result|success|outcome|acquittal|bail)\s+(?:is\s+)?guaranteed\b|\b100%\s+success\b|\bsuccess rate\b|\bhire us\b|\bcall (us )?now\b",
    re.IGNORECASE,
)
_OLD_CODE_RE = re.compile(r"\b(IPC|CrPC|Cr\.P\.C\.?|Indian Penal Code|Code of Criminal Procedure|Indian Evidence Act)\b")
_NEW_CODE_RE = re.compile(r"\b(BNS|BNSS|BSA|Bharatiya Nyaya Sanhita|Bharatiya Nagarik Suraksha Sanhita|Bharatiya Sakshya Adhiniyam)\b")
_CITE_RE = re.compile(r"\[\[\d+\]\]\(https?://")


def _h2_sections(md: str) -> list[tuple[str, str]]:
    parts = re.split(r"(?m)^##\s+(.+)$", md or "")
    return [(parts[i].strip(), parts[i + 1]) for i in range(1, len(parts) - 1, 2)]


def seo_aeo_geo_score(md: str, *, focus: str = "", profile: str = "general", research: dict | None = None,
                      internal_urls: set[str] | frozenset[str] = frozenset()) -> dict:
    """Weighted checklist (0-100) of what ranks in Google and gets cited by AI answer engines.

    Checks that cannot apply (no site map for internal links, no research pack) are left out of
    the denominator instead of counting as failures.
    """
    from app.services.schema_markup import extract_faq_pairs

    text = md or ""
    plain = _plain(text)
    lower = plain.lower()
    words = len(plain.split())
    sections = [(h, b) for h, b in _h2_sections(text) if not _FAQ_RE.search(h)]
    questions = [(h, b) for h, b in sections if h.rstrip().endswith("?")]

    def first_sentence_words(body: str) -> int:
        para = next((ln for ln in body.splitlines() if ln.strip() and not ln.lstrip().startswith(("#", "-", "*", "|", ">", "!", "<"))), "")
        sents = _sentences(para)
        return len(sents[0].split()) if sents else 999

    faq = extract_faq_pairs(text)
    faq_ok = [p for p in faq if 20 <= len(p["answer"].split()) <= 90]
    h1 = next((ln for ln in text.splitlines() if re.match(r"^#\s", ln)), "")
    intro = " ".join(lower.split()[:150])
    f = (focus or "").strip().lower()
    cites = len(_CITE_RE.findall(text))
    links = _LINK_RE.findall(text)
    internal = [u for _, u in links if u in internal_urls]
    rs = research or {}

    checks: list[tuple[str, str, int, bool | None, str]] = [
        # id, label, weight, ok (None = not applicable), detail
        ("kw_intro", "Focus keyphrase in H1 or opening", 8, (f in h1.lower() or f in intro) if f else None, ""),
        ("kw_h2", "Focus keyphrase in an H2", 4, any(f in h.lower() for h, _ in sections) if f else None, ""),
        ("depth", "Depth: 900+ words", 6, words >= 900, f"{words} words"),
        ("internal_links", "2+ internal links", 8, (len(set(internal)) >= 2) if internal_urls else None, f"{len(set(internal))} internal"),
        ("question_h2", "Question-style H2s (40%+)", 8, bool(sections) and len(questions) / len(sections) >= 0.4, f"{len(questions)}/{len(sections)}"),
        ("answer_first", "H2 questions answered in the first sentence", 8,
         (sum(first_sentence_words(b) <= 30 for _, b in questions) >= 0.7 * len(questions)) if questions else None, ""),
        ("faq", "FAQ with 3+ questions", 8, len(faq) >= 3, f"{len(faq)} pairs"),
        ("faq_len", "FAQ answers 20-90 words", 4, (len(faq_ok) >= 0.7 * len(faq)) if faq else None, ""),
        ("takeaways", "Key takeaways summary", 5, "key takeaways" in lower, ""),
        ("table", "Comparison or data table", 4, bool(re.search(r"(?m)^\|.+\|\s*$", text)), ""),
        ("citations", "3+ cited sources", 10, cites >= 3 if rs.get("status") == "ok" else None, f"{cites} citations"),
        ("claims", "No unsupported statistics or cases", 8,
         (not rs.get("unsupported_after")) if rs.get("status") == "ok" else None, ", ".join(rs.get("unsupported_after") or [])[:200]),
        ("freshness", "Dated facts (as of / year)", 4, bool(re.search(r"\bas of\b|\b20[12]\d\b", lower)), ""),
        ("structure", "Prose-led section structure", 6, bool(structure_report(text).get("passed")), ""),
        ("clean", "No AI-tell phrases or em dashes", 4,
         not any(p in lower for p in AI_DETECTOR_BANNED_PHRASES) and "\u2014" not in text, ""),
    ]
    compliance: list[str] = []
    if profile == "legal":
        if "not legal advice" not in lower:
            compliance.append("Missing 'not legal advice' disclaimer")
        compliance += [f"Bar Council: '{m.group(0)}'" for m in _BCI_BANNED.finditer(plain)][:5]
        if _OLD_CODE_RE.search(plain) and not _NEW_CODE_RE.search(plain):
            compliance.append("Cites IPC/CrPC/Evidence Act without the BNS/BNSS/BSA equivalent")
        checks.append(("compliance", "Legal compliance (disclaimer, BCI, new codes)", 8, not compliance, "; ".join(compliance)))

    applicable = [c for c in checks if c[3] is not None]
    total = sum(c[2] for c in applicable) or 1
    earned = sum(c[2] for c in applicable if c[3])
    return {
        "score": round(100 * earned / total),
        "checks": [{"id": c[0], "label": c[1], "weight": c[2], "ok": c[3], "detail": c[4]} for c in checks],
        "compliance_issues": compliance,
    }
