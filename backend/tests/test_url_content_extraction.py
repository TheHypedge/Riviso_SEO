from app.services.article_generation import build_generation_messages
from app.services.url_content_extractor import _extract


SAMPLE_HTML = """
<html>
<head><title>Test Page</title><meta name="description" content="A test page."></head>
<body>
<nav>Home | About | Contact</nav>
<script>trackPageview();</script>
<article>
<p>This is the real article content. It talks about widgets and how to use them
effectively in everyday situations, with several detailed examples and practical
advice that a reader would actually want to read through carefully. """ + ("More filler sentences to pass the minimum word count threshold for extraction. " * 6) + """</p>
</article>
<footer>Copyright 2024</footer>
</body>
</html>
"""


def test_extract_excludes_nav_and_script_keeps_article():
    page = _extract(SAMPLE_HTML, "https://example.com/page")
    assert page.title == "Test Page"
    assert page.meta_description == "A test page."
    assert "widgets" in page.text
    assert "Home" not in page.text
    assert "trackPageview" not in page.text
    assert "Copyright" not in page.text


def test_build_generation_messages_with_reference_source_content():
    sys_with, user_with = build_generation_messages(
        title="Widgets 101",
        keywords=["widgets"],
        focus_keyphrase="widgets guide",
        writing_prompt_text="Write a helpful guide.",
        reference_source_content="Some extracted background text about widgets.",
    )
    assert "never copy" in sys_with.lower()
    assert "preserve every fact" in sys_with.lower()
    assert "Some extracted background text about widgets." in user_with


def test_build_generation_messages_without_reference_source_content_is_unchanged():
    sys_a, user_a = build_generation_messages(
        title="Widgets 101",
        keywords=["widgets"],
        focus_keyphrase="widgets guide",
        writing_prompt_text="Write a helpful guide.",
    )
    sys_b, user_b = build_generation_messages(
        title="Widgets 101",
        keywords=["widgets"],
        focus_keyphrase="widgets guide",
        writing_prompt_text="Write a helpful guide.",
        reference_source_content=None,
    )
    assert sys_a == sys_b
    assert user_a == user_b
    assert "SOURCE MATERIAL" not in sys_a
