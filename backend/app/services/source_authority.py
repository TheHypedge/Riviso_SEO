"""
Authority tier of an outbound link's domain, used to keep only trustworthy external sources.

    1 official    governments, courts, regulators, universities, intergovernmental bodies
    2 reputable   peer-reviewed research, official statistics, standards bodies, established
                  newsrooms and research firms, the niche's own trusted sources
    3 unknown     anything else (allowed, ranked below 1-2)
    4 low         blogs, forums, social media, Q&A, content farms, link shorteners (never linked)

Heuristic by design: live Domain/Page Authority needs a paid Moz/Ahrefs API. If one is added,
it plugs in here as a tie-breaker without changing any caller.
"""
from __future__ import annotations

import re
from urllib.parse import urlsplit

OFFICIAL, REPUTABLE, UNKNOWN, LOW = 1, 2, 3, 4
LABELS = {OFFICIAL: "official", REPUTABLE: "reputable", UNKNOWN: "unrated", LOW: "low-authority"}

# Government / academic / intergovernmental TLD patterns (host suffixes).
_OFFICIAL_SUFFIX = re.compile(
    r"(\.gov|\.gov\.[a-z]{2}|\.gc\.ca|\.gouv\.[a-z]{2}|\.govt\.[a-z]{2}|\.nic\.in|\.mil|\.edu|\.edu\.[a-z]{2}"
    r"|\.ac\.[a-z]{2}|\.int|\.europa\.eu|\.judiciary\.[a-z]+|\.courts\.[a-z.]+)$"
)
_OFFICIAL_DOMAINS = {
    "un.org", "worldbank.org", "imf.org", "oecd.org", "europa.eu", "wto.org", "unesco.org", "unicef.org", "ilo.org",
    "who.int", "sci.gov.in", "rbi.org.in", "sebi.gov.in", "ibbi.gov.in", "irdai.gov.in", "uidai.gov.in",
    "incometax.gov.in", "incometaxindia.gov.in", "indiacode.nic.in", "legislative.gov.in", "egazette.gov.in",
    "allahabadhighcourt.in", "federalreserve.gov", "sec.gov", "ftc.gov", "bankofengland.co.uk", "ecb.europa.eu",
}
_REPUTABLE_DOMAINS = {
    # research & reference
    "ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov", "nature.com", "science.org", "sciencedirect.com", "springer.com",
    "link.springer.com", "wiley.com", "onlinelibrary.wiley.com", "thelancet.com", "nejm.org", "bmj.com",
    "jamanetwork.com", "cochranelibrary.com", "cochrane.org", "ieee.org", "acm.org", "jstor.org", "ssrn.com",
    "arxiv.org", "plos.org", "frontiersin.org", "mdpi.com", "britannica.com", "iso.org", "w3.org", "ietf.org",
    "mayoclinic.org", "clevelandclinic.org", "hopkinsmedicine.org", "nhs.uk",
    # statistics & research firms
    "statista.com", "pewresearch.org", "gallup.com", "mckinsey.com", "deloitte.com", "pwc.com", "ey.com",
    "kpmg.com", "gartner.com", "forrester.com", "bcg.com", "hbr.org", "brookings.edu", "nber.org", "prsindia.org",
    # established newsrooms
    "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "ft.com", "wsj.com", "bloomberg.com", "economist.com",
    "nytimes.com", "washingtonpost.com", "theguardian.com", "cnbc.com", "npr.org", "thehindu.com",
    "indianexpress.com", "livemint.com", "business-standard.com", "economictimes.indiatimes.com",
    "hindustantimes.com", "thehindubusinessline.com", "moneycontrol.com", "ndtv.com",
    # legal (India)
    "indiankanoon.org", "livelaw.in", "barandbench.com", "scobserver.in", "lawcommissionofindia.nic.in",
}
_LOW_DOMAINS = {
    "medium.com", "quora.com", "reddit.com", "pinterest.com", "facebook.com", "instagram.com", "twitter.com",
    "x.com", "tiktok.com", "linkedin.com", "scribd.com", "slideshare.net", "answers.com", "ehow.com",
    "wikihow.com", "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "buff.ly", "rebrand.ly", "lnkd.in",
    "blogger.com", "telegram.me", "t.me", "whatsapp.com", "studocu.com", "coursehero.com", "chegg.com",
}
_LOW_SUFFIX = re.compile(r"\.(blogspot\.[a-z.]+|wordpress\.com|wixsite\.com|weebly\.com|tumblr\.com|substack\.com|"
                         r"medium\.com|webnode\.[a-z]+|jimdosite\.com|site123\.me|godaddysites\.com)$")


def _host(url: str) -> str:
    try:
        return urlsplit((url or "").strip()).netloc.lower().split("@")[-1].split(":")[0].removeprefix("www.")
    except ValueError:
        return ""


def _matches(host: str, domains: set[str] | list[str] | tuple[str, ...]) -> bool:
    return any(host == d or host.endswith("." + d) for d in domains)


def authority_tier(url: str, *, trusted: list[str] | tuple[str, ...] | None = None) -> int:
    """1 official .. 4 low. ``trusted`` = the niche's allow-list (treated as at least reputable)."""
    host = _host(url)
    if not host:
        return LOW
    if _matches(host, _LOW_DOMAINS) or _LOW_SUFFIX.search("." + host):
        return LOW
    if _OFFICIAL_SUFFIX.search("." + host) or _matches(host, _OFFICIAL_DOMAINS):
        return OFFICIAL
    if _matches(host, _REPUTABLE_DOMAINS) or (trusted and _matches(host, trusted)):
        return REPUTABLE
    return UNKNOWN


def is_low_authority(url: str) -> bool:
    return authority_tier(url) == LOW
