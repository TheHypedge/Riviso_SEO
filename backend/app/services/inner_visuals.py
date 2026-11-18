"""
Diagram visuals for in-article images, built deterministically from a section's own text
(no model call, nothing invented): process steps, comparison tables and timelines.
Plus the visual planner that mixes them with data charts and AI illustrations.

Each extractor returns ``None`` unless the section really has that structure:
  process     an ordered list with 3+ steps          -> numbered step cards
  comparison  a markdown table (2+ columns, 2+ rows)  -> styled comparison table
  timeline    3+ distinct dated items                 -> dated milestones on a line

Rendered as 1200x675 SVG (same canvas, palette and footer as the data charts), uploaded and
linked as PNG through Cloudinary like the charts.
"""
from __future__ import annotations

import html
import re
from typing import Any

W, H = 1200, 675
_ACCENT, _ACCENT_SOFT, _INK, _MUTED, _GRID = "#2563eb", "#eff6ff", "#0f172a", "#64748b", "#e2e8f0"
_FONT = "Arial, Helvetica, sans-serif"

# Planner preference when variety ties: structured diagrams first (they explain the most),
# then data charts, then illustrations.
KIND_ORDER = ("comparison", "process", "timeline", "chart", "illustration")

_MONTHS = ("january february march april may june july august september october november december").split()
_MONTH_RE = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
_DATE_RE = re.compile(rf"\b(?:\d{{1,2}}\s+{_MONTH_RE}\s+|{_MONTH_RE}\s+(?:\d{{1,2}},?\s+)?)?((?:19|20)\d{{2}})\b", re.IGNORECASE)
_STEP_RE = re.compile(r"^\s*\d{1,2}[.)]\s+(.+)$")


# ---------------------------------------------------------------- text helpers

def _plain(s: str) -> str:
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", s or "")
    s = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", s)  # links -> anchor text
    s = re.sub(r"\[\[\d+\]\]", "", s)  # numbered citations
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"[*_`#>]", "", s)
    return " ".join(s.split())


def _first_sentence(s: str, limit: int) -> str:
    m = re.match(r"(.+?[.!?])(\s|$)", s)
    out = (m.group(1) if m else s).strip()
    return out if len(out) <= limit else out[: limit - 1].rsplit(" ", 1)[0] + "…"


def _wrap(text: str, max_px: float, size: int, max_lines: int) -> list[str]:
    """Greedy word wrap with an Arial width estimate; the last line gets an ellipsis if cut."""
    per_line = max(4, int(max_px / (size * 0.49)))
    words, lines, cur = (text or "").split(), [], ""
    for w in words:
        nxt = f"{cur} {w}".strip()
        if len(nxt) <= per_line:
            cur = nxt
            continue
        if cur:
            lines.append(cur)
        cur = w if len(w) <= per_line else w[: per_line - 1] + "…"
        if len(lines) == max_lines:
            break
    if cur and len(lines) < max_lines:
        lines.append(cur)
    if len(lines) == max_lines and " ".join(lines) != " ".join(words):
        last = lines[-1]
        lines[-1] = (last[: per_line - 1].rstrip() + "…") if len(last) >= per_line else last + "…"
    return lines[:max_lines]


def _t(x: float, y: float, s: str, *, size: int, fill: str = _INK, anchor: str = "start", weight: str = "normal") -> str:
    return (
        f'<text x="{x:.0f}" y="{y:.0f}" font-family="{_FONT}" font-size="{size}" fill="{fill}" '
        f'text-anchor="{anchor}" font-weight="{weight}">{html.escape(s)}</text>'
    )


def _lines(x: float, y: float, lines: list[str], *, size: int, gap: float = 1.3, **kw: Any) -> list[str]:
    return [_t(x, y + i * size * gap, ln, size=size, **kw) for i, ln in enumerate(lines)]


# ---------------------------------------------------------------- extraction (deterministic)

def steps_in(text: str) -> list[dict[str, str]] | None:
    """Ordered-list steps (3-6) as ``{title, detail}``; a bold lead-in becomes the title."""
    steps: list[dict[str, str]] = []
    for line in (text or "").splitlines():
        m = _STEP_RE.match(line)
        if not m:
            if steps and line.strip() and not line.startswith((" ", "\t")):
                break  # the list ended
            continue
        raw = m.group(1)
        lead = re.match(r"\*\*(.+?)\*\*[:.\s-]*(.*)", raw)
        if lead:
            title, detail = _plain(lead.group(1)).rstrip(":."), _plain(lead.group(2))
        else:
            body = _plain(raw)
            title, detail = _first_sentence(body, 60), ""
            rest = body[len(title):].strip() if not title.endswith("…") else ""
            detail = rest
        if title:
            steps.append({"title": title[:60], "detail": _first_sentence(detail, 120) if detail else ""})
    return steps[:6] if len(steps) >= 3 else None


def table_in(text: str) -> dict[str, Any] | None:
    """First GFM table as ``{header, rows}`` (<= 4 columns, <= 5 rows)."""
    block: list[str] = []
    for line in (text or "").splitlines():
        if line.strip().startswith("|"):
            block.append(line.strip())
        elif block:
            break
    if len(block) < 3 or not re.match(r"^\|?\s*:?-{2,}", block[1].replace(" ", "")):
        return None

    def cells(row: str) -> list[str]:
        parts = re.split(r"(?<!\\)\|", row.strip().strip("|"))
        return [_plain(c.replace("\\|", "|")) for c in parts]

    header = cells(block[0])[:4]
    rows = [cells(r)[: len(header)] for r in block[2:7]]
    rows = [r + [""] * (len(header) - len(r)) for r in rows if any(r)]
    if len(header) < 2 or len(rows) < 2:
        return None
    return {"header": header, "rows": rows}


def timeline_in(text: str) -> list[dict[str, str]] | None:
    """3-6 distinct dated items (bullets or sentences) in chronological order."""
    chunks: list[str] = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith(("|", "#")):
            continue
        body = re.sub(r"^[-*+]\s+|^\d+[.)]\s+", "", line)
        chunks += re.split(r"(?<=[.!?])\s+", body) if not line.startswith(("-", "*", "+")) else [body]
    events: list[tuple[tuple[int, int], str, str]] = []
    seen: set[str] = set()
    for c in chunks:
        plain = _plain(c)
        m = _DATE_RE.search(plain)
        if not m:
            continue
        label = " ".join(m.group(0).split()).rstrip(",")
        year = int(m.group(1))
        if label.lower() in seen:
            continue
        mon = next((i for i, name in enumerate(_MONTHS, 1) if name[:3] in label.lower()), 0)
        detail = (plain[: m.start()] + plain[m.end():]).strip(" ,;:-–—")
        detail = re.sub(r"^(in|on|by|from|since|until)\s+", "", detail, flags=re.IGNORECASE)
        if len(detail) < 8:
            continue
        seen.add(label.lower())
        events.append(((year, mon), label, _first_sentence(detail[:1].upper() + detail[1:], 90)))
    if len({e[0][0] for e in events}) < 2 or len(events) < 3:
        return None
    events.sort(key=lambda e: e[0])
    if len(events) > 6:  # keep the first, last and evenly spaced milestones between
        idx = sorted({round(i * (len(events) - 1) / 5) for i in range(6)})
        events = [events[i] for i in idx]
    return [{"label": label, "detail": detail} for _k, label, detail in events]


def section_options(text: str, *, has_numbers: bool, allow_illustration: bool) -> list[str]:
    """Visual kinds this section can honestly support, in KIND_ORDER."""
    opts = []
    if table_in(text):
        opts.append("comparison")
    if steps_in(text):
        opts.append("process")
    if timeline_in(text):
        opts.append("timeline")
    if has_numbers:
        opts.append("chart")
    if allow_illustration:
        opts.append("illustration")
    return opts


def order_for_variety(options: list[str], used: dict[str, int]) -> list[str]:
    """Least-used kind first, so several images in one article mix charts, diagrams and art."""
    return sorted(options, key=lambda k: (used.get(k, 0), KIND_ORDER.index(k)))


# ---------------------------------------------------------------- rendering

def _frame(title: str, source: str, body: list[str]) -> bytes:
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
        f'<rect width="{W}" height="{H}" fill="#ffffff"/>',
        f'<rect x="60" y="56" width="8" height="38" rx="4" fill="{_ACCENT}"/>',
        *_lines(84, 86, _wrap(title, W - 160, 34, 1), size=34, weight="bold"),
        *body,
        _t(60, H - 32, f"From this article: “{source}”"[:110], size=18, fill=_MUTED),
        "</svg>",
    ]
    return "".join(parts).encode("utf-8")


def render_process_svg(steps: list[dict[str, str]], title: str, source: str) -> bytes:
    n = len(steps)
    cols = n if n <= 3 else (2 if n == 4 else 3)
    rows = (n + cols - 1) // cols
    gap, top, bottom = 28, 132, H - 70
    card_w = (W - 120 - gap * (cols - 1)) / cols
    card_h = min(230.0, (bottom - top - gap * (rows - 1)) / rows)
    top += ((bottom - top) - (card_h * rows + gap * (rows - 1))) / 2  # centre the grid vertically
    out: list[str] = []
    for i, s in enumerate(steps):
        r, c = divmod(i, cols)
        x, y = 60 + c * (card_w + gap), top + r * (card_h + gap)
        out.append(f'<rect x="{x:.0f}" y="{y:.0f}" width="{card_w:.0f}" height="{card_h:.0f}" rx="16" fill="{_ACCENT_SOFT}"/>')
        out.append(f'<circle cx="{x + 42:.0f}" cy="{y + 44:.0f}" r="22" fill="{_ACCENT}"/>')
        out.append(_t(x + 42, y + 52, str(i + 1), size=22, fill="#ffffff", anchor="middle", weight="bold"))
        if c < cols - 1 and i < n - 1:
            ay = y + 44
            out.append(f'<path d="M{x + card_w + 6:.0f} {ay:.0f} l14 0 m-6 -6 l6 6 l-6 6" stroke="{_ACCENT}" stroke-width="3" fill="none"/>')
        tsize = 24 if rows == 1 else 22
        tl = _wrap(s["title"], card_w - 96, tsize, 2)
        out += _lines(x + 80, y + 52, tl, size=tsize, weight="bold")
        if s.get("detail"):
            dy = y + 52 + len(tl) * tsize * 1.3 + 14
            room = int((y + card_h - 18 - dy) // (19 * 1.35)) + 1
            out += _lines(x + 28, dy + 10, _wrap(s["detail"], card_w - 56, 19, max(1, min(4, room))), size=19, fill=_MUTED, gap=1.35)
    return _frame(title, source, out)


def render_comparison_svg(table: dict[str, Any], title: str, source: str) -> bytes:
    header, rows = table["header"], table["rows"]
    ncol = len(header)
    x0, top, width = 60, 128, W - 120
    first_w = width * (0.30 if ncol > 2 else 0.40)
    other_w = (width - first_w) / (ncol - 1)
    widths = [first_w] + [other_w] * (ncol - 1)
    head_h = 62
    row_h = min(92, (H - 80 - top - head_h) / len(rows))
    out = [f'<rect x="{x0}" y="{top}" width="{width:.0f}" height="{head_h}" rx="12" fill="{_ACCENT}"/>']
    x = x0
    for j, h in enumerate(header):
        out += _lines(x + 18, top + 39, _wrap(h, widths[j] - 30, 21, 1), size=21, fill="#ffffff", weight="bold")
        x += widths[j]
    for i, row in enumerate(rows):
        y = top + head_h + i * row_h
        if i % 2 == 1:
            out.append(f'<rect x="{x0}" y="{y:.0f}" width="{width:.0f}" height="{row_h:.0f}" fill="#f8fafc"/>')
        out.append(f'<line x1="{x0}" y1="{y + row_h:.0f}" x2="{x0 + width}" y2="{y + row_h:.0f}" stroke="{_GRID}" stroke-width="2"/>')
        x = x0
        lines_fit = max(1, min(3, int((row_h - 16) // (19 * 1.3))))
        for j, cell in enumerate(row):
            size = 20 if j == 0 else 19
            wrapped = _wrap(cell, widths[j] - 30, size, lines_fit)
            block_h = len(wrapped) * size * 1.3
            out += _lines(x + 18, y + (row_h - block_h) / 2 + size * 0.95, wrapped, size=size,
                          weight="bold" if j == 0 else "normal", fill=_INK if j == 0 else "#334155")
            x += widths[j]
    return _frame(title, source, out)


def render_timeline_svg(events: list[dict[str, str]], title: str, source: str) -> bytes:
    n = len(events)
    left, right, axis_y = 160, W - 160, 290
    step = (right - left) / (n - 1)
    out = [f'<line x1="{left - 40}" y1="{axis_y}" x2="{right + 40}" y2="{axis_y}" stroke="{_GRID}" stroke-width="6" stroke-linecap="round"/>']
    col_w = min(250, step + 40)
    for i, e in enumerate(events):
        cx = left + i * step
        out.append(f'<circle cx="{cx:.0f}" cy="{axis_y}" r="15" fill="#ffffff" stroke="{_ACCENT}" stroke-width="6"/>')
        out += _lines(cx, axis_y - 40, _wrap(e["label"], col_w, 24, 1), size=24, fill=_ACCENT, anchor="middle", weight="bold")
        out += _lines(cx, axis_y + 58, _wrap(e["detail"], col_w - 10, 19, 5), size=19, fill="#334155", anchor="middle", gap=1.35)
    return _frame(title, source, out)


def render_visual(kind: str, data: Any, title: str, source: str) -> tuple[bytes, str]:
    """(svg bytes, alt text) for a diagram kind."""
    t = " ".join((title or "").split())[:70]
    if kind == "process":
        alt = f"Process: {t}. " + "; ".join(f"Step {i}: {s['title']}" for i, s in enumerate(data, 1))
        return render_process_svg(data, t, source), alt[:250]
    if kind == "comparison":
        alt = f"Comparison table: {t}. Columns: {', '.join(data['header'])}"
        return render_comparison_svg(data, t, source), alt[:250]
    if kind == "timeline":
        alt = f"Timeline: {t}. " + "; ".join(f"{e['label']}: {e['detail']}" for e in data)
        return render_timeline_svg(data, t, source), alt[:250]
    raise ValueError(kind)


def extract(kind: str, text: str) -> Any:
    return {"process": steps_in, "comparison": table_in, "timeline": timeline_in}[kind](text)
