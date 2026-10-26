"""Inner (in-body) data-chart images for scheduled generation.

A scheduled job's ``inner_image_count`` (0-5) asks for that many charts inside the
article body. Each chart is built from numbers that appear in an H2 section's own text:
the text model only *extracts* figures (every value is checked against the section
text, so nothing invented gets drawn), then the chart is drawn deterministically as SVG
and hosted on Cloudinary, which serves it as PNG. AI image models garble numbers, so
they are deliberately not used here.

Sections without chartable numbers never get a fake chart. Slots charts can't fill are
filled with AI illustrations in the job's image-prompt style (like the featured image), so
the article gets the requested count. Runs only right after the scheduler generates fresh
content. Every failure is non-fatal: the article still publishes.
"""

from __future__ import annotations

import html
import logging
import math
import re
from typing import Any

from app.core.config import settings
from app.services.article_generation import generate_featured_image_only
from app.services.article_media_storage import save_article_media
from app.services.openai_client import OpenAIClient
from app.services.shopify_article_image import featured_image_bytes_from_data_url, featured_image_bytes_from_http_url
from app.services.storage_db import call_storage
from app.services.to_thread import run_sync

log = logging.getLogger(__name__)

MAX_INNER_IMAGES = 5

# A chart in the FAQ or the wrap-up reads as noise; keep them in the body sections.
_SKIP_HEADING = re.compile(r"faq|frequently asked|conclusion|final thoughts|key takeaways|summary", re.IGNORECASE)
_NUM = re.compile(r"\d[\d,]*(?:\.\d+)?")

W, H = 1200, 675
_ACCENT, _INK, _MUTED, _GRID = "#2563eb", "#0f172a", "#64748b", "#e2e8f0"
_FONT = "Arial, Helvetica, sans-serif"


# ---------------------------------------------------------------- section selection


def _insert_index(lines: list[str], h: int) -> int:
    """Line just after the section's first paragraph, or right under the heading when
    the section opens with a sub-heading."""
    j = h + 1
    while j < len(lines) and not lines[j].strip():
        j += 1
    if j < len(lines) and not lines[j].startswith("#"):
        while j < len(lines) and lines[j].strip() and not lines[j].startswith("#"):
            j += 1
        return j
    return h + 1


def body_sections(markdown: str) -> list[tuple[int, str, str]]:
    """``(insert_line_index, heading, section_text)`` for every H2 outside the FAQ/wrap-up."""
    lines = (markdown or "").split("\n")
    heads = [i for i, ln in enumerate(lines) if ln.startswith("## ")]
    out: list[tuple[int, str, str]] = []
    for pos, h in enumerate(heads):
        if _SKIP_HEADING.search(lines[h]):
            continue
        end = heads[pos + 1] if pos + 1 < len(heads) else len(lines)
        out.append((_insert_index(lines, h), lines[h][3:].strip(), "\n".join(lines[h + 1 : end]).strip()))
    return out


def _spread(items: list, n: int) -> list:
    """``items`` reordered so the first ``n`` are evenly spaced; the rest follow."""
    n = max(0, min(int(n or 0), MAX_INNER_IMAGES))
    if not n or not items:
        return []
    first = sorted({k * len(items) // n for k in range(min(n, len(items)))})
    return [items[i] for i in first] + [x for i, x in enumerate(items) if i not in first]


def candidate_sections(markdown: str, n: int) -> list[tuple[int, str, str]]:
    """Body sections that contain numbers, spread so the first ``n`` cover the article
    (the rest follow as fallbacks if extraction finds nothing chartable)."""
    return _spread([s for s in body_sections(markdown) if _NUM.search(s[2])], n)


def insert_images(markdown: str, placed: list[tuple[int, str, str]]) -> str:
    """Insert ``(line_index, url, alt)`` images as raw ``<img>`` tags -- the same format
    the editor's Insert Media writes, so it round-trips through the editor and both
    markdown renderers unchanged."""
    lines = (markdown or "").split("\n")
    for idx, url, alt in sorted(placed, key=lambda x: x[0], reverse=True):
        tag = f'<img src="{html.escape(url, quote=True)}" alt="{html.escape(alt, quote=True)}">'
        lines[idx:idx] = ["", tag, ""]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines))


# ---------------------------------------------------------------- data extraction

_EXTRACT_SYSTEM = (
    "You extract chartable data from a section of an article. Use ONLY numbers that appear "
    "in the given text, copied exactly. Never calculate, estimate, convert, round or add data.\n"
    'Return JSON: {"chart": null} when the text has nothing worth charting, otherwise\n'
    '{"chart": {"type": "bar" | "line" | "stat", "title": "<= 70 chars, what is measured", '
    '"unit": "<= 12 chars, e.g. %, USD bn, users, or empty", '
    '"points": [{"label": "<= 28 chars", "value": <number>, "unit": "the unit of THIS value, e.g. %, $, days"}]}}\n'
    "bar: 2-8 comparable items sharing one unit. line: 3-10 points in time order (label = period). "
    "stat: 1-3 standalone headline figures. All points must share the same unit.\n"
    "Every value must be a measured quantity of the SAME kind (e.g. all percentages, or all "
    "dollar amounts, or all days). Never use: a number that is part of a name or label "
    '(e.g. "100-point check", "Top 10 lenders", "Section 7"), a year or date, a phone '
    "number, a version or ID. If the section does not have such comparable figures, "
    'return {"chart": null}.'
)

_COUNTS = {"bar": (2, 8), "line": (3, 10), "stat": (1, 3)}


def _numbers_in(text: str) -> set[float]:
    return {float(m.replace(",", "")) for m in _NUM.findall(text or "")}


_MAGNITUDES = {
    "thousand": "thousand", "k": "thousand",
    "million": "million", "mn": "million", "m": "million",
    "billion": "billion", "bn": "billion", "b": "billion",
    "trillion": "trillion", "tn": "trillion",
    "lakh": "lakh", "lakhs": "lakh", "crore": "crore", "crores": "crore",
}
_SCALED_NUM = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*(" + "|".join(sorted(_MAGNITUDES, key=len, reverse=True)) + r")\b", re.IGNORECASE)


def _scale_only_numbers(text: str) -> dict[float, str]:
    """Numbers that appear in the text ONLY with a magnitude word ("$2.5 million" -> 2.5),
    mapped to that magnitude. Charting the bare 2.5 would be off by a factor of a million."""
    scaled: dict[float, str] = {}
    for n, word in _SCALED_NUM.findall(text or ""):
        scaled[float(n.replace(",", ""))] = _MAGNITUDES[word.lower()]
    plain = _numbers_in(_SCALED_NUM.sub(" ", text or ""))
    return {v: m for v, m in scaled.items() if v not in plain}


def _unit_magnitudes(*units: Any) -> set[str]:
    words = re.findall(r"[a-z]+", " ".join(str(u or "") for u in units).lower())
    return {_MAGNITUDES[w] for w in words if w in _MAGNITUDES}


def _unit_key(unit: Any) -> str:
    u = " ".join(str(unit or "").lower().split())
    return {"percent": "%", "per cent": "%", "pct": "%", "usd": "$", "dollars": "$", "aud": "$", "day": "days"}.get(u, u)


def _is_year(value: float) -> bool:
    # A calendar year is a date, not a quantity -- charting "1988" as a bar is meaningless.
    return value.is_integer() and 1900 <= value <= 2100


def _is_name_number(label: str, value: float) -> bool:
    """The figure is part of the item's own name ("100-point ID check" -> 100,
    "Top 10 lenders" -> 10), so it is a label, not a measurement."""
    return value in _numbers_in(label)


def validate_chart(chart: Any, section_text: str) -> dict | None:
    """Return a cleaned chart spec, or None unless every value appears in the text."""
    if not isinstance(chart, dict):
        return None
    kind = chart.get("type")
    pts = chart.get("points")
    if kind not in _COUNTS or not isinstance(pts, list):
        return None
    lo, hi = _COUNTS[kind]
    if not lo <= len(pts) <= hi:
        return None
    allowed = _numbers_in(section_text)
    scale_only = _scale_only_numbers(section_text)
    clean = []
    units: set[str] = set()
    for p in pts:
        if not isinstance(p, dict):
            return None
        label = " ".join(str(p.get("label") or "").split())[:28]
        try:
            value = float(p.get("value"))
        except (TypeError, ValueError):
            return None
        # ponytail: negatives rejected (bars/axes assume >= 0); add a zero baseline if needed.
        if not label or not math.isfinite(value) or value < 0 or abs(value) not in allowed:
            return None
        if value in scale_only and scale_only[value] not in _unit_magnitudes(p.get("unit"), chart.get("unit")):
            return None  # "$2.5 million" would be drawn as "$2.50"
        if _is_year(value) or _is_name_number(label, value):
            continue  # drop the point; the chart must still have enough real data (below)
        clean.append({"label": label, "value": value})
        units.add(_unit_key(p.get("unit")))
    if not lo <= len(clean) <= hi:
        return None
    # One chart = one kind of quantity. Mixed per-point units (e.g. rates in % next to fees in
    # $) would put incomparable numbers on one scale.
    if len(units - {""}) > 1:
        return None
    title = " ".join(str(chart.get("title") or "").split())[:70]
    if not title:
        return None
    return {"type": kind, "title": title, "unit": " ".join(str(chart.get("unit") or "").split())[:12], "points": clean}


# ---------------------------------------------------------------- rendering

_PREFIX_UNITS = {"$", "€", "£", "₹", "¥"}


def fmt_value(v: float, unit: str) -> str:
    num = f"{v:,.2f}".rstrip("0").rstrip(".")
    if unit in _PREFIX_UNITS:
        return f"{unit}{v:,.0f}" if v == int(v) else f"{unit}{v:,.2f}"
    if unit == "%":
        return f"{num}%"
    return f"{num} {unit}".strip()


def _t(x: float, y: float, s: str, *, size: int, fill: str = _INK, anchor: str = "start", weight: str = "normal") -> str:
    return (
        f'<text x="{x:.0f}" y="{y:.0f}" font-family="{_FONT}" font-size="{size}" fill="{fill}" '
        f'text-anchor="{anchor}" font-weight="{weight}">{html.escape(s)}</text>'
    )


def _bar(points: list[dict], unit: str) -> list[str]:
    top, bottom, x0, x1 = 150, 590, 330, 1020
    mx = max(p["value"] for p in points) or 1
    row = (bottom - top) / len(points)
    bar_h = min(48, row * 0.62)
    out = []
    for i, p in enumerate(points):
        y = top + i * row + (row - bar_h) / 2
        w = max(2, (x1 - x0) * p["value"] / mx)
        out.append(_t(x0 - 16, y + bar_h / 2 + 8, p["label"], size=22, anchor="end"))
        out.append(f'<rect x="{x0}" y="{y:.0f}" width="{w:.0f}" height="{bar_h:.0f}" rx="6" fill="{_ACCENT}"/>')
        out.append(_t(x0 + w + 12, y + bar_h / 2 + 8, fmt_value(p["value"], unit), size=22, weight="bold"))
    return out


def _line(points: list[dict], unit: str) -> list[str]:
    left, right, top, bottom = 110, 1110, 170, 540
    mx = max(p["value"] for p in points) or 1
    step = (right - left) / (len(points) - 1)
    xy = [(left + i * step, bottom - (bottom - top) * p["value"] / mx) for i, p in enumerate(points)]
    out = [f'<line x1="{left}" y1="{bottom}" x2="{right}" y2="{bottom}" stroke="{_GRID}" stroke-width="2"/>']
    out.append(
        f'<polyline points="{" ".join(f"{x:.0f},{y:.0f}" for x, y in xy)}" fill="none" '
        f'stroke="{_ACCENT}" stroke-width="5" stroke-linejoin="round"/>'
    )
    for (x, y), p in zip(xy, points):
        out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="8" fill="{_ACCENT}"/>')
        out.append(_t(x, y - 20, fmt_value(p["value"], unit), size=21, anchor="middle", weight="bold"))
        out.append(_t(x, bottom + 36, p["label"], size=20, fill=_MUTED, anchor="middle"))
    return out


def _stat(points: list[dict], unit: str) -> list[str]:
    n = len(points)
    gap, top, card_h = 30, 190, 330
    card_w = (W - 120 - gap * (n - 1)) / n
    out = []
    for i, p in enumerate(points):
        x = 60 + i * (card_w + gap)
        cx = x + card_w / 2
        out.append(f'<rect x="{x:.0f}" y="{top}" width="{card_w:.0f}" height="{card_h}" rx="18" fill="#eff6ff"/>')
        out.append(_t(cx, top + 170, fmt_value(p["value"], unit), size=92 if n < 3 else 72, fill=_ACCENT, anchor="middle", weight="bold"))
        out.append(_t(cx, top + 240, p["label"], size=26, anchor="middle"))
    return out


def render_chart_svg(chart: dict, source: str) -> bytes:
    body = {"bar": _bar, "line": _line, "stat": _stat}[chart["type"]](chart["points"], chart["unit"])
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
        f'<rect width="{W}" height="{H}" fill="#ffffff"/>',
        _t(60, 84, chart["title"], size=36, weight="bold"),
        *body,
        _t(60, H - 36, f"From this article: \u201c{source}\u201d"[:110], size=18, fill=_MUTED),
        "</svg>",
    ]
    return "".join(parts).encode("utf-8")


def chart_alt(chart: dict) -> str:
    kind = {"bar": "Bar chart", "line": "Line chart", "stat": "Key figures"}[chart["type"]]
    vals = ", ".join(f'{p["label"]}: {fmt_value(p["value"], chart["unit"])}' for p in chart["points"])
    return f'{kind}: {chart["title"]}. {vals}'


# ---------------------------------------------------------------- orchestration


def _plan_for(st: Any, user: dict) -> dict:
    plan_key = (user.get("subscription_type") or "").strip().lower() or "beta"
    try:
        plans = st.load_plans() or {}
        plan = plans.get(plan_key) if isinstance(plans, dict) else {}
        return plan if isinstance(plan, dict) else {}
    except Exception:
        return {}


async def _extract_chart(title: str, heading: str, text: str) -> dict | None:
    obj = await OpenAIClient().chat_json(
        model=settings.openai_text_model,
        system=_EXTRACT_SYSTEM,
        user=f"Article: {title}\nSection: {heading}\n\n{text[:6000]}",
    )
    return validate_chart(obj.get("chart"), text)


async def _illustrate(
    *, proj: dict, image_prompt_id: str | None, title: str, heading: str, keywords: list[str], project_id: str, article_id: str
) -> str | None:
    """AI illustration for one section, in the job's image-prompt style. Returns its
    Cloudinary URL, or None (never keep a data: URL or an expiring OpenAI URL)."""
    from app.services.article_pipeline import _resolve_image_prompt  # avoid an import cycle

    prompt = _resolve_image_prompt(proj=proj, image_prompt_id=image_prompt_id)
    gen = await generate_featured_image_only(
        title=heading or title,
        keywords=keywords,
        focus_keyphrase=title,
        brand_identity=proj.get("brand_identity") or "",
        niche_identifier=proj.get("niche_identifier") or "",
        image_prompt_text=(prompt or {}).get("text") or None,
    )
    url = (gen.get("image_url") or "").strip()
    got = featured_image_bytes_from_data_url(url) or await featured_image_bytes_from_http_url(url)
    if not got:
        return None
    data, content_type, _name = got
    _image_id, cloud_url = await run_sync(
        save_article_media, data=data, content_type=content_type, project_id=project_id, article_id=article_id
    )
    return cloud_url


async def add_inner_images(**kw: Any) -> int:
    """``build_inner_images`` + persist the article. Returns how many were added. Never raises."""
    new_markdown, added = await build_inner_images(**kw)
    if not added:
        return 0
    try:
        st = kw["st"]
        persist = getattr(st, "patch_article_fields", None) or st.update_article_fields
        await run_sync(call_storage, persist, kw["article_id"], {"article": new_markdown})
        return added
    except Exception:
        log.warning("inner images: could not save article %s", kw.get("article_id"), exc_info=True)
        return 0


async def build_inner_images(
    *,
    st: Any,
    user: dict,
    project_id: str,
    article_id: str,
    title: str,
    markdown: str,
    count: int,
    proj: dict | None = None,
    image_prompt_id: str | None = None,
    keywords: list[str] | None = None,
) -> tuple[str, int]:
    """Place ``count`` images in ``markdown``: data charts where a section has real figures,
    AI illustrations (needs ``proj``) for the remaining slots. Returns ``(markdown with the
    images, how many were added)`` without saving. Never raises."""
    try:
        count = max(0, min(int(count or 0), MAX_INNER_IMAGES))
        sections = body_sections(markdown)
        if not count or not sections:
            log.info("inner images: article %s has no body sections to place images in", article_id)
            return markdown, 0
        uid = (user.get("id") or "").strip()
        is_admin = (user.get("role") or "").strip().lower() == "admin"
        month_limit = _plan_for(st, user).get("max_inner_images_per_month")

        async def quota_ok() -> bool:
            if is_admin or not uid or not hasattr(st, "consume_inner_image_usage"):
                return True
            ok, msg = await run_sync(call_storage, st.consume_inner_image_usage, uid, month_limit=month_limit)
            if not ok:
                log.info("inner images: quota reached for article %s: %s", article_id, msg)
            return ok

        placed: list[tuple[int, str, str]] = []
        used_values: set[float] = set()  # one figure never appears in two charts
        out_of_quota = False
        # Bound text-model calls: a few fallback sections beyond the requested count.
        for line_idx, heading, text in candidate_sections(markdown, count)[: count + 3]:
            if len(placed) >= count:
                break
            try:
                chart = await _extract_chart(title, heading, text)
                if not chart:
                    continue
                values = {p["value"] for p in chart["points"]}
                if values & used_values:
                    continue
                if not await quota_ok():
                    out_of_quota = True
                    break
                svg = render_chart_svg(chart, heading or title)
                _image_id, cloud_url = await run_sync(
                    save_article_media, data=svg, content_type="image/svg+xml", project_id=project_id, article_id=article_id
                )
                # Only a Cloudinary URL is usable on WordPress; Cloudinary serves the SVG as PNG
                # by extension, which every CMS and email client renders.
                if cloud_url:
                    placed.append((line_idx, re.sub(r"\.svg$", ".png", cloud_url), chart_alt(chart)))
                    used_values |= values
            except Exception:
                log.warning("inner images: chart for section %r of article %s failed", heading, article_id, exc_info=True)

        charts = len(placed)
        if proj is not None and not out_of_quota and len(placed) < count:
            taken = {p[0] for p in placed}
            free = [s for s in body_sections(markdown) if s[0] not in taken]
            # ponytail: sequential (~1 min per image); bounded gather if prep latency matters.
            for line_idx, heading, _text in _spread(free, count - len(placed))[: count - len(placed)]:
                if not await quota_ok():
                    break
                try:
                    url = await _illustrate(
                        proj=proj, image_prompt_id=image_prompt_id, title=title, heading=heading,
                        keywords=keywords or [], project_id=project_id, article_id=article_id,
                    )
                    if url:
                        placed.append((line_idx, url, heading))
                except Exception:
                    log.warning("inner images: illustration for section %r of article %s failed", heading, article_id, exc_info=True)

        log.info("inner images: article %s got %d chart(s) + %d illustration(s) of %d requested", article_id, charts, len(placed) - charts, count)
        if not placed:
            return markdown, 0
        return insert_images(markdown, placed), len(placed)
    except Exception:
        log.warning("inner images: failed for article %s", article_id, exc_info=True)
        return markdown, 0
