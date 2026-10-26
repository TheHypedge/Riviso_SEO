"""Generated articles must never show AI-tell headings ("Quick Answer", "Conclusion", ...).
The heading goes; the section's text stays."""

from __future__ import annotations

from app.services.content_sanitizer import sanitize_article_body
from app.services.generation_blocklist import clean_banned_heading, format_banned_phrases_for_prompt


def test_banned_headings_removed_text_kept():
    body = (
        "# Choosing a Divorce Lawyer\n\n"
        "## Quick Answer\n\nPick a specialist with court experience.\n\n"
        "## How Fees Work\n\nMost lawyers charge per hearing.\n\n"
        "### Conclusion\n\nStart with two consultations."
    )
    out = sanitize_article_body(body)
    assert "Quick Answer" not in out and "Conclusion" not in out
    assert "Pick a specialist with court experience." in out
    assert "Start with two consultations." in out
    assert "## How Fees Work" in out


def test_variants_are_caught():
    for heading in ("## In Conclusion", "## Conclusion:", "## 7. Conclusion", "## **Conclusion**", "## Quick Answer / TL;DR",
                    "## TL;DR", "#### quick answers", "**Conclusion**", "**Quick Answer:**"):
        assert clean_banned_heading(heading) is None, heading


def test_banned_label_prefix_is_stripped_keeping_the_real_title():
    assert clean_banned_heading("## Conclusion: Choosing the Right Lawyer") == "## Choosing the Right Lawyer"
    assert clean_banned_heading("## Quick Answer - Fees in 2026") == "## Fees in 2026"


def test_normal_headings_and_body_text_untouched():
    for line in ("## Drawing Conclusions From Court Data", "## Final Hearing Checklist", "The court's conclusion was clear.",
                 "In conclusion, we waited.", "**What does TL;DR mean?**"):
        assert clean_banned_heading(line) == line, line


def test_prompt_lists_forbidden_headings():
    prompt = format_banned_phrases_for_prompt()
    assert "FORBIDDEN HEADINGS" in prompt and "- quick answer" in prompt and "- conclusion" in prompt
