"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  formatChartAxisDate,
  formatChartTooltipDate,
  type ArticlesOverviewDayPoint,
} from "@/lib/articlesOverview";

/**
 * Publishing Activity chart for the Project Overview tab.
 *
 * Deliberately a separate component from ArticlesOverviewChart (which the
 * admin workspace dashboard also renders via ProjectOverviewDashboard.tsx) --
 * changing that shared component would silently change the admin dashboard
 * too, which is out of scope for this redesign.
 *
 * Smooth overlapping area/line curves per series (not stacked), with an
 * interactive checkbox legend so sparse or zero-value series can be hidden
 * instead of cluttering the plot -- that decluttering, plus a palette drawn
 * only from existing tokens (ember primary + warning + two neutral opacity
 * steps, no new hues), is what keeps this from reading as noisy regardless
 * of how spiky the underlying counts are.
 */

const SEGMENTS = [
  { key: "published" as const, label: "Published", color: "var(--aa-primary)", fill: true },
  { key: "scheduled" as const, label: "Scheduled", color: "var(--aa-warning, #d4a017)", fill: false },
  { key: "pending" as const, label: "Pending", color: "var(--aa-muted)", fill: false },
  { key: "draft" as const, label: "Draft", color: "var(--aa-muted-soft)", fill: false },
] as const;

type SegmentKey = (typeof SEGMENTS)[number]["key"];

type Point = { x: number; y: number };

type TooltipState = {
  date: string;
  values: Record<SegmentKey, number>;
  clientX: number;
  clientY: number;
  placementTransform: string;
};

/** Catmull-Rom spline through `points`, converted to cubic Bezier segments (tension 1/6). */
function smoothPath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function areaPath(points: Point[], baselineY: number): string {
  if (points.length === 0) return "";
  const line = smoothPath(points);
  const first = points[0];
  const last = points[points.length - 1];
  return `${line} L ${last.x} ${baselineY} L ${first.x} ${baselineY} Z`;
}

const ZERO_TOTALS: Record<SegmentKey, number> = { published: 0, scheduled: 0, pending: 0, draft: 0 };

export function ProjectActivityChart(props: {
  series: ArticlesOverviewDayPoint[];
  label?: string;
  styles: Record<string, string>;
}) {
  const { series, label = "Article activity by day", styles: s } = props;
  const gradId = useId().replace(/:/g, "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const totals = useMemo(() => {
    const t = { ...ZERO_TOTALS };
    for (const p of series) {
      t.published += p.published;
      t.scheduled += p.scheduled;
      t.pending += p.pending;
      t.draft += p.draft;
    }
    return t;
  }, [series]);

  const [visible, setVisible] = useState<Set<SegmentKey>>(() => new Set(SEGMENTS.map((m) => m.key)));
  const userToggledRef = useRef(false);

  // Default to series that actually have data in the current range; once the
  // user manually toggles a checkbox, stop overriding their choice.
  useEffect(() => {
    if (userToggledRef.current) return;
    const withData = SEGMENTS.filter((m) => totals[m.key] > 0).map((m) => m.key);
    setVisible(new Set(withData.length > 0 ? withData : SEGMENTS.map((m) => m.key)));
  }, [totals]);

  const toggleSegment = useCallback((key: SegmentKey) => {
    userToggledRef.current = true;
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key) && next.size === 1) return prev; // keep at least one series visible
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const W = 900;
  const H = 280;
  const padL = 40;
  const padR = 12;
  const padT = 20;
  const padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const baselineY = padT + innerH;

  const max = useMemo(() => {
    let m = 1;
    for (const p of series) {
      for (const meta of SEGMENTS) {
        if (visible.has(meta.key)) m = Math.max(m, p[meta.key]);
      }
    }
    return m;
  }, [series, visible]);

  const yTicks = useMemo(() => {
    const steps = 4;
    return Array.from({ length: steps + 1 }, (_, i) => Math.round((max * (steps - i)) / steps));
  }, [max]);

  const n = series.length;
  const xForIndex = useCallback((i: number) => (n <= 1 ? padL + innerW / 2 : padL + (innerW * i) / (n - 1)), [n, padL, innerW]);

  const layout = useMemo(() => {
    const xs = series.map((_, i) => xForIndex(i));
    const seriesPoints: Record<SegmentKey, Point[]> = { published: [], scheduled: [], pending: [], draft: [] };
    series.forEach((p, i) => {
      for (const meta of SEGMENTS) {
        const v = p[meta.key];
        seriesPoints[meta.key].push({ x: xs[i], y: padT + innerH - (innerH * v) / max });
      }
    });
    const colWidth = n > 1 ? innerW / (n - 1) : innerW;
    return { xs, seriesPoints, colWidth };
  }, [series, xForIndex, innerH, padT, max, n, innerW]);

  const showTooltip = useCallback((point: ArticlesOverviewDayPoint, index: number, clientX: number, clientY: number) => {
    const tipW = 220;
    const tipH = 200;
    const pad = 14;
    const clampedX =
      typeof window !== "undefined"
        ? Math.min(Math.max(clientX, tipW / 2 + pad), window.innerWidth - tipW / 2 - pad)
        : clientX;
    const placementTransform =
      typeof window !== "undefined" && clientY < tipH + pad + 72
        ? "translate(-50%, 14px)"
        : "translate(-50%, calc(-100% - 14px))";
    setHoverIndex(index);
    setTooltip({
      date: point.date,
      values: { published: point.published, scheduled: point.scheduled, pending: point.pending, draft: point.draft },
      clientX: clampedX,
      clientY,
      placementTransform,
    });
  }, []);

  const showTooltipFromSvg = useCallback(
    (point: ArticlesOverviewDayPoint, index: number, svgX: number, svgY: number) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const svg = wrap.querySelector("svg");
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const clientX = rect.left + (svgX / W) * rect.width;
      const clientY = rect.top + (svgY / H) * rect.height;
      showTooltip(point, index, clientX, clientY);
    },
    [showTooltip],
  );

  const hideTooltip = useCallback(() => {
    setTooltip(null);
    setHoverIndex(null);
  }, []);

  const visibleSegmentsMeta = SEGMENTS.filter((m) => visible.has(m.key));
  const tooltipTotal = tooltip
    ? visibleSegmentsMeta.reduce((sum, m) => sum + tooltip.values[m.key], 0)
    : 0;

  const tooltipEl = tooltip ? (
    <div
      className={s.projectActivityTooltip}
      style={{ position: "fixed", left: tooltip.clientX, top: tooltip.clientY, transform: tooltip.placementTransform, zIndex: 10000 }}
      role="tooltip"
    >
      <div className={s.projectActivityTooltipPanel}>
        <header className={s.projectActivityTooltipHead}>
          <time className={s.projectActivityTooltipDate} dateTime={tooltip.date}>
            {formatChartTooltipDate(tooltip.date)}
          </time>
        </header>
        <table className={s.projectActivityTooltipTable}>
          <caption className={s.projectActivityTooltipCaption}>Article counts for selected day</caption>
          <tbody>
            {visibleSegmentsMeta.map((meta) => (
              <tr key={meta.key}>
                <th scope="row" className={s.projectActivityTooltipMetric}>
                  <span className={s.projectActivityTooltipSwatch} style={{ background: meta.color }} aria-hidden="true" />
                  <span>{meta.label}</span>
                </th>
                <td className={s.projectActivityTooltipValue}>{tooltip.values[meta.key].toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <footer className={s.projectActivityTooltipFooter}>
          <span className={s.projectActivityTooltipFooterLabel}>Total</span>
          <span className={s.projectActivityTooltipFooterValue}>{tooltipTotal.toLocaleString()}</span>
        </footer>
      </div>
      <span className={s.projectActivityTooltipCaret} aria-hidden="true" />
    </div>
  ) : null;

  return (
    <div className={s.projectActivityRoot}>
      {/* ── Stat chips: range-scoped totals per series (display only) ── */}
      <div className={s.projectActivityChips} role="list" aria-label="Totals for the selected range">
        {SEGMENTS.map((meta) => (
          <div key={meta.key} className={s.projectActivityChip} role="listitem">
            <span className={s.projectActivityChipDot} style={{ background: meta.color }} aria-hidden="true" />
            <span className={s.projectActivityChipValue}>{totals[meta.key].toLocaleString()}</span>
            <span className={s.projectActivityChipLabel}>{meta.label}</span>
          </div>
        ))}
      </div>

      {/* ── Interactive legend: toggles which series render in the chart ── */}
      <div className={s.projectActivityToggleRow} role="group" aria-label="Toggle chart series">
        {SEGMENTS.map((meta) => {
          const isOn = visible.has(meta.key);
          return (
            <button
              key={meta.key}
              type="button"
              className={s.projectActivityToggle}
              aria-pressed={isOn}
              onClick={() => toggleSegment(meta.key)}
            >
              <span
                className={`${s.projectActivityToggleBox} ${isOn ? s.projectActivityToggleBoxOn : ""}`}
                style={isOn ? { background: meta.color, borderColor: meta.color } : undefined}
                aria-hidden="true"
              >
                {isOn ? "✓" : ""}
              </span>
              {meta.label}
            </button>
          );
        })}
      </div>

      {series.length === 0 ? (
        <div className={s.projectActivityEmpty}>No activity in this period yet.</div>
      ) : (
        <div ref={wrapRef} className={s.projectActivityWrap}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={label}
            className={s.projectActivitySvg}
            onMouseLeave={hideTooltip}
          >
            <defs>
              {SEGMENTS.map((meta) => (
                <linearGradient key={meta.key} id={`${gradId}-${meta.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={meta.color} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={meta.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>

            {yTicks.map((tick, tickIndex) => {
              const y = padT + innerH - (innerH * tick) / max;
              return (
                <g key={`y-${tickIndex}-${tick}`}>
                  <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--aa-hairline)" strokeDasharray="4 6" />
                  <text x={padL - 10} y={y + 4} textAnchor="end" fontSize={11} fill="var(--aa-muted)">
                    {tick}
                  </text>
                </g>
              );
            })}

            {hoverIndex !== null && (
              <line
                x1={layout.xs[hoverIndex]}
                y1={padT}
                x2={layout.xs[hoverIndex]}
                y2={baselineY}
                stroke="var(--aa-hairline)"
                strokeWidth={1}
              />
            )}

            <g>
              {SEGMENTS.filter((m) => visible.has(m.key) && m.fill).map((meta) => (
                <path
                  key={`${meta.key}-area`}
                  d={areaPath(layout.seriesPoints[meta.key], baselineY)}
                  fill={`url(#${gradId}-${meta.key})`}
                  stroke="none"
                />
              ))}
              {SEGMENTS.filter((m) => visible.has(m.key)).map((meta) => (
                <path
                  key={`${meta.key}-line`}
                  d={smoothPath(layout.seriesPoints[meta.key])}
                  fill="none"
                  stroke={meta.color}
                  strokeWidth={meta.fill ? 2.5 : 2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ transition: "d 0.2s ease" }}
                />
              ))}
              {hoverIndex !== null &&
                SEGMENTS.filter((m) => visible.has(m.key)).map((meta) => {
                  const pt = layout.seriesPoints[meta.key][hoverIndex];
                  if (!pt) return null;
                  return (
                    <circle key={`${meta.key}-dot`} cx={pt.x} cy={pt.y} r={3.5} fill={meta.color} stroke="var(--aa-surface-card)" strokeWidth={1.5} />
                  );
                })}
            </g>

            {series.map((point, i) => (
              <rect
                key={point.date}
                x={padL + layout.colWidth * (i - 0.5)}
                y={padT}
                width={layout.colWidth}
                height={innerH}
                fill="transparent"
                className={s.projectActivityHit}
                onMouseMove={(e) => showTooltip(point, i, e.clientX, e.clientY)}
                onFocus={() => showTooltipFromSvg(point, i, layout.xs[i], padT + innerH / 2)}
                onBlur={hideTooltip}
                tabIndex={0}
                role="presentation"
              />
            ))}

            {series.map((point, i) => {
              const labelEvery = Math.max(1, Math.floor(series.length / 7));
              return i % labelEvery === 0 || i === series.length - 1 ? (
                <text key={`label-${point.date}`} x={layout.xs[i]} y={H - 10} textAnchor="middle" fontSize={11} fill="var(--aa-muted)">
                  {formatChartAxisDate(point.date)}
                </text>
              ) : null;
            })}
          </svg>
        </div>
      )}
      {typeof document !== "undefined" && tooltipEl ? createPortal(tooltipEl, document.body) : null}
    </div>
  );
}
