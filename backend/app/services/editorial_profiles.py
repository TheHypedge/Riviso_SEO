"""
Niche editorial profiles: the house style a professional publication in that niche follows.

The general human-writing guardrail applies to every article. A profile layers the
conventions of one kind of site on top (structure, citation, accuracy, compliance) and
overrides the general guardrail where they conflict. The user's writing prompt still
decides angle, tone, length and focus; the profile's accuracy and compliance rules do not
bend to it.

Add a niche by adding a profile string to ``_PROFILES`` and a pattern to ``_DETECT``.
"""
from __future__ import annotations

import re
from typing import Any

# Built from studying well-ranked Indian legal publishers (statute-led explainers and
# data-backed, footnoted guides): answer first, precise citation, settled vs unsettled law
# made explicit, and Bar Council of India advertising limits respected.
LEGAL_PROFILE = """
This is a legal website. Write the way a careful Indian legal publisher writes: precise,
verifiable and easy for a non-lawyer to follow. These rules override the general guardrail
where they conflict (for example, opening with a definition is right here, and casual
asides, slang and a forced question to the reader are not).

### Voice
- Formal, measured and plain-English. Mostly third person ("the accused", "the applicant"). Use "you" sparingly, only when speaking to the person affected.
- Define each legal term or Latin phrase in plain words the first time it appears (e.g. "amicus curiae, a lawyer appointed to assist the court").
- Hedge exactly as much as the law does: "usually", "the court may", "High Courts have differed". Never overstate.

### Structure
- Open with the direct answer: what the provision or remedy is and when it applies, in the first two sentences. No scene-setting before the answer.
- Directly after the H1, add a short "Key takeaways" block written as a markdown blockquote: a bold label line, then 4-6 bullets, each a complete, self-contained fact (a deadline, a test, who it covers).
- Phrase most ## H2 headings as the questions readers actually ask ("By when must the application be filed?"). The first sentence under each such heading answers it directly; the rest of the section explains.
- Explain a provision in this order where it fits: what the law says, its essential ingredients or the legal test (numbered), how it works in practice, what it does not cover, and the remedy or next step.
- When two procedures or provisions are commonly confused, include one comparison table (e.g. "Point | Route A | Route B").
- Mark hypotheticals clearly as illustrations, use neutral party names (A, B, Z), and write "This is an illustration, not a real case."
- Choose sections to fit the topic. Never pad with a generic "Importance" or "Conclusion" section.

### Citing the law
- Name an Act in full with its year on first mention ("the Arbitration and Conciliation Act, 1996"), then a short form.
- Cite sections precisely, down to sub-section and clause where it matters ("Section 8(1)", "Order XXXVII Rule 3(5) CPC").
- New criminal codes: the Bharatiya Nyaya Sanhita, 2023 (BNS), Bharatiya Nagarik Suraksha Sanhita, 2023 (BNSS) and Bharatiya Sakshya Adhiniyam, 2023 (BSA) replaced the IPC, CrPC and Indian Evidence Act from 1 July 2024. Cite the new provision first and the old one in brackets: "Section 187 BNSS (old Section 167 CrPC)". Mention that matters begun before 1 July 2024 can continue under the old code where relevant.
- If you are not certain of the exact new section number, do not guess a number. Name the new code and the old section ("the corresponding BNSS provision (old Section 438 CrPC)").
- Cite a judgment only when you are certain of its party names, court and year: "*Name v. Name* (Supreme Court, 2019)". Add a neutral citation (e.g. "2025 INSC 687") only if you are certain of it. Never invent a case, a citation, a date or a holding. If unsure, rely on the statute instead.
- Paraphrase holdings; do not fabricate quotations from judgments. Say whether a point is settled, pending before a larger bench, or an observation rather than the ruling.

### Numbers and facts
- Use exact figures from the law: limitation periods, deadlines, punishment ranges, thresholds ("within 60 days", "imprisonment up to two years, or a fine up to twice the cheque amount").
- Never state a statistic, percentage or count unless it is well established and you can name its source and period. No "studies show" or invented data.
- Attach a date or period to any figure that can change ("as of 2025").

### Links
- External links go to primary sources only: indiacode.nic.in, legislative.gov.in, sci.gov.in, egazette.gov.in, High Court websites, regulators (rbi.org.in, sebi.gov.in, ibbi.gov.in), prsindia.org and indiankanoon.org for judgments.

### Professional compliance (Bar Council of India Rule 36, non-negotiable)
- No solicitation or self-praise: never "best lawyer", "top advocate", "No. 1 law firm", "guaranteed result", success rates or client testimonials.
- No hard-sell calls to action ("call now", "hire us today"). A neutral line such as "consult a qualified advocate about the facts of your case" is fine.
- End the article with one italic line: "This article is general information, not legal advice."

### FAQ
- Include a ## Frequently Asked Questions section of 3-7 real search questions near the end, in the required ### question format. Each answer is 30-70 words and opens with the direct answer ("Yes.", "No.", "Within 90 days.") before one qualifier.
""".strip()

_PROFILES: dict[str, str] = {
    "general": "",
    "legal": LEGAL_PROFILE,
}

_DETECT: dict[str, re.Pattern[str]] = {
    "legal": re.compile(
        r"\b(law\s?firms?|legal|lawyers?|advocates?|attorneys?|solicitors?|barristers?|litigation|"
        r"judiciary|high court|supreme court|criminal defen[cs]e|divorce law|ipc|crpc|bns|bnss)\b",
        re.IGNORECASE,
    ),
}


def resolve_editorial_profile(project: dict[str, Any] | None) -> str:
    """Explicit ``editorial_profile`` on the project wins; otherwise detect from its niche."""
    p = project or {}
    explicit = str(p.get("editorial_profile") or "").strip().lower()
    if explicit in _PROFILES:
        return explicit
    text = " ".join(str(p.get(k) or "") for k in ("niche_topic", "niche_identifier", "name"))
    for key, rx in _DETECT.items():
        if rx.search(text):
            return key
    return "general"


def format_editorial_profile_for_system_prompt(profile: str | None) -> str:
    body = _PROFILES.get((profile or "").strip().lower(), "")
    return f"\n\n# NICHE EDITORIAL STYLE ({profile.upper()})\n\n{body}\n" if body else ""


# Live research (research_pipeline.py): where each niche's facts may come from, and what to look for.
# ``None`` domains = no allow-list; the general guardrail's "official primary sources" rule still steers it.
RESEARCH_DOMAINS: dict[str, list[str] | None] = {
    "general": None,
    "legal": [
        "indiacode.nic.in", "legislative.gov.in", "egazette.gov.in", "sci.gov.in", "main.sci.gov.in",
        "indiankanoon.org", "prsindia.org", "lawcommissionofindia.nic.in", "doj.gov.in", "njdg.ecourts.gov.in",
        "ecourts.gov.in", "ncrb.gov.in", "nalsa.gov.in", "mha.gov.in", "rbi.org.in", "sebi.gov.in",
        "ibbi.gov.in", "mca.gov.in", "incometaxindia.gov.in", "cbic.gov.in", "delhihighcourt.nic.in",
        "bombayhighcourt.nic.in", "hcmadras.tn.gov.in", "allahabadhighcourt.in", "highcourtchd.gov.in",
        "karnatakajudiciary.kar.nic.in", "hckerala.gov.in", "calcuttahighcourt.gov.in", "livelaw.in",
        "barandbench.com", "scobserver.in",
    ],
}

RESEARCH_HINTS: dict[str, str] = {
    "general": (
        "official definitions, current figures with their period and publisher, rules and regulations, "
        "step-by-step procedures, eligibility conditions, costs and fees, and named real-world examples"
    ),
    "legal": (
        "the exact statute and section numbers (and, for criminal law, the BNS/BNSS/BSA section with its old "
        "IPC/CrPC/Evidence Act equivalent), limitation periods and deadlines, punishments, the legal test or "
        "ingredients, leading Supreme Court and High Court judgments (exact party names, court, year, neutral "
        "citation if shown, the holding, and whether it is settled, pending before a larger bench or an interim "
        "order), and official statistics (NCRB, NJDG, court annual reports) with their period"
    ),
}


def research_domains(profile: str | None) -> list[str] | None:
    return RESEARCH_DOMAINS.get((profile or "general").strip().lower())


def research_hints(profile: str | None) -> str:
    return RESEARCH_HINTS.get((profile or "").strip().lower()) or RESEARCH_HINTS["general"]
