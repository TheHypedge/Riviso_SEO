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
_FAQ_RE = re.compile(r"faq|frequently asked", re.IGNORECASE)


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
