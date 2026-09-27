"""Self-check for build_export_filename -- the one piece of new non-trivial,
easily-testable logic in the PDF export feature (pure string handling, no
browser needed; the actual PDF render is exercised manually per the plan)."""

from app.services.article_pdf_export import build_export_filename, content_disposition_header


def test_joins_project_and_title():
    ascii_fallback, utf8_value = build_export_filename("Acme Blog", "10 Best Tips")
    assert ascii_fallback == "Acme Blog - 10 Best Tips.pdf"
    assert utf8_value == "Acme Blog - 10 Best Tips.pdf"


def test_strips_illegal_filesystem_characters():
    ascii_fallback, _ = build_export_filename("A/B:C", 'Title "quoted" <tag>')
    for ch in '/\\:*?"<>|':
        assert ch not in ascii_fallback


def test_non_ascii_gets_transliterated_fallback_and_preserved_utf8():
    ascii_fallback, utf8_value = build_export_filename("Café™", "Résumé — Tips")
    assert ascii_fallback == "CafeTM - Resume Tips.pdf"
    assert "é" in utf8_value and "—" in utf8_value


def test_missing_inputs_fall_back_to_defaults():
    ascii_fallback, utf8_value = build_export_filename(None, None)
    assert ascii_fallback == "Project - Untitled article.pdf"
    assert utf8_value == "Project - Untitled article.pdf"


def test_length_is_capped():
    ascii_fallback, utf8_value = build_export_filename("P" * 200, "T" * 200)
    assert len(ascii_fallback) <= 155  # 150-char cap + ".pdf"
    assert len(utf8_value) <= 155


def test_content_disposition_header_has_both_forms():
    header = content_disposition_header("Acme", "Café Guide")
    assert 'filename="Acme - Cafe Guide.pdf"' in header
    assert "filename*=UTF-8''Acme%20-%20Caf%C3%A9%20Guide.pdf" in header


if __name__ == "__main__":
    test_joins_project_and_title()
    test_strips_illegal_filesystem_characters()
    test_non_ascii_gets_transliterated_fallback_and_preserved_utf8()
    test_missing_inputs_fall_back_to_defaults()
    test_length_is_capped()
    test_content_disposition_header_has_both_forms()
    print("ok")
