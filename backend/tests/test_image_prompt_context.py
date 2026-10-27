"""Image prompt carries only what an image model can use (niche topic + voice as mood), never
writing rules / audience / geography, and never forces "photograph" over a requested style."""

import os

os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")

from app.api.routes.projects import _derive_brand_identity_text, _derive_niche_text
from app.services.seo_guardrails import (
    NEUTRAL_IMAGE_STYLE_SUFFIX,
    STATIC_IMAGE_STYLE_SUFFIX,
    build_programmatic_image_prompt,
    image_niche_from_identifier,
)

BI = _derive_brand_identity_text(voice="Authoritative", tones=["Direct", "Empathetic"], rules="Never give legal guarantees.")
NI = _derive_niche_text(
    topic="Mutual divorce advocacy in India", audience=["NRIs"], countries=["IN", "AE"],
    countries_all=False, cities=["Delhi", "Dubai"], cities_all=False,
)


def _prompt(style=None, **kw):
    return build_programmatic_image_prompt(
        title=kw.get("title", "How long does mutual divorce take?"), keywords=["mutual divorce"],
        focus_keyphrase="mutual divorce timeline", brand_identity=BI, niche_identifier=NI, image_prompt_text=style,
    )


def test_only_niche_and_voice_reach_the_image_prompt():
    p = _prompt()
    assert "Context: Mutual divorce advocacy in India" in p and "Mood: authoritative" in p
    for leaked in ("legal guarantees", "NRIs", "United Arab Emirates", "Dubai", "Tones", "Rules", "Niche: Niche"):
        assert leaked not in p


def test_photo_suffix_by_default_neutral_for_non_photo_styles():
    assert _prompt().endswith(STATIC_IMAGE_STYLE_SUFFIX)
    for style in ("Flat vector illustration", "isometric 3D render", "watercolour painting", "line-art doodle"):
        p = _prompt(style)
        assert p.endswith(NEUTRAL_IMAGE_STYLE_SUFFIX) and "photograph" not in p.lower(), style


def test_subject_and_style_come_first_so_budget_cuts_only_the_tail():
    p = _prompt("Minimal flat illustration")
    assert p.index("Subject:") < p.index("Style:") < p.index("Context:")


def test_legacy_free_text_niche_uses_first_sentence():
    assert image_niche_from_identifier("We help MSMEs recover dues. Audience is CFOs in Pune.") == "We help MSMEs recover dues."
    assert image_niche_from_identifier("") == ""


def test_global_targeting_does_not_add_contradictory_city_line():
    text = _derive_niche_text(topic="", audience=[], countries=[], countries_all=True, cities=[], cities_all=True)
    assert text == "Target countries: all countries (global targeting)."
    text = _derive_niche_text(topic="", audience=[], countries=["IN"], countries_all=False, cities=[], cities_all=True)
    assert "all major cities in the target countries" in text
