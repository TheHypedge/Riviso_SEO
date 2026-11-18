"""
Evidence-first research for article generation (live web search via the OpenAI Responses API).

Flow, each step degrading instead of failing the article:

1. plan      - one cheap call turns title/keyword into reader questions + search angles.
2. search    - 2 parallel web searches (niche domain allow-list, target country) return a
               JSON fact list; only facts whose source_url the search actually cited/read survive.
3. verify    - Riviso fetches each source page itself and checks the fact's figures/names are on it.
               verified = found, cited = page unreadable (PDF/bot wall), unconfirmed/dead = dropped.
4. prompt    - verified facts go to the writer as [F#] markers; the writer may not cite anything else.
5. citations - markers become numbered source links + a "Sources" section (URLs come from the
               pack, never from the model), and stray model-written external links are unlinked.
6. claims    - statistics, money figures and case citations in the article that the pack does not
               support are listed so one revision pass can remove or source them.

Any failure returns ``None``/the input unchanged and the caller writes the article the old way.
"""
from __future__ import annotations

import asyncio
import html
import logging
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from app.core.config import settings
from app.services.editorial_profiles import research_domains, research_hints
from app.services.source_authority import LABELS, LOW, UNKNOWN, authority_tier
from app.services.url_guard import SsrfError, assert_public_http_url, ssrf_guarded_event_hooks

log = logging.getLogger(__name__)

MAX_FACTS = 25
MIN_FACTS = 3  # fewer usable facts than this = not worth constraining the writer
_MARKER_RE = re.compile(r"\[(F\d+(?:\s*,\s*F\d+)*)\]")
_LINK_RE = re.compile(r"(?<!!)\[([^\[\]\n]+)\]\((https?://[^\s)]+)\)")
_CITE_RUN_RE = re.compile(r"(?:\[\[\d+\]\]\([^)\s]+\)\s*)+\[\[\d+\]\]\([^)\s]+\)")


# ---------------------------------------------------------------- helpers

def _host(u: str) -> str:
    return urlsplit(u).netloc.lower().removeprefix("www.")


def _host_allowed(u: str, domains: list[str] | None) -> bool:
    if not domains:
        return True
    h = _host(u)
    return any(h == d or h.endswith("." + d) for d in domains)


def _squash(s: str) -> str:
    return re.sub(r"[\s,]+", " ", html.unescape(s or "")).lower()


def _evidence_tokens(fact: dict[str, Any]) -> list[str]:
    """Figures and proper names that must appear on the source page for the fact to count as verified."""
    text = f"{fact.get('value') or ''} {fact.get('claim') or ''}"
    nums = {n.replace(",", "") for n in re.findall(r"\d[\d,]*(?:\.\d+)?", text) if len(n.replace(",", "")) >= 2}
    # "Hardeep Singh v. State of Punjab" -> "hardeep singh"
    names = {m.strip().lower() for m in re.findall(r"([A-Z][a-zA-Z.&']+(?:\s+[A-Z][a-zA-Z.&']+)?)\s+v(?:s)?\.?\s", text)}
    return sorted(nums | names)


# ---------------------------------------------------------------- 1. plan

async def _plan(client: Any, model: str, *, title: str, focus: str, keywords: list[str], profile: str) -> dict[str, Any]:
    system = (
        "You plan research for an expert article. Return ONLY JSON: "
        '{"intent": "definition|procedure|deadline|comparison|remedy|guide|other", '
        '"core_answer": "the 1-2 sentence answer a searcher wants", '
        '"questions": ["6-9 real questions searchers ask about this topic, most important first"], '
        '"angles": ["3-5 short research angles to look up"]}'
    )
    user = f"Title: {title}\nFocus keyphrase: {focus}\nKeywords: {', '.join(keywords)}\nSite type: {profile}"
    try:
        obj = await asyncio.wait_for(client.chat_json(model=model, system=system, user=user), timeout=60)
    except Exception:
        log.warning("Research plan failed; searching on the title alone", exc_info=True)
        obj = {}
    qs = [str(q).strip() for q in (obj.get("questions") or []) if str(q).strip()][:9]
    return {
        "intent": str(obj.get("intent") or "other"),
        "core_answer": str(obj.get("core_answer") or "").strip(),
        "questions": qs or [title],
        "angles": [str(a).strip() for a in (obj.get("angles") or []) if str(a).strip()][:5],
    }


# ---------------------------------------------------------------- 2. search

_SEARCH_PROMPT = """Research this topic on the web for an expert article and write detailed research notes as a bullet list.

Article: {title}
Focus keyphrase: {focus}
Questions to answer:
{questions}

Look especially for: {hints}.
Use only authoritative sources: government and official bodies, courts and regulators, universities,
peer-reviewed research, official statistics and major established publications. Never use blogs,
forums, social media, Q&A sites or content farms. Prefer the primary source of a figure over a page quoting it.

Each bullet is ONE precise, self-contained fact on its own line: exact figures, section numbers, deadlines, names, dates and the period a figure refers to. Cite the source for every bullet. Write 10-16 bullets and nothing from memory."""

_EXTRACT_SYSTEM = (
    "You turn cited research notes into structured facts. Return ONLY JSON: "
    '{"facts": [{"segment": "S3", "claim": "one self-contained factual sentence, faithful to the note", '
    '"value": "the key figure, section, deadline, name or date", "type": "statute|case|deadline|statistic|definition|procedure|other", '
    '"as_of": "date or period if the note states one", "status": "settled|pending|interim|unclear"}]}. '
    "Use only what each note says; never add information. One fact per useful note; skip notes with nothing concrete."
)


def _clean_url(u: str) -> str:
    """Drop tracking params (the search tags every URL with utm_source) but keep the URL otherwise intact."""
    p = urlsplit(u)
    query = "&".join(q for q in p.query.split("&") if q and not q.lower().startswith(("utm_", "fbclid", "gclid")))
    return urlunsplit((p.scheme, p.netloc, p.path, query, p.fragment))


async def _search(client: Any, model: str, *, title: str, focus: str, questions: list[str], profile: str,
                  domains: list[str] | None, country: str | None) -> tuple[list[dict], dict[str, Any]]:
    prompt = _SEARCH_PROMPT.format(
        title=title, focus=focus or title, questions="\n".join(f"- {q}" for q in questions), hints=research_hints(profile)
    )
    res = await client.web_search(model=model, prompt=prompt, allowed_domains=domains, country=country)
    # Grounding by construction: a fact's URL is the citation the search attached to that exact note,
    # never a URL the model typed. Notes outside the niche allow-list (unfiltered fallback search) are dropped.
    segs: list[dict] = []
    seen: set[tuple[str, str]] = set()
    off_list = low = 0
    for sg in res.get("segments") or []:
        url = _clean_url(sg["url"])
        if not _host_allowed(url, domains):
            off_list += 1
            continue
        if authority_tier(url, trusted=domains) == LOW:
            low += 1  # blogs, forums, social, content farms: never a source
            continue
        key = (sg["text"], url)
        if key not in seen:
            seen.add(key)
            segs.append({"id": f"S{len(segs) + 1}", "text": sg["text"], "url": url, "title": sg.get("title") or ""})
    meta = {"queries": res.get("queries") or [], "segments": len(segs), "off_list_dropped": off_list, "low_authority_dropped": low,
            "domain_filter_applied": bool(res.get("domain_filter_applied"))}
    if not segs:
        return [], meta
    by_id = {sg["id"]: sg for sg in segs}
    notes = "\n".join(f"[{sg['id']}] {sg['text']}" for sg in segs)
    obj = await asyncio.wait_for(client.chat_json(model=model, system=_EXTRACT_SYSTEM, user=f"Topic: {title}\n\nNotes:\n{notes}"), timeout=90)
    facts: list[dict] = []
    for f in obj.get("facts") or []:
        sg = by_id.get(str((f or {}).get("segment") or "").strip()) if isinstance(f, dict) else None
        if not sg or not str(f.get("claim") or "").strip():
            continue
        facts.append({
            "claim": str(f.get("claim")).strip()[:400],
            "value": str(f.get("value") or "").strip()[:200],
            "type": str(f.get("type") or "other").strip()[:20],
            "source_url": sg["url"],
            "source_title": sg["title"][:200],
            "authority": authority_tier(sg["url"], trusted=domains),
            "note": sg["text"][:400],
            "as_of": str(f.get("as_of") or "").strip()[:60],
            "status": str(f.get("status") or "").strip()[:20],
        })
    meta["extracted"] = len(facts)
    return facts, meta


# ---------------------------------------------------------------- 3. verify

async def _fetch_text(client: httpx.AsyncClient, url: str) -> tuple[str, str]:
    """(state, text): state is ok | dead | unreadable."""
    try:
        assert_public_http_url(url)
        res = await client.get(url)
    except (httpx.ConnectError, httpx.InvalidURL, httpx.UnsupportedProtocol, SsrfError):
        return "dead", ""
    except httpx.HTTPError:
        return "unreadable", ""
    if res.status_code in (404, 410):
        return "dead", ""
    ctype = res.headers.get("content-type", "")
    if res.status_code >= 400 or "html" not in ctype and "text" not in ctype:
        return "unreadable", ""  # bot wall, PDF, etc.
    body = res.text[:2_000_000]
    body = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", body)
    return "ok", _squash(re.sub(r"<[^>]+>", " ", body))


async def _verify(facts: list[dict]) -> None:
    urls = sorted({f["source_url"] for f in facts})
    headers = {"user-agent": "Mozilla/5.0 (compatible; RivisoResearch/1.0; +https://riviso.cloud)"}
    sem = asyncio.Semaphore(6)
    pages: dict[str, tuple[str, str]] = {}
    async with httpx.AsyncClient(timeout=httpx.Timeout(12.0), follow_redirects=True, headers=headers,
                                 event_hooks=ssrf_guarded_event_hooks()) as client:
        async def one(u: str) -> None:
            async with sem:
                pages[u] = await _fetch_text(client, u)
        await asyncio.gather(*(one(u) for u in urls))
    for f in facts:
        state, text = pages.get(f["source_url"], ("unreadable", ""))
        tokens = _evidence_tokens(f)
        if state == "dead":
            f["verification"] = "dead"
        elif state != "ok" or not tokens:
            f["verification"] = "cited"
        else:
            hits = sum(1 for t in tokens if t in text or t.replace(" ", "") in text.replace(" ", ""))
            f["verification"] = "verified" if hits >= max(1, (len(tokens) + 1) // 2) else "unconfirmed"


# ---------------------------------------------------------------- orchestration

def research_enabled(project: dict[str, Any] | None) -> bool:
    """Project override (``research_enabled``) wins over the global RESEARCH_PIPELINE_ENABLED flag."""
    v = (project or {}).get("research_enabled")
    if isinstance(v, bool):
        return v
    return bool(settings.research_pipeline_enabled)


def project_country(project: dict[str, Any] | None) -> str | None:
    p = project or {}
    codes = [str(c).strip().upper() for c in (p.get("target_countries") or []) if str(c).strip()]
    return codes[0] if len(codes) == 1 and not p.get("target_countries_all") else None


async def build_research_pack(*, title: str, focus: str, keywords: list[str], profile: str,
                              country: str | None = None) -> dict[str, Any]:
    """Always returns a pack dict; ``pack["status"]`` is ok | thin | failed. Never raises."""
    started = datetime.now(timezone.utc)
    pack: dict[str, Any] = {"status": "failed", "profile": profile, "generated_at": started.strftime("%Y-%m-%d %H:%M:%S"),
                            "facts": [], "error": ""}
    try:
        from app.services.openai_client import OpenAIClient

        client = OpenAIClient()
        model = settings.openai_research_model or settings.openai_text_model
        plan = await _plan(client, model, title=title, focus=focus, keywords=keywords, profile=profile)
        pack.update(plan)
        domains = research_domains(profile)
        qs = plan["questions"] + plan["angles"]
        halves = [qs[0::2], qs[1::2]] if len(qs) > 3 else [qs]
        results = await asyncio.gather(
            *(_search(client, model, title=title, focus=focus, questions=h, profile=profile, domains=domains, country=country)
              for h in halves if h),
            return_exceptions=True,
        )
        facts: list[dict] = []
        seen: set[str] = set()
        metas: list[dict] = []
        errors = []
        for r in results:
            if isinstance(r, BaseException):
                errors.append(f"{type(r).__name__}: {str(r)[:200]}")
                continue
            got, meta = r
            metas.append(meta)
            for f in got:
                key = re.sub(r"\W+", " ", f["claim"].lower()).strip()
                if key not in seen:
                    seen.add(key)
                    facts.append(f)
        if not facts:
            pack["error"] = "; ".join(errors) or "web search returned no cited facts"
            pack["searches"] = metas
            pack["seconds"] = round((datetime.now(timezone.utc) - started).total_seconds(), 1)
            return pack
        try:
            await asyncio.wait_for(_verify(facts), timeout=60)
        except Exception:
            log.warning("Source verification timed out; facts kept as cited", exc_info=True)
            for f in facts:
                f.setdefault("verification", "cited")
        usable = [f for f in facts if f.get("verification") in ("verified", "cited")]
        # Strongest evidence first: official sources, then reputable, each verified before cited-only.
        usable.sort(key=lambda f: (f.get("authority", UNKNOWN), f.get("verification") != "verified"))
        usable = usable[:MAX_FACTS]
        for i, f in enumerate(usable, 1):
            f["id"] = f"F{i}"
        pack["facts"] = usable
        pack["rejected"] = [{"claim": f["claim"][:160], "reason": f.get("verification")} for f in facts if f not in usable]
        pack["searches"] = metas
        pack["errors"] = errors
        pack["status"] = "ok" if len(usable) >= MIN_FACTS else "thin"
    except Exception as e:  # research must never break generation
        log.warning("Research pipeline failed", exc_info=True)
        pack["error"] = f"{type(e).__name__}: {str(e)[:300]}"
    pack["seconds"] = round((datetime.now(timezone.utc) - started).total_seconds(), 1)
    return pack


# ---------------------------------------------------------------- 4. prompt

def format_research_for_prompt(pack: dict[str, Any] | None) -> str:
    if not pack or pack.get("status") != "ok":
        return ""
    lines = [
        "\n\n# VERIFIED RESEARCH PACK (live web research, " + pack.get("generated_at", "")[:10] + ")",
        "These facts were collected from live sources and checked against the source pages.",
    ]
    if pack.get("core_answer"):
        lines.append(f"\nCore answer searchers want: {pack['core_answer']}")
    if pack.get("questions"):
        lines.append("\nQuestions readers ask (use for H2 headings and the FAQ):")
        lines += [f"- {q}" for q in pack["questions"]]
    lines.append("\nFacts:")
    for f in pack.get("facts") or []:
        bits = [f["claim"]]
        if f.get("as_of"):
            bits.append(f"as of {f['as_of']}")
        if f.get("status") and f["status"] not in ("settled", "unclear"):
            bits.append(f"status: {f['status']}")
        bits.append(f"source: {f.get('source_title') or _host(f['source_url'])} ({_host(f['source_url'])}, "
                    f"{LABELS.get(f.get('authority', UNKNOWN), 'unrated')})")
        lines.append(f"[{f['id']}] " + " | ".join(bits))
    lines.append(
        "\nRESEARCH RULES (these replace the external-link rules above):\n"
        "- Build the article on these facts. Cite every fact you use by writing its marker right after the sentence, e.g. "
        "\"The application must be filed within 90 days.[F3]\"\n"
        "- Cite at least 6 different facts from at least 4 different sources, spread across the sections, and prefer "
        "official sources over the rest. Every cited source becomes an outbound link, so the data you use credits its publisher.\n"
        "- Every statistic, percentage, money amount, case citation and date-specific claim MUST come from this pack and carry its marker.\n"
        "- Do NOT write any external URL or external markdown link yourself. Sources are attached automatically from the markers.\n"
        "- If something you want to say is not in the pack and is not basic, settled knowledge, leave it out.\n"
        "- Keep the pack's exact figures, names and section numbers. Mention 'as of' periods where the pack gives them."
    )
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- 5. citations

def apply_citations(md: str, pack: dict[str, Any] | None, *, trusted_urls: set[str] | frozenset[str] = frozenset()) -> tuple[str, list[str]]:
    """Turn [F#] markers into numbered source links and append a Sources section.

    Also unlinks model-written external links that are not pack sources or trusted (mapped) pages.
    Returns (markdown, source_urls_in_order). Without a usable pack only stray markers are removed.
    """
    facts = {f["id"]: f for f in (pack or {}).get("facts") or [] if f.get("id")}
    order: list[str] = []
    titles: dict[str, str] = {}

    def num_for(fid: str) -> int | None:
        f = facts.get(fid)
        if not f:
            return None
        url = f["source_url"]
        if url not in order:
            order.append(url)
            titles[url] = f.get("source_title") or _host(url)
        return order.index(url) + 1

    def repl(m: re.Match) -> str:
        nums: list[int] = []
        for fid in re.split(r"\s*,\s*", m.group(1)):
            n = num_for(fid.strip())
            if n and n not in nums:
                nums.append(n)
        return "".join(f"[[{n}]]({order[n - 1]})" for n in nums)

    out = _MARKER_RE.sub(repl, md or "")
    # Adjacent markers often point at the same source ("[3][3][1]"): keep each number once per run.
    out = _CITE_RUN_RE.sub(lambda m: "".join(dict.fromkeys(re.findall(r"\[\[\d+\]\]\([^)\s]+\)", m.group(0)))), out)
    if not facts:
        return out, []
    allowed = set(order) | set(trusted_urls)

    def unlink(m: re.Match) -> str:
        return m.group(0) if m.group(2) in allowed or re.fullmatch(r"\[\d+\]", m.group(1)) else m.group(1)

    out = _LINK_RE.sub(unlink, out)
    if order:
        refs = "\n".join(f"{i}. [{titles[u]}]({u}) ({_host(u)})" for i, u in enumerate(order, 1))
        out = out.rstrip() + "\n\n## Sources\n\n" + refs + "\n"
    return out, order


# ---------------------------------------------------------------- 6. claims

_PCT_RE = re.compile(r"\b\d+(?:\.\d+)?\s?(?:%|per\s?cent\b)", re.I)
_MONEY_RE = re.compile(r"(?:₹|\bRs\.?|\bINR|\$|\bUSD)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:lakh|crore|million|billion))?", re.I)
_CASE_RE = re.compile(r"\*?([A-Z][\w.&'@-]*(?:\s+[A-Z@][\w.&'-]*){0,5})\s+v(?:s)?\.\s+([A-Z][\w.&'-]*(?:\s+(?:of\s+)?[A-Z][\w.&'-]*){0,5})\*?")
_NEUTRAL_RE = re.compile(r"\b\d{4}\s+INSC\s+\d+\b")


def unsupported_claims(md: str, pack: dict[str, Any] | None) -> list[str]:
    """Statistics, money figures and case citations in ``md`` that no pack fact supports."""
    if not pack or pack.get("status") != "ok":
        return []
    body = re.split(r"\n##\s+Sources\b", md or "")[0]
    hay = _squash(" ".join(f"{f.get('claim')} {f.get('value')} {f.get('source_title')}" for f in pack.get("facts") or []))
    found: list[str] = []
    for rx in (_PCT_RE, _MONEY_RE, _NEUTRAL_RE):
        for m in rx.finditer(body):
            token = m.group(0).strip()
            digits = re.sub(r"[^\d.]", "", token)
            if digits and digits not in hay.replace(" ", "") and token not in found:
                found.append(token)
    for m in _CASE_RE.finditer(body):
        first = m.group(1).split()
        if first and first[0].lower() in ("the", "a", "an", "in", "see"):
            first = first[1:]
        party = " ".join(first[:2]).lower()
        if len(party) >= 4 and party not in hay and m.group(0) not in found:
            found.append(m.group(0).strip("* "))
    return found[:20]


async def revise_unsupported(client: Any, model: str, *, md: str, claims: list[str], pack: dict[str, Any]) -> str | None:
    """One targeted fact-check pass. The editor returns sentence-level replacements only, which are
    applied verbatim, so headings, FAQ, lists and links can never be restructured by the revision."""
    system = (
        "You are a meticulous fact-checking editor. Return ONLY JSON: "
        '{"edits": [{"original": "the exact sentence from the article, copied character for character", '
        '"replacement": "the corrected sentence"}]}. '
        "For each listed claim, edit only the sentence that contains it: if a pack fact supports the claim, keep it and "
        "append that fact's [F#] marker; otherwise remove the figure or case citation and rephrase so the sentence stays "
        "accurate and grammatical. Never edit headings."
    )
    user = ("Unsupported claims:\n" + "\n".join(f"- {c}" for c in claims)
            + "\n" + format_research_for_prompt(pack) + "\n\nARTICLE:\n" + md)
    try:
        obj = await asyncio.wait_for(client.chat_json(model=model, system=system, user=user), timeout=180)
    except Exception:
        log.warning("Fact-check revision failed; keeping the original article", exc_info=True)
        return None
    out, applied = md, 0
    for e in obj.get("edits") or []:
        if not isinstance(e, dict):
            continue
        orig, new = str(e.get("original") or "").strip(), str(e.get("replacement") or "").strip()
        # Only unambiguous, in-body, non-heading sentences are touched.
        if len(orig) < 15 or out.count(orig) != 1 or "\n" in orig or orig.lstrip().startswith("#"):
            continue
        out = out.replace(orig, new)
        applied += 1
    return out if applied else None
