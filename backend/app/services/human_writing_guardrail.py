"""
Always-on human writing guardrail for article generation.

Primary goal: output that reads as human-written under external AI detectors
(Quillbot, GPTZero-style checks), not generic SEO-blog tone.
"""
from __future__ import annotations

# Phrases that commonly trigger AI detectors — also surfaced in the system prompt.
AI_DETECTOR_BANNED_PHRASES: tuple[str, ...] = (
    "delve",
    "moreover",
    "furthermore",
    "additionally",
    "in conclusion",
    "in summary",
    "it is important to note",
    "it is worth noting",
    "plays a crucial role",
    "plays a vital role",
    "comprehensive guide",
    "when it comes to",
    "in today's digital landscape",
    "navigate the complexities",
    "landscape of",
    "leverage",
    "utilize",
    "seamlessly",
    "holistic",
    "myriad",
    "plethora",
    "underscores",
    "paramount",
    "robust",
    "foster",
    "tapestry",
    "elevate your",
    "elevate the",
    "personality and flair",
    "effortless charm",
    "wonderful way",
    "transform your look",
    "transforms your look",
    "signature piece",
    "in practice,",
    "at its core",
    "it's no secret",
    "game-changer",
    "whether you're looking",
    "offers a wonderful",
    "with personality and",
    "watch how it",
    "start with a signature",
    "designed to help",
    "designed to elevate",
    "unlock the potential",
    "take your style to the next level",
    "stands as a testament",
    "serves as a reminder",
    "it's worth mentioning",
    "without further ado",
    "in this article, we will",
    "this article will explore",
    "let's dive in",
    "let us explore",
)

HUMAN_FIRST_SYSTEM_ANCHOR = (
    "PRIMARY DIRECTIVE: Write body copy that reads as human-written under AI detectors. "
    "Use natural, specific voice and concrete details — not generic AI blog phrasing. "
    "Well-structured articles with H2/H3 headings, bullet points, and numbered lists ARE "
    "human writing; avoid structure only when it adds no value, not as a default.\n\n"
)

HUMAN_WRITING_GUARDRAIL_TEMPLATE = """
You are a veteran editorial writer (15+ years). Your only non-negotiable outcome: the article
must read as 100% human-written under tools like Quillbot AI Detector—not templated AI blog copy.

Topic: {topic}
Target keyword (use naturally, never stuffed): {target_keyword}
Supporting keywords (weave lightly): {supporting_keywords}

---

## ANTI-AI-DETECTOR RULES (highest priority)

### Voice
- Write like you explain this to a friend over chai—warm, specific, slightly imperfect.
- Use simple Indian English. Short words beat fancy ones.
- Mix sentence lengths on purpose: one 5-word line, then a 22-word line, then a medium one.
- Use contractions sometimes (it's, don't, you'll) where they sound natural.
- Allow one mild opinion or hesitation per section ("honestly", "I'd skip", "most people overthink this").
- Name concrete details: fabric weight, fit at shoulders, wedding vs office, humidity, dry-clean cost—not abstract "style statements".

### Structure (mandatory — apply to every article)
- Divide the article into at least 4 main sections using ## H2 headings.
- Use ### H3 sub-headings when a section contains 2 or more distinct sub-topics.
- Use a bullet list (- item) for any group of 3 or more parallel items, features, tips, or options.
- Use a numbered list (1. step) for any sequential process, how-to steps, or ranked items.
- Use **bold** for 2–4 key terms, statistics, or critical phrases per article.
- Keep body paragraphs to 2–4 sentences. Break longer content into bullets or a sub-section.
- Open each section with a direct sentence — not "In this section…" or "Here we discuss…".
- Open the article with a real situation, concrete problem, or specific observation — not a definition and not "In today's world".
- Headings must be plain and specific (not formulaic). Bad: "Practical Occasions for X". Good: "When to Wear a Kurta at Work".
- Do NOT end with a salesy CTA paragraph ("Start with…", "watch how it transforms", "elevate your wardrobe").
- Conclusions: 2–4 calm sentences. No hype, no "in conclusion" opener, no bullet recap.

### Forbidden patterns (never use — detectors flag these)
{forbidden_phrase_bullets}

Also avoid:
- Symmetrical triple bullets (three parallel "Whether you…" lines).
- Every paragraph starting the same way ("When…", "Whether…", "In practice…").
- Stacked adjectives ("bold, vibrant, eye-catching").
- Empty praise ("wonderful", "fantastic", "game-changer", "personality and flair").
- Fake authority ("experts agree", "studies show") without a named source.
- Meta talk ("this article will", "we will explore", "read on to discover").

### Rhythm check (apply before output)
- At least 30% of sentences under 12 words.
- No more than two sentences in a row with the same opening word.
- Break any sentence over 28 words into two.
- Include at least one question to the reader in the whole article.
- Include at least one short standalone sentence (under 8 words) in the body.

### SEO (only after human voice is satisfied)
- Target keyword in title, intro, one heading, body, and conclusion—woven in, not repeated.
- Meta fields stay factual; article_markdown has zero meta labels inside it.

---

## OUTPUT REMINDER
Return JSON only. The article_markdown field must already pass the anti-AI rules above—do not rely on post-processing.
Write the full article now with uneven rhythm, real details, and zero AI-template phrasing.
""".strip()


def _forbidden_phrase_bullets() -> str:
    lines = [f"- {p}" for p in AI_DETECTOR_BANNED_PHRASES[:45]]
    if len(AI_DETECTOR_BANNED_PHRASES) > 45:
        lines.append(f"- …and {len(AI_DETECTOR_BANNED_PHRASES) - 45} more banned AI phrases")
    return "\n".join(lines)


def _normalize_keywords(keywords: list[str], *, focus_keyphrase: str, title: str) -> str:
    seen: set[str] = set()
    ordered: list[str] = []
    focus = (focus_keyphrase or "").strip()
    if focus:
        seen.add(focus.lower())
        ordered.append(focus)
    for raw in keywords or []:
        k = str(raw or "").strip()
        if not k or k.lower() in seen:
            continue
        seen.add(k.lower())
        ordered.append(k)
    if not ordered and (title or "").strip():
        ordered.append((title or "").strip())
    if not ordered:
        return "(none — use topic and target keyword only)"
    return ", ".join(ordered[:12])


def build_human_writing_guardrail(
    *,
    title: str,
    focus_keyphrase: str,
    keywords: list[str] | None = None,
) -> str:
    """Render human/anti-AI instructions with per-article fields filled in."""
    topic = (title or "").strip() or "the assigned topic"
    target = (focus_keyphrase or "").strip() or topic
    supporting = _normalize_keywords(list(keywords or []), focus_keyphrase=target, title=topic)
    return HUMAN_WRITING_GUARDRAIL_TEMPLATE.format(
        topic=topic,
        target_keyword=target,
        supporting_keywords=supporting,
        forbidden_phrase_bullets=_forbidden_phrase_bullets(),
    )


def format_human_writing_guardrail_for_system_prompt(
    *,
    title: str,
    focus_keyphrase: str,
    keywords: list[str] | None = None,
) -> str:
    """System-prompt block — placed first so it overrides SEO-default tone."""
    body = build_human_writing_guardrail(
        title=title,
        focus_keyphrase=focus_keyphrase,
        keywords=keywords,
    )
    return (
        f"\n\n# MANDATORY: HUMAN WRITING & ZERO-AI-DETECTOR GUARDRAIL\n\n"
        f"{body}\n"
    )


def format_ai_detector_banned_phrases_for_prompt() -> str:
    """Compact duplicate ban list for the JSON/output section of the system prompt."""
    items = AI_DETECTOR_BANNED_PHRASES[:35]
    bullets = "\n".join(f"- {p}" for p in items)
    return (
        "\nNEVER use these AI-detector trigger phrases in article_markdown "
        "(headings or body):\n"
        f"{bullets}\n"
    )
