from __future__ import annotations

import html
import re
from html.parser import HTMLParser
from urllib.parse import urlsplit

# Matches Markdown segments that must NOT be phrase-linked:
#   - fenced code blocks (``` or ~~~) and inline code spans
#   - headings (a link inside a heading reads as spam and hurts SEO)
#   - existing inline/reference links, HTML anchors and any other inline HTML tag
#   - bare URLs and email addresses (a label like "law" must not split ".../law/...")
_MD_SKIP_RE = re.compile(
    r"```[\s\S]*?```"               # fenced code block (```)
    r"|~~~[\s\S]*?~~~"              # fenced code block (~~~)
    r"|`[^`\n]+`"                  # inline code span
    r"|^[ \t]{0,3}#{1,6}[ \t][^\n]*"  # ATX heading line
    r"|\[(?:[^\[\]]*)\]\([^)]*\)"  # inline link [text](url)
    r"|\[(?:[^\[\]]*)\]\[[^\]]*\]"  # reference link [text][ref]
    r"|<a\b[^>]*>[\s\S]*?</a>"      # existing HTML anchor
    r"|<[^>]+>"                    # any other HTML tag / angle-bracket URL
    r"|https?://[^\s<>()\[\]]+"    # bare URL
    r"|[\w.+-]+@[\w-]+(?:\.[\w-]+)+",  # email address
    re.IGNORECASE | re.MULTILINE,
)

# Same idea for HTML text nodes: never link inside a bare URL or email address.
_TEXT_SKIP_RE = re.compile(r"https?://[^\s<>]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+", re.IGNORECASE)

# Text inside these elements is never linked.
_NO_LINK_TAGS = {"a", "h1", "h2", "h3", "h4", "h5", "h6", "script", "style", "code", "pre", "button", "title", "textarea"}
# Void elements never get an end tag, so they must not be pushed on the open-tag stack.
_VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


def is_safe_link_url(url: str) -> bool:
    """Only absolute http(s) URLs with a host -- never javascript:, data:, relative or
    whitespace-bearing URLs, since these hrefs are injected into clients' live posts."""
    u = (url or "").strip()
    if not u or any(c.isspace() or ord(c) < 32 for c in u):
        return False
    try:
        parts = urlsplit(u)
    except ValueError:
        return False
    return parts.scheme.lower() in {"http", "https"} and bool(parts.netloc)


def _compile_links(items: list[dict[str, str]]) -> tuple[re.Pattern[str] | None, dict[str, str]]:
    """One alternation over every label, longest first, whole words only.

    Linking in a single pass is what keeps links from nesting: applying labels one
    after another let a shorter label ("defense lawyer") match inside the link a longer
    one ("criminal defense lawyer") had just produced -> ``[criminal [defense lawyer](u2)](u1)``.
    """
    urls: dict[str, str] = {}
    for it in items or []:
        phrase = " ".join((it.get("label") or "").split())
        url = (it.get("url") or "").strip()
        if phrase and is_safe_link_url(url):
            urls.setdefault(phrase.casefold(), url)
    if not urls:
        return None, urls
    alts = "|".join(re.escape(p) for p in sorted(urls, key=len, reverse=True))
    return re.compile(rf"(?<![\w@/-])(?:{alts})(?![\w@]|[-/]\w|\.\w)", re.IGNORECASE), urls


class _Linker:
    """Links the first occurrence of each URL in a document (repeating the same link
    on every mention is over-optimisation that search engines discount or penalise)."""

    def __init__(self, items: list[dict[str, str]], already_linked: set[str] | None = None) -> None:
        self.pattern, self.urls = _compile_links(items)
        # Compare in Markdown-encoded form so "a(b)" and "a%28b%29" count as the same URL.
        self.used: set[str] = {_md_url(u) for u in already_linked or ()}

    def link(self, text: str, fmt) -> str:
        if self.pattern is None or not text:
            return text

        def repl(m: re.Match[str]) -> str:
            url = self.urls[m.group(0).casefold()]
            if _md_url(url) in self.used:
                return m.group(0)
            self.used.add(_md_url(url))
            return fmt(m.group(0), url)

        out, last = [], 0
        for skip in _TEXT_SKIP_RE.finditer(text):
            out.append(self.pattern.sub(repl, text[last : skip.start()]))
            out.append(skip.group(0))
            last = skip.end()
        out.append(self.pattern.sub(repl, text[last:]))
        return "".join(out)


def _md_url(url: str) -> str:
    # Characters that would end or break a Markdown link destination.
    return url.replace(" ", "%20").replace("(", "%28").replace(")", "%29")


def _html_link(text: str, url: str) -> str:
    return f'<a href="{html.escape(url, quote=True)}">{text}</a>'


class _LinkingParser(HTMLParser):
    def __init__(self, items: list[dict[str, str]], already_linked: set[str]) -> None:
        super().__init__(convert_charrefs=False)
        self._out: list[str] = []
        self._linker = _Linker(items, already_linked)
        self._tag_stack: list[str] = []

    def get_html(self) -> str:
        return "".join(self._out)

    def _emit_tag(self, tag: str, attrs, close: str) -> None:
        self._out.append("<" + tag)
        for k, v in attrs:
            self._out.append(f" {k}" if v is None else f' {k}="{html.escape(str(v), quote=True)}"')
        self._out.append(close)

    def handle_starttag(self, tag: str, attrs):
        if tag.lower() not in _VOID_TAGS:
            self._tag_stack.append(tag.lower())
        self._emit_tag(tag, attrs, ">")

    def handle_endtag(self, tag: str):
        t = tag.lower()
        if t in self._tag_stack:
            # Pop through any unclosed children so one sloppy tag can't leave the
            # parser believing it is still inside e.g. an <a> for the rest of the post.
            while self._tag_stack and self._tag_stack.pop() != t:
                pass
        self._out.append(f"</{tag}>")

    def handle_startendtag(self, tag: str, attrs):
        self._emit_tag(tag, attrs, " />")

    def handle_data(self, data: str):
        if _NO_LINK_TAGS.intersection(self._tag_stack):
            self._out.append(data)
        else:
            self._out.append(self._linker.link(data, _html_link))

    def handle_entityref(self, name: str):
        self._out.append(f"&{name};")

    def handle_charref(self, name: str):
        self._out.append(f"&#{name};")

    def handle_comment(self, data: str):
        self._out.append(f"<!--{data}-->")

    def handle_decl(self, decl: str):
        self._out.append(f"<!{decl}>")

    def unknown_decl(self, data: str):
        self._out.append(f"<![{data}]>")


_MD_LINK_DEST_RE = re.compile(r"\]\(<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\)")
_HREF_RE = re.compile(r"""<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1""", re.IGNORECASE | re.DOTALL)


def apply_context_links_html(content_html: str, items: list[dict[str, str]]) -> str:
    """Apply context links to HTML text nodes (never inside anchors, headings, code or
    scripts). A URL already linked anywhere in the document -- e.g. by the Markdown pass
    at generation time -- is not linked again."""
    if not (content_html or "").strip() or not items:
        return content_html or ""
    existing = {html.unescape(m.group(2)).strip() for m in _HREF_RE.finditer(content_html)}
    p = _LinkingParser(items, existing)
    p.feed(content_html)
    p.close()
    return p.get_html()


def apply_context_links_markdown(content_md: str, items: list[dict[str, str]]) -> str:
    """Apply context links to raw Markdown: the first plain-text mention of each label
    becomes ``[phrase](url)``. Code, headings, existing links, inline HTML, bare URLs
    and emails are left untouched. The later ``apply_context_links_html`` pass (at
    publish) sees these as existing anchors and never double-links them."""
    if not (content_md or "").strip() or not items:
        return content_md or ""
    existing = {m.group(1) for m in _MD_LINK_DEST_RE.finditer(content_md)}
    existing |= {html.unescape(m.group(2)).strip() for m in _HREF_RE.finditer(content_md)}
    linker = _Linker(items, existing)
    if linker.pattern is None:
        return content_md

    def md_link(text: str, url: str) -> str:
        return f"[{text}]({_md_url(url)})"

    parts: list[str] = []
    last = 0
    for skip_match in _MD_SKIP_RE.finditer(content_md):
        parts.append(linker.link(content_md[last : skip_match.start()], md_link))
        parts.append(skip_match.group(0))
        last = skip_match.end()
    parts.append(linker.link(content_md[last:], md_link))
    return "".join(parts)


# A link sitting inside another link's text: ``[outer [inner](u2) rest](u1)``.
_NESTED_LINK_RE = re.compile(r"\[([^\[\]\n]*)\[([^\[\]\n]+)\]\([^)\s]*\)")


def unnest_markdown_links(content_md: str) -> tuple[str, int]:
    """Repair links nested by the old one-label-at-a-time linker: keep the outer
    (longest) link and turn every inner link back into plain text. Returns the
    repaired Markdown and how many inner links were removed."""
    out, total = content_md or "", 0
    while True:
        out, n = _NESTED_LINK_RE.subn(r"[\1\2", out)
        if not n:
            return out, total
        total += n


_ANCHOR_SPLIT_RE = re.compile(r"(<a\b[^>]*>.*?</a\s*>)", re.IGNORECASE | re.DOTALL)
_MD_LINK_IN_HTML_RE = re.compile(r"\[([^\[\]<>\n]*)\]\((https?://[^)\s]*)\)")


def repair_markdown_links_in_html(content_html: str) -> tuple[str, int]:
    """Repair published HTML where nested Markdown links leaked through as literal text,
    e.g. ``<a href="u1">criminal [defense lawyer](u2)</a>``. Markdown link syntax inside
    an anchor becomes plain text (the outer, longest link wins); outside any anchor it
    becomes a real ``<a>``. Returns the repaired HTML and the number of fixes."""
    total = 0
    parts = _ANCHOR_SPLIT_RE.split(content_html or "")
    for i, part in enumerate(parts):
        if i % 2:  # inside an existing anchor
            while True:
                part, n = _MD_LINK_IN_HTML_RE.subn(r"\1", part)
                total += n
                if not n:
                    break
        else:
            part, nested = unnest_markdown_links(part)
            part, n = _MD_LINK_IN_HTML_RE.subn(
                lambda m: f'<a href="{html.escape(m.group(2), quote=True)}">{m.group(1)}</a>', part
            )
            total += nested + n
        parts[i] = part
    return "".join(parts), total
