"""Tests for always-on human writing guardrail injection."""

from __future__ import annotations

from app.services.article_generation import build_generation_messages
from app.services.human_writing_guardrail import build_human_writing_guardrail


def test_build_human_writing_guardrail_injects_fields() -> None:
    text = build_human_writing_guardrail(
        title="Best Linen Suits for Summer",
        focus_keyphrase="linen suits",
        keywords=["breathable fabrics", "summer suits"],
    )
    assert "Topic: Best Linen Suits for Summer" in text
    assert "Target keyword" in text and "linen suits" in text
    assert "breathable fabrics" in text
    assert "summer suits" in text
    assert "ANTI-AI-DETECTOR" in text
    assert "elevate your" in text


def test_build_generation_messages_always_includes_guardrail() -> None:
    sys, user = build_generation_messages(
        title="Cooling Fabrics Guide",
        keywords=["cotton", "linen"],
        focus_keyphrase="cooling fabrics",
        writing_prompt_text="Write a helpful guide for {article_title}.",
        brand_identity="",
        niche_identifier="",
        product_context=None,
    )
    assert "ZERO-AI-DETECTOR GUARDRAIL" in sys
    assert "PRIMARY DIRECTIVE" in sys
    assert "Final check before JSON" in user
    assert "Topic: Cooling Fabrics Guide" in sys
    assert "cooling fabrics" in sys
    assert "cotton" in sys
    assert "Cooling Fabrics Guide" in user
