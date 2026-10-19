import markdown as md

from app.services.context_links import apply_context_links_html, apply_context_links_markdown

ITEMS = [
    {"label": "defense lawyer", "url": "https://x.com/defense"},
    {"label": "criminal defense lawyer", "url": "https://x.com/criminal"},
    {"label": "law", "url": "https://x.com/law"},
]
TEXT = "Hire a criminal defense lawyer today. A Defense Lawyer knows the law."


def test_markdown_overlapping_labels_never_nest_longest_wins():
    out = apply_context_links_markdown(TEXT, ITEMS)
    assert out == (
        "Hire a [criminal defense lawyer](https://x.com/criminal) today. "
        "A [Defense Lawyer](https://x.com/defense) knows the [law](https://x.com/law)."
    )


def test_html_overlapping_labels_never_nest():
    out = apply_context_links_html(f"<p>{TEXT}</p>", ITEMS)
    assert out.count("<a ") == 3
    assert "<a href=\"https://x.com/criminal\">criminal defense lawyer</a>" in out
    assert "lawyer</a></a>" not in out


def test_whole_words_only():
    assert apply_context_links_markdown("Lawyers and lawful acts.", ITEMS) == "Lawyers and lawful acts."


def test_existing_links_code_and_html_untouched():
    src = "See [a law](https://y.com), `law`, <img alt=\"law\" src=\"/law.png\"> and law."
    out = apply_context_links_markdown(src, ITEMS)
    assert out == "See [a law](https://y.com), `law`, <img alt=\"law\" src=\"/law.png\"> and [law](https://x.com/law)."


def test_publish_path_markdown_then_html_is_idempotent():
    linked_md = apply_context_links_markdown(TEXT, ITEMS)
    html = md.markdown(linked_md)
    assert apply_context_links_html(html, ITEMS) == html


def test_no_items_is_noop():
    assert apply_context_links_markdown(TEXT, []) == TEXT
    assert apply_context_links_html("<p>x</p>", [{"label": "", "url": "u"}]) == "<p>x</p>"


def test_unnest_repairs_old_broken_output_keeping_outer_link():
    from app.services.context_links import unnest_markdown_links

    broken = (
        "Hire a [criminal [defense [law](https://x.com/law)yer](https://x.com/defense)](https://x.com/criminal) today. "
        "Plain [note] and [ok](https://y.com)."
    )
    fixed, n = unnest_markdown_links(broken)
    assert n == 2
    assert fixed == "Hire a [criminal defense lawyer](https://x.com/criminal) today. Plain [note] and [ok](https://y.com)."
    assert unnest_markdown_links(fixed) == (fixed, 0)


def test_repair_live_html_from_old_bug():
    import markdown as markdown_lib

    from app.services.context_links import repair_markdown_links_in_html

    broken_md = "Hire a [criminal [defense [law](https://x.com/l)yer](https://x.com/d)](https://x.com/c) today."
    live = markdown_lib.markdown(broken_md, extensions=["extra", "sane_lists", "smarty"])
    fixed, n = repair_markdown_links_in_html(live)
    assert fixed == '<p>Hire a <a href="https://x.com/c">criminal defense lawyer</a> today.</p>'
    assert n == 2
    assert repair_markdown_links_in_html(fixed) == (fixed, 0)


def test_repair_live_html_outside_anchor_and_leaves_normal_html():
    from app.services.context_links import repair_markdown_links_in_html

    src = '<!-- wp:paragraph --><p>See [guide](https://x.com/g) and <a href="https://y.com">[ok]</a> [note].</p><!-- /wp:paragraph -->'
    fixed, n = repair_markdown_links_in_html(src)
    assert n == 1
    assert fixed == '<!-- wp:paragraph --><p>See <a href="https://x.com/g">guide</a> and <a href="https://y.com">[ok]</a> [note].</p><!-- /wp:paragraph -->'


def test_each_url_linked_once_per_article():
    md_out = apply_context_links_markdown("A law firm. Another law case. More law.", ITEMS)
    assert md_out.count("](https://x.com/law)") == 1
    assert md_out.startswith("A [law](https://x.com/law) firm.")
    html_out = apply_context_links_html("<p>law one</p><p>law two</p>", ITEMS)
    assert html_out.count("<a ") == 1


def test_html_pass_respects_links_already_in_document():
    src = '<p><a href="https://x.com/law">the law</a> and law again.</p>'
    assert apply_context_links_html(src, ITEMS) == src


def test_markdown_pass_respects_links_already_in_text():
    src = "Read [the law](https://x.com/law) and the law."
    assert apply_context_links_markdown(src, ITEMS) == src


def test_headings_code_urls_and_emails_are_never_linked():
    src = "## Law basics\n\nSee https://site.com/law/page or mail law@site.com. `law` here.\n\nThen law."
    out = apply_context_links_markdown(src, ITEMS)
    assert out == "## Law basics\n\nSee https://site.com/law/page or mail law@site.com. `law` here.\n\nThen [law](https://x.com/law)."
    h = apply_context_links_html("<h2>Law</h2><pre>law</pre><p>law</p>", ITEMS)
    assert h == '<h2>Law</h2><pre>law</pre><p><a href="https://x.com/law">law</a></p>'


def test_void_tag_inside_anchor_does_not_disable_linking_for_rest_of_post():
    src = '<p><a href="https://y.com"><img src="i.png">logo</a></p><p>Ask a defense lawyer.</p>'
    out = apply_context_links_html(src, ITEMS)
    assert '<a href="https://x.com/defense">defense lawyer</a>' in out


def test_unsafe_urls_are_never_injected():
    from app.services.context_links import is_safe_link_url

    bad = [{"label": "law", "url": "javascript:alert(1)"}, {"label": "lawyer", "url": "/relative"}]
    assert apply_context_links_markdown("law and lawyer", bad) == "law and lawyer"
    assert apply_context_links_html("<p>law and lawyer</p>", bad) == "<p>law and lawyer</p>"
    assert is_safe_link_url("https://x.com/a") and not is_safe_link_url("data:text/html,x")
    assert not is_safe_link_url("https://x.com/a b") and not is_safe_link_url("http://")


def test_markdown_destination_with_parentheses_stays_valid():
    out = apply_context_links_markdown("Read about law.", [{"label": "law", "url": "https://en.wikipedia.org/wiki/Law_(x)"}])
    assert out == "Read about [law](https://en.wikipedia.org/wiki/Law_%28x%29)."
    assert '<a href="https://en.wikipedia.org/wiki/Law_%28x%29">law</a>' in md.markdown(out)
