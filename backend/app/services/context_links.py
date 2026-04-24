from __future__ import annotations

import html
import re
from html.parser import HTMLParser


class _LinkingParser(HTMLParser):
    def __init__(self, items: list[dict[str, str]]) -> None:
        super().__init__(convert_charrefs=False)
        self._out: list[str] = []
        self._items = []
        for it in items or []:
            phrase = (it.get("label") or "").strip()
            url = (it.get("url") or "").strip()
            if not phrase or not url:
                continue
            self._items.append((re.compile(re.escape(phrase), flags=re.IGNORECASE), phrase, url))
        self._tag_stack: list[str] = []

    def get_html(self) -> str:
        return "".join(self._out)

    def handle_starttag(self, tag: str, attrs):
        self._tag_stack.append(tag.lower())
        self._out.append("<" + tag)
        for k, v in attrs:
            if v is None:
                self._out.append(f" {k}")
            else:
                self._out.append(f' {k}="{html.escape(str(v), quote=True)}"')
        self._out.append(">")

    def handle_endtag(self, tag: str):
        t = tag.lower()
        if self._tag_stack and self._tag_stack[-1] == t:
            self._tag_stack.pop()
        self._out.append(f"</{tag}>")

    def handle_startendtag(self, tag: str, attrs):
        self._out.append("<" + tag)
        for k, v in attrs:
            if v is None:
                self._out.append(f" {k}")
            else:
                self._out.append(f' {k}="{html.escape(str(v), quote=True)}"')
        self._out.append(" />")

    def handle_data(self, data: str):
        # Do not link inside existing anchors.
        if "a" in self._tag_stack:
            self._out.append(data)
            return
        out = data
        for pat, _phrase, url in self._items:
            out = pat.sub(lambda m: f'<a href="{html.escape(url, quote=True)}">{m.group(0)}</a>', out)
        self._out.append(out)

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


def apply_context_links_html(content_html: str, items: list[dict[str, str]]) -> str:
    """
    Apply context links by replacing text nodes in HTML.
    This survives Markdown->HTML formatting (bold/headers/lists) much better than raw regex over the whole string.
    """
    if not (content_html or "").strip():
        return content_html or ""
    if not items:
        return content_html or ""
    p = _LinkingParser(items)
    p.feed(content_html)
    p.close()
    return p.get_html()

