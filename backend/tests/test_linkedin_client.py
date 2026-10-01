"""Self-check for _escape_little_text -- LinkedIn's Posts API `commentary` field is
parsed as "little text format", not plain text: reserved characters like parentheses
must be backslash-escaped or LinkedIn's parser mis-renders the post (observed:
everything after the first unescaped reserved character collapsed to a single line).
Confirmed live against a real post -- a generated caption containing "(CRO)" rendered
as one line on LinkedIn until this fix."""

from app.services.linkedin_client import _escape_little_text


def test_escapes_reserved_characters():
    assert _escape_little_text("Growth hacking (CRO) isn't magic.") == "Growth hacking \\(CRO\\) isn't magic."
    assert _escape_little_text("a < b > c") == "a \\< b \\> c"
    assert _escape_little_text("use_snake_case") == "use\\_snake\\_case"
    assert _escape_little_text("100% * effort") == "100% \\* effort"


def test_leaves_hashtags_unescaped_so_they_stay_clickable():
    assert _escape_little_text("#seo #ContentMarketing") == "#seo #ContentMarketing"


def test_leaves_plain_urls_unescaped():
    url = "https://example.com/some-article-slug/"
    assert _escape_little_text(url) == url


def test_escapes_literal_backslash_exactly_once():
    assert _escape_little_text("a\\b") == "a\\\\b"


def test_empty_and_none_safe():
    assert _escape_little_text("") == ""
    assert _escape_little_text(None) == ""  # type: ignore[arg-type]


if __name__ == "__main__":
    test_escapes_reserved_characters()
    test_leaves_hashtags_unescaped_so_they_stay_clickable()
    test_leaves_plain_urls_unescaped()
    test_escapes_literal_backslash_exactly_once()
    test_empty_and_none_safe()
    print("ok")
