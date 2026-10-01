"""Self-check for quora_question_finder's title-cleaning and discovery aggregation."""

import asyncio
from types import SimpleNamespace
from unittest.mock import patch

from app.services.quora_question_finder import _clean_question_title, discover_quora_questions


def test_clean_question_title_strips_quora_suffix():
    assert _clean_question_title("What is technical SEO? - Quora") == "What is technical SEO?"
    assert _clean_question_title("How does link building work?") == "How does link building work?"
    assert _clean_question_title("  Padded question - Quora  ") == "Padded question"


def test_discover_quora_questions_dedupes_and_cleans():
    async def fake_get_or_fetch_serp(*, query, gl, hl):
        if "seo" in query:
            return SimpleNamespace(results=[
                {"title": "What is SEO? - Quora", "url": "https://www.quora.com/What-is-SEO"},
                {"title": "Not a question page", "url": "https://www.quora.com/search?q=seo"},
            ])
        return SimpleNamespace(results=[
            {"title": "What is SEO? - Quora", "url": "https://www.quora.com/What-is-SEO"},
            {"title": "How to rank higher? - Quora", "url": "https://www.quora.com/How-to-rank-higher"},
        ])

    with patch("app.services.serp_index.get_or_fetch_serp", fake_get_or_fetch_serp):
        out = asyncio.run(discover_quora_questions(keywords=["seo", "ranking"]))

    urls = [r["url"] for r in out]
    assert urls == ["https://www.quora.com/What-is-SEO", "https://www.quora.com/How-to-rank-higher"]
    assert out[0]["question"] == "What is SEO?"
    assert out[0]["matched_keyword"] == "seo"


if __name__ == "__main__":
    test_clean_question_title_strips_quora_suffix()
    test_discover_quora_questions_dedupes_and_cleans()
    print("ok")
