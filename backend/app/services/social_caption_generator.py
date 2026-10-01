"""
Platform-specific content generation for the Social Media module -- confirmed during
planning that nothing like this existed (only full-article generation and SEO meta
fields). Two thin ``chat_json`` calls, same class of work as
``article_selection_rewrite.py``/``article_metadata_suggestion.py``: no queue, no
``generation_slot()``, reuses the human-writing-guardrail + banned-phrase helpers so the
same "don't sound like AI" rules apply here too.

The user always sees and can edit the generated text before anything is posted or
copied -- these functions only ever produce a draft.
"""

from __future__ import annotations

import json
import random
import re
from typing import Any

from app.core.config import settings
from app.services.generation_blocklist import format_banned_phrases_for_prompt
from app.services.human_writing_guardrail import format_ai_detector_banned_phrases_for_prompt
from app.services.openai_client import OpenAIClient

# NOTE: deliberately NOT using format_human_writing_guardrail_for_system_prompt() here --
# that injects the full long-form ARTICLE guardrail (mandatory ## H2/### H3 headings,
# bullet/numbered-list structure rules meant for blog posts), which directly contradicts
# the "short scannable lines, no markdown headings" instructions below and confused the
# model into producing structurally weird output. format_ai_detector_banned_phrases_for_prompt()
# is the same underlying banned-word list without the article-structure baggage.
_SOCIAL_VOICE_RULES = (
    "- Sound like a real specific person who actually did this work, not a brand account "
    "or a corporate blog. Have an opinion. Be a little informal. It is fine to sound "
    "slightly unpolished -- that is what makes it read as human.\n"
    "- Vary sentence length on purpose: mix a very short line (under 6 words) with longer "
    "ones. Never start two consecutive sentences with the same word.\n"
    "- Use contractions naturally (it's, don't, you'll, that's).\n"
    "- No stacked adjectives, no empty praise words (amazing, wonderful, game-changer), no "
    "fake authority ('studies show', 'experts agree') without naming the actual source.\n"
    "- Never use em dashes (—) anywhere, and never use a plain hyphen surrounded by spaces "
    "as a sentence-break substitute (e.g. \"this works - and fast\") -- that reads as AI "
    "trying to hide an em dash. Rewrite as two sentences, or use a comma. A hyphen is only "
    "ok inside a compound word (well-known) or as a list bullet.\n"
    "- Never use a semicolon as a sentence connector, and never use a colon as a dramatic "
    "mid-sentence pause (e.g. \"The truth: it's complicated\") -- write a complete sentence "
    "instead.\n"
)

# Named hook/structure archetypes -- one is picked at random per generation so posts
# stay varied instead of following the exact same template every time, while each
# archetype is still a deliberate, proven LinkedIn post shape (not free-form).
_LINKEDIN_HOOK_ARCHETYPES = [
    "Shocking stat: open with a surprising number or statistic from the article that "
    "makes the reader stop scrolling, then unpack what it actually means.",
    "Mini story: open with a 1-2 sentence relatable scenario or story moment tied to the "
    "topic (told naturally, in first person), then pivot into the real lesson/facts.",
    "Myth vs reality: open with a one-line claim naming what most people wrongly believe "
    "about the topic, then correct it with what's actually true.",
    "Problem, insight, fix: open by naming a specific, painful problem the reader "
    "recognizes immediately, then give the real insight, then the concrete fix.",
    "Listicle hook: open with a bold count-based hook (e.g. the number of things you wish "
    "you'd known, or biggest mistakes), then deliver the points crisply, one per line.",
]

_LINKEDIN_SYSTEM = (
    "You are writing a LinkedIn post in the article author's own voice, announcing a new "
    "article to their professional network. This must read like a real, high-performing "
    "LinkedIn post, not a generic announcement.\n"
    "STRUCTURE FOR THIS POST -- {archetype}\n"
    "- Line 1 is the hook alone, nothing else. LinkedIn truncates posts at roughly 210 "
    "characters behind a \"...see more\", so the hook must work standalone within that "
    "window and make someone stop scrolling. Never restate the article title as the hook.\n"
    "- After the hook, write short, scannable lines -- one or two sentences per line, a "
    "blank line between each -- never a dense paragraph block. Pull specific facts, "
    "numbers, or the actual solution from the article content given to you; do not stay "
    "generic or vague.\n"
    "- Close with one genuine, open-ended question that invites real comments and "
    "discussion -- not a soft \"let me know what you think.\"\n"
    "- On its own line right after the closing question, output exactly the literal text "
    "{{{{ARTICLE_LINK}}}} (nothing else on that line, no real URL -- it gets substituted "
    "in afterward).\n"
    "- On the final line, add 3-5 specific, relevant hashtags (no generic spam tags).\n"
    "- Total length roughly 900-1600 characters including hashtags.\n"
    "{voice}"
    "{guardrail}"
    "{banned}"
    'Return ONLY JSON: {{"text": string}}. No commentary, no markdown code fences.'
)

_QUORA_SYSTEM = (
    "You are answering a real Quora question as a knowledgeable, helpful person -- not "
    "advertising anything. Quora moderators remove answers that read as spam or "
    "self-promotion, so this must read as genuinely helpful first.\n"
    "- Answer the actual question directly and substantively, in your own words, drawing "
    "on the provided article content as your source of expertise.\n"
    "- First-person, conversational-expert tone. Roughly 150-400 words.\n"
    "- Do NOT open by mentioning the article or any link -- deliver real value first.\n"
    "- Only near the end, if it adds genuine value, you may add one soft, non-pushy "
    "sentence such as \"I wrote a more detailed breakdown of this if it's useful\" -- never "
    "as an ad, never with a raw URL, never more than once.\n"
    "{voice}"
    "{guardrail}"
    "{banned}"
    'Return ONLY JSON: {{"text": string}}. No commentary, no markdown code fences.'
)


def _article_context(article: dict[str, Any]) -> dict[str, Any]:
    return {
        "title": (article.get("title") or "").strip(),
        "meta_description": (article.get("meta_description") or "").strip(),
        "focus_keyphrase": (article.get("focus_keyphrase") or "").strip(),
    }


async def generate_linkedin_caption(article: dict[str, Any]) -> str:
    ctx = _article_context(article)
    body_excerpt = (article.get("article") or "").strip()[:3000]
    system = _LINKEDIN_SYSTEM.format(
        archetype=random.choice(_LINKEDIN_HOOK_ARCHETYPES),
        voice=_SOCIAL_VOICE_RULES,
        guardrail=format_ai_detector_banned_phrases_for_prompt(),
        banned=format_banned_phrases_for_prompt(),
    )
    user = json.dumps({**ctx, "article_excerpt": body_excerpt}, ensure_ascii=False)
    client = OpenAIClient()
    obj = await client.chat_json(model=settings.openai_text_model, system=system, user=user)
    text = str((obj or {}).get("text") or "").strip()

    article_url = (article.get("wp_link") or article.get("shopify_link") or "").strip()
    if article_url:
        text = text.replace("{{ARTICLE_LINK}}", article_url)
    else:
        # No published URL yet -- drop the placeholder line entirely rather than leave
        # a literal "{{ARTICLE_LINK}}" token visible to the user.
        text = "\n".join(line for line in text.split("\n") if line.strip() != "{{ARTICLE_LINK}}")
        text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


async def generate_quora_answer(*, question: str, article: dict[str, Any]) -> str:
    ctx = _article_context(article)
    system = _QUORA_SYSTEM.format(
        voice=_SOCIAL_VOICE_RULES,
        guardrail=format_ai_detector_banned_phrases_for_prompt(),
        banned=format_banned_phrases_for_prompt(),
    )
    body_excerpt = (article.get("article") or "").strip()[:3000]
    user = json.dumps({"question": (question or "").strip(), **ctx, "article_excerpt": body_excerpt}, ensure_ascii=False)
    client = OpenAIClient()
    obj = await client.chat_json(model=settings.openai_text_model, system=system, user=user)
    return str((obj or {}).get("text") or "").strip()
