"""Self-check that the LinkedIn/Quora generators wire the human-writing guardrail and
banned-phrase list into the system prompt -- same rules that already apply to article
generation must apply here too, or these surfaces would happily produce banned phrases
and AI-sounding text and nobody would notice."""

import asyncio
from unittest.mock import patch

from app.services.social_caption_generator import generate_linkedin_caption, generate_quora_answer

_ARTICLE = {
    "title": "Technical SEO Checklist",
    "meta_description": "A guide to technical SEO.",
    "focus_keyphrase": "technical seo",
    "keywords": ["seo", "crawling"],
    "article": "Full article body text here.",
}


def test_linkedin_caption_prompt_includes_guardrail_and_banned_phrases():
    captured = {}

    async def fake_chat_json(self, *, model, system, user):
        captured["system"] = system
        return {"text": "Generated caption"}

    with patch("app.services.social_caption_generator.OpenAIClient.chat_json", fake_chat_json), \
         patch("app.services.social_caption_generator.format_ai_detector_banned_phrases_for_prompt", return_value="GUARDRAIL_MARKER\n"), \
         patch("app.services.social_caption_generator.format_banned_phrases_for_prompt", return_value="BANNED_MARKER\n"):
        result = asyncio.run(generate_linkedin_caption(_ARTICLE))

    assert result == "Generated caption"
    assert "GUARDRAIL_MARKER" in captured["system"]
    assert "BANNED_MARKER" in captured["system"]
    assert "Sound like a real specific person" in captured["system"]
    assert "## H2" not in captured["system"]  # article-structure guardrail must NOT leak in here


def test_linkedin_caption_substitutes_real_article_link():
    async def fake_chat_json(self, *, model, system, user):
        return {"text": "Hook line.\n\nFacts here.\n\nWhat do you think?\n\n{{ARTICLE_LINK}}\n\n#seo #content"}

    article = {**_ARTICLE, "wp_link": "https://example.com/technical-seo-checklist"}
    with patch("app.services.social_caption_generator.OpenAIClient.chat_json", fake_chat_json):
        result = asyncio.run(generate_linkedin_caption(article))

    assert "https://example.com/technical-seo-checklist" in result
    assert "{{ARTICLE_LINK}}" not in result


def test_linkedin_caption_strips_placeholder_when_no_article_link():
    async def fake_chat_json(self, *, model, system, user):
        return {"text": "Hook line.\n\nFacts here.\n\nWhat do you think?\n\n{{ARTICLE_LINK}}\n\n#seo #content"}

    article = {**_ARTICLE}  # no wp_link/shopify_link
    with patch("app.services.social_caption_generator.OpenAIClient.chat_json", fake_chat_json):
        result = asyncio.run(generate_linkedin_caption(article))

    assert "{{ARTICLE_LINK}}" not in result
    assert "\n\n\n" not in result
    assert "#seo #content" in result


def test_quora_answer_prompt_includes_guardrail_and_question():
    captured = {}

    async def fake_chat_json(self, *, model, system, user):
        captured["system"] = system
        captured["user"] = user
        return {"text": "Generated answer"}

    with patch("app.services.social_caption_generator.OpenAIClient.chat_json", fake_chat_json), \
         patch("app.services.social_caption_generator.format_ai_detector_banned_phrases_for_prompt", return_value="GUARDRAIL_MARKER\n"), \
         patch("app.services.social_caption_generator.format_banned_phrases_for_prompt", return_value="BANNED_MARKER\n"):
        result = asyncio.run(generate_quora_answer(question="What is technical SEO?", article=_ARTICLE))

    assert result == "Generated answer"
    assert "GUARDRAIL_MARKER" in captured["system"]
    assert "BANNED_MARKER" in captured["system"]
    assert "What is technical SEO?" in captured["user"]
    assert "Sound like a real specific person" in captured["system"]


if __name__ == "__main__":
    test_linkedin_caption_prompt_includes_guardrail_and_banned_phrases()
    test_linkedin_caption_substitutes_real_article_link()
    test_linkedin_caption_strips_placeholder_when_no_article_link()
    test_quora_answer_prompt_includes_guardrail_and_question()
    print("ok")
