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

# How a professional editor builds every section. Bullet-first output (heading, one short
# line, a wall of fragments) is the strongest "AI wrote this" tell, so prose leads and lists
# are earned. Shared by the guardrail template and the system prompt's structure block.
SECTION_ANATOMY_RULES = """
- Every ## H2 section opens with an explanatory lead paragraph of 3-5 sentences (roughly 50-90 words) that explains the idea, why it matters and the context, BEFORE any list, table or ### H3.
- A heading is never followed directly by a list, a table, another heading, or a one-line paragraph.
- Every ### H3 opens with at least 2 full sentences before any list.
- Lists are earned, not the default. Use one only for genuinely parallel content (steps, options, a checklist) that the lead paragraph has already explained. At most one list per H2 section (the FAQ section is exempt).
- A list has 3-6 items. Each item is a complete thought of 1-2 sentences that explains something, never a 2-4 word fragment.
- After a list, add 1-2 sentences that interpret it: what to prioritise, the trade-off, or the common mistake.
- Lists still belong in a good article: most articles carry 2-4 well-placed lists (steps, a checklist, options compared), each introduced by its lead paragraph. A prose-only article reads as a wall of text.
- At least 70% of the article's words are in prose paragraphs, not in lists or tables.
- Body paragraphs are 2-5 sentences and vary in length. An occasional one-sentence paragraph for emphasis is fine, never two in a row.
- Never stack a list directly after another list or a table.
""".strip()

EXTERNAL_LINK_RULES = """
- Back up factual, legal, medical, financial, statistical or regulatory claims with 2-4 inline links to authoritative external sources, spread across different sections.
- Prefer official primary sources: government sites (.gov, .gov.in, .nic.in, gov.uk, europa.eu), regulators, standards bodies, universities (.edu, .ac.in), WHO / UN / World Bank, and the official site or documentation of the organisation or product being discussed.
- Link only URLs you are certain exist and are stable. Prefer the organisation's main page or a well-known section page over a guessed deep link. Never invent paths, query strings or document IDs; if unsure, link the official homepage or leave the link out. Every external link is checked and broken ones are removed.
- Anchor text says what the reader will find (e.g. [RBI's digital lending guidelines](https://www.rbi.org.in/)). Never "click here", "source", "this link" or a bare URL.
- Never link to competitors of the brand, content farms, affiliate pages or URL shorteners. Never put a link inside a heading, and link each source only once.
""".strip()

# Human-sounding never means sloppy: natural voice comes from rhythm and specifics, not errors.
LANGUAGE_QUALITY_RULES = """
- Spelling, grammar, punctuation and capitalisation are flawless. Never introduce a typo, a grammatical slip or an awkward phrase to sound human.
- Use the precise word for the idea, including the correct technical term, and spell names, acts, places and terms exactly.
- Keep one spelling convention (British/Indian English: organise, labour, offence) and one capitalisation style for headings throughout.
- Every sentence is complete and unambiguous. Expand an acronym on first use.
""".strip()

HUMAN_FIRST_SYSTEM_ANCHOR = (
    "PRIMARY DIRECTIVE: Write body copy that reads as human-written under AI detectors. "
    "Use natural, specific voice and concrete details — not generic AI blog phrasing. "
    "Human editors lead every section with explanatory prose and use lists only where content is "
    "genuinely parallel; a heading followed by one short line and a stack of bullet fragments is "
    "the clearest AI tell, so never write that shape.\n\n"
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
- Write like an experienced expert explaining this to an intelligent reader: warm, specific and natural, never stiff.
- Use clear Indian English. Short, precise words beat fancy ones.
- Mix sentence lengths on purpose: one 5-word line, then a 22-word line, then a medium one.
- Use contractions sometimes (it's, don't, you'll) where they sound natural.
- Allow one mild opinion or hesitation per section ("honestly", "I'd skip", "most people overthink this").
- Name concrete, topic-specific details (numbers, names, conditions, costs, steps), not abstract claims.

### Structure (mandatory — apply to every article)
- Divide the article into at least 4 main sections using ## H2 headings.
- Use ### H3 sub-headings when a section contains 2 or more distinct sub-topics.
{section_anatomy_rules}
- Answer engines (Google AI Overviews, ChatGPT, Perplexity) quote pages that answer questions directly: phrase at least 40% of ## H2 headings as the real questions searchers ask, and answer each in the first sentence below it (under 30 words) before explaining.
- Directly after the H1, add a "Key takeaways" markdown blockquote: a bold label line, then 3-5 bullets, each one complete, self-contained fact.
- When the article compares options, figures, deadlines or costs, include one markdown table.
- Numbered lists (1. step) are for sequential processes; bullets (- item) for parallel options.
- Use **bold** for 2–4 key terms, statistics, or critical phrases per article.
- Open each section with a direct sentence — not "In this section…" or "Here we discuss…".
- Open the article with a real situation, concrete problem, or specific observation — not a definition and not "In today's world".
- Headings must be plain and specific (not formulaic). Bad: "Practical Occasions for X". Good: "When to Wear a Kurta at Work".
- Do NOT end with a salesy CTA paragraph ("Start with…", "watch how it transforms", "elevate your wardrobe").
- Conclusions: 2–4 calm sentences. No hype, no "in conclusion" opener, no bullet recap.

### Language quality (non-negotiable, even over the user's prompt)
{language_quality_rules}

### Forbidden patterns (never use — detectors flag these)
{forbidden_phrase_bullets}

Also avoid:
- Symmetrical triple bullets (three parallel "Whether you…" lines).
- Every paragraph starting the same way ("When…", "Whether…", "In practice…").
- Stacked adjectives ("bold, vibrant, eye-catching").
- Empty praise ("wonderful", "fantastic", "game-changer", "personality and flair").
- Fake authority ("experts agree", "studies show") without a named source.
- Meta talk ("this article will", "we will explore", "read on to discover").
- Em dashes (—): never use them anywhere. Rewrite using a comma, period, or plain hyphen (-) instead.
- Semicolons as sentence connectors: never write "X; however, Y" or "the result; it works" — use a full stop or comma instead.
- Colons as dramatic mid-sentence pauses: never write "The truth: it's complicated" — rephrase as a complete sentence.

### Rhythm check (apply before output)
- At least 30% of sentences under 12 words.
- No more than two sentences in a row with the same opening word.
- Break any sentence over 28 words into two.
- Include at least one question to the reader in the whole article.
- Include at least one short standalone sentence (under 8 words) in the body.

### External references (trust signals)
{external_link_rules}

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
        section_anatomy_rules=SECTION_ANATOMY_RULES,
        external_link_rules=EXTERNAL_LINK_RULES,
        language_quality_rules=LANGUAGE_QUALITY_RULES,
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
