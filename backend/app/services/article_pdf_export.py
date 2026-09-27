"""Article → PDF export.

Renders one article (title, SEO metadata, featured image, body) into a
professionally formatted PDF via a headless Chromium (Playwright), which is
already a backend dependency and already has Chromium installed in the Docker
image for the AI Citation Google engine (see
``app/services/ai_citation/google_ai_overview_engine.py``). Reuses that same
lazy-shared-browser lifecycle instead of paying a ~1-2s browser launch cost on
every export.
"""

from __future__ import annotations

import html
import re
import unicodedata
from datetime import datetime, timezone
from urllib.parse import quote

import markdown as md

_playwright = None
_browser = None


async def _get_browser():
    """Lazily launch one shared headless Chromium instance, reused across export
    calls -- same convention as google_ai_overview_engine.py's _get_browser()."""
    global _playwright, _browser
    if _browser is not None:
        return _browser
    from playwright.async_api import async_playwright

    _playwright = await async_playwright().start()
    _browser = await _playwright.chromium.launch(headless=True)
    return _browser


def _markdown_to_html(raw: str) -> str:
    """Mirrors articles.py::_article_markdown_to_html's extension set so a PDF
    export renders the same body a WordPress publish would -- duplicated
    rather than cross-imported (that function is private to the routes
    module), matching this codebase's existing per-file small-helper style."""
    text = (raw or "").strip()
    if not text:
        return ""
    return md.markdown(text, extensions=["extra", "sane_lists", "smarty"])


_ILLEGAL_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|]')
_WHITESPACE = re.compile(r"\s+")
_MAX_FILENAME_LEN = 150


def build_export_filename(project_name: str | None, article_title: str | None) -> tuple[str, str]:
    """Returns (ascii_fallback, utf8_value) for a Content-Disposition header --
    the dual `filename=` / `filename*=UTF-8''...` pattern (RFC 6266/5987) so a
    non-ASCII project or article title (accents, emoji, etc.) still survives
    the browser's save dialog instead of silently mangling to '?????.pdf'."""
    project = (project_name or "Project").strip()
    title = (article_title or "Untitled article").strip()
    raw = f"{project} - {title}"
    raw = _ILLEGAL_FILENAME_CHARS.sub("", raw)
    raw = _WHITESPACE.sub(" ", raw).strip()
    if not raw:
        raw = "Riviso export"
    raw = raw[:_MAX_FILENAME_LEN]

    utf8_value = f"{raw}.pdf"
    ascii_fallback = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode("ascii")
    ascii_fallback = _WHITESPACE.sub(" ", ascii_fallback).strip()
    if not ascii_fallback:
        ascii_fallback = "article-export"
    return f"{ascii_fallback}.pdf", utf8_value


def content_disposition_header(project_name: str | None, article_title: str | None) -> str:
    ascii_fallback, utf8_value = build_export_filename(project_name, article_title)
    ascii_fallback = ascii_fallback.replace('"', "")
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(utf8_value)}"


def _render_template(*, project_name: str, article: dict) -> str:
    title = html.escape((article.get("title") or "Untitled article").strip())
    meta_title = html.escape((article.get("meta_title") or "").strip())
    meta_description = html.escape((article.get("meta_description") or "").strip())
    focus_keyphrase = html.escape((article.get("focus_keyphrase") or "").strip())
    image_url = (article.get("image_url") or "").strip()
    body_html = _markdown_to_html(article.get("article") or "")
    generated_on = datetime.now(timezone.utc).strftime("%d %b %Y")

    meta_rows = "".join(
        f'<tr><th>{label}</th><td>{value}</td></tr>'
        for label, value in (
            ("Meta Title", meta_title),
            ("Meta Description", meta_description),
            ("Focus Keyphrase", focus_keyphrase),
        )
        if value
    )
    meta_block = f'<table class="meta-table">{meta_rows}</table>' if meta_rows else ""

    # image_url is either a data: URI (no network fetch at all) or a URL this
    # backend itself stored during generation -- not arbitrary user input.
    image_block = (
        f'<div class="featured-image"><img src="{html.escape(image_url, quote=True)}" alt=""/></div>'
        if image_url
        else ""
    )

    return f"""<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  @page {{ size: A4; margin: 22mm 18mm 20mm; }}
  * {{ box-sizing: border-box; }}
  body {{
    font-family: "Georgia", "Times New Roman", serif;
    color: #1b1a17;
    font-size: 12.5px;
    line-height: 1.65;
  }}
  .letterhead {{
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    border-bottom: 2px solid #e15a2c;
    padding-bottom: 8px;
    margin-bottom: 22px;
    font-family: "Helvetica Neue", Arial, sans-serif;
  }}
  .letterhead .brand {{ font-weight: 800; font-size: 14px; letter-spacing: -0.01em; color: #1b1a17; }}
  .letterhead .brand span {{ color: #e15a2c; }}
  .letterhead .meta {{ font-size: 10.5px; color: #6e6b64; text-transform: uppercase; letter-spacing: 0.04em; }}
  h1.title {{
    font-size: 26px;
    line-height: 1.25;
    margin: 0 0 16px;
    letter-spacing: -0.01em;
    page-break-after: avoid;
  }}
  table.meta-table {{
    width: 100%;
    border-collapse: collapse;
    margin: 0 0 22px;
    font-family: "Helvetica Neue", Arial, sans-serif;
    font-size: 11px;
  }}
  table.meta-table th {{
    text-align: left;
    vertical-align: top;
    width: 150px;
    padding: 7px 10px 7px 0;
    color: #6e6b64;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    font-size: 9.5px;
    border-bottom: 1px solid #ece9e2;
  }}
  table.meta-table td {{
    padding: 7px 0;
    border-bottom: 1px solid #ece9e2;
  }}
  .featured-image {{ margin: 0 0 24px; text-align: center; }}
  .featured-image img {{
    max-width: 100%;
    max-height: 320px;
    border-radius: 8px;
    object-fit: cover;
  }}
  .article-body {{ font-size: 13px; }}
  .article-body h1, .article-body h2, .article-body h3 {{
    font-family: "Helvetica Neue", Arial, sans-serif;
    color: #1b1a17;
    page-break-after: avoid;
    margin: 22px 0 8px;
  }}
  .article-body h1 {{ font-size: 19px; }}
  .article-body h2 {{ font-size: 16px; }}
  .article-body h3 {{ font-size: 14px; }}
  .article-body p {{ margin: 0 0 12px; }}
  .article-body ul, .article-body ol {{ margin: 0 0 12px; padding-left: 22px; }}
  .article-body li {{ margin-bottom: 4px; }}
  .article-body blockquote {{
    margin: 0 0 14px;
    padding: 6px 16px;
    border-left: 3px solid #e15a2c;
    color: #4a473f;
    font-style: italic;
  }}
  .article-body img {{ max-width: 100%; border-radius: 6px; }}
  .article-body table {{ width: 100%; border-collapse: collapse; margin: 0 0 14px; font-size: 12px; }}
  .article-body th, .article-body td {{ border: 1px solid #ece9e2; padding: 6px 8px; text-align: left; }}
  .article-body code {{ background: #f4f3f0; padding: 1px 5px; border-radius: 3px; font-size: 11.5px; }}
  .article-body pre {{ background: #f4f3f0; padding: 10px 12px; border-radius: 6px; overflow-x: auto; }}
</style>
</head>
<body>
  <div class="letterhead">
    <span class="brand">Riviso<span>.</span></span>
    <span class="meta">{html.escape(project_name)} &middot; Exported {generated_on}</span>
  </div>
  <h1 class="title">{title}</h1>
  {meta_block}
  {image_block}
  <div class="article-body">{body_html}</div>
</body>
</html>"""


async def render_article_pdf(*, project_name: str, article: dict) -> bytes:
    html_doc = _render_template(project_name=project_name, article=article)
    browser = await _get_browser()
    # A fresh context per export (cheap -- the expensive part, the browser
    # process, stays warm) with JS disabled: article bodies are Markdown that
    # can pass through raw embedded HTML verbatim (see articleMarkdown.ts's
    # same caveat on the frontend), so this closes the entire script-execution
    # risk class without needing an HTML sanitizer dependency.
    context = await browser.new_context(java_script_enabled=False)
    try:
        page = await context.new_page()
        await page.set_content(html_doc, wait_until="load")
        pdf_bytes = await page.pdf(
            format="A4",
            print_background=True,
            display_header_footer=True,
            header_template="<span></span>",
            footer_template=(
                '<div style="width:100%;font-size:8.5px;color:#a6a29a;'
                'text-align:center;font-family:Helvetica,Arial,sans-serif;">'
                '<span class="pageNumber"></span> / <span class="totalPages"></span>'
                "</div>"
            ),
            margin={"top": "22mm", "bottom": "20mm", "left": "18mm", "right": "18mm"},
        )
        return pdf_bytes
    finally:
        await context.close()
