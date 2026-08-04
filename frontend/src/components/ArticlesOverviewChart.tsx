"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  formatChartAxisDate,
  formatChartTooltipDate,
  type ArticlesOverviewDayPoint,
} from "@/lib/articlesOverview";

const SERIES_META = [
  { key: "published" as const, label: "Article published", color: "var(--aa-primary, #d97757)", swatchClass: "articlesOverviewChartTooltipSwatchPublished", fill: true },
  { key: "scheduled" as const, label: "Scheduled", color: "#f5c842", swatchClass: "articlesOverviewChartTooltipSwatchScheduled", fill: false },
  { key: "pending" as const, label: "Pending", color: "#e8e8ec", swatchClass: "articlesOverviewChartTooltipSwatchPending", fill: false },
  { key: "draft" as const, label: "Draft", color: "#7090c8", swatchClass: "articlesOverviewChartTooltipSwatchDraft", fill: false },
] as const;

type SeriesKey = (typeof SERIES_META)[number]["key"];

type Point = { x: number; y: number };

type TooltipState = {
  date: string;
  published: number;
  pending: number;
  scheduled: number;
  draft: number;
  clientX: number;
  clientY: number;
  /** CSS transform for placement above or below the cursor */
  placementTransform: string;
};

function chartCls(styles: Record<string, string> | undefined, key: string): string {
  return styles?.[key] ?? key;
}

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

export function ArticlesOverviewChart(props: {
  series: ArticlesOverviewDayPoint[];
  label?: string;
  /** Maps default ``articlesOverviewChart*`` keys to themed class names (e.g. dashboard ``wsChart*``). */
  styles?: Record<string, string>;
  tooltipClassName?: string;
  legendClassName?: string;
  wrapClassName?: string;
}) {
  const { series, label = "Article activity", styles, tooltipClassName, legendClassName, wrapClassName } = props;
  const cn = (key: string) => chartCls(styles, key);
  const gradId = useId().replace(/:/g, "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const W = 900;
  const H = 300;
  const padL = 48;
  const padR = 20;
  const padT = 28;
  const padB = 44;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const baselineY = padT + innerH;

  const max = useMemo(() => {
    if (!series.length) return 1;
    let m = 1;
    for (const p of series) {
      m = Math.max(m, p.published, p.pending, p.scheduled, p.draft);
    }
    return m;
  }, [series]);

  const yTicks = useMemo(() => {
    const steps = 4;
    return Array.from({ length: steps + 1 }, (_, i) => Math.round((max * (steps - i)) / steps));
  }, [max]);

  const xForIndex = useCallback(
    (i: number, n: number) => (n <= 1 ? padL + innerW / 2 : padL + (innerW * i) / (n - 1)),
    [padL, innerW],
  );

  const layout = useMemo(() => {
    const n = series.length;
    const xs = series.map((_, i) => xForIndex(i, n));
    const seriesPoints: Record<SeriesKey, Point[]> = { published: [], scheduled: [], pending: [], draft: [] };
    series.forEach((p, i) => {
      for (const meta of SERIES_META) {
        const v = p[meta.key];
        seriesPoints[meta.key].push({ x: xs[i], y: padT + innerH - (innerH * v) / max });
      }
    });
    const colWidth = n > 1 ? innerW / (n - 1) : innerW;
    return { xs, seriesPoints, colWidth };
  }, [series, innerW, innerH, max, padT, xForIndex]);

  const showTooltip = useCallback((point: ArticlesOverviewDayPoint, index: number, clientX: number, clientY: number) => {
    const tipW = 252;
    const tipH = 240;
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
      published: point.published,
      pending: point.pending,
      scheduled: point.scheduled,
      draft: point.draft,
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

  const tooltipTotal = tooltip ? tooltip.published + tooltip.pending + tooltip.scheduled + tooltip.draft : 0;

  const tooltipEl = tooltip ? (
    <div
      className={tooltipClassName || cn("articlesOverviewChartTooltip")}
      style={{
        position: "fixed",
        left: tooltip.clientX,
        top: tooltip.clientY,
        transform: tooltip.placementTransform,
        zIndex: 10000,
      }}
      role="tooltip"
      id="articles-overview-chart-tooltip"
    >
      <div className={cn("articlesOverviewChartTooltipPanel")}>
        <header className={cn("articlesOverviewChartTooltipHead")}>
          <time className={cn("articlesOverviewChartTooltipDate")} dateTime={tooltip.date}>
            {formatChartTooltipDate(tooltip.date)}
          </time>
        </header>
        <table className={cn("articlesOverviewChartTooltipTable")}>
          <caption className={cn("articlesOverviewChartTooltipCaption")}>Article counts for selected day</caption>
          <tbody>
            {SERIES_META.map((meta) => (
              <tr key={meta.key}>
                <th scope="row" className={cn("articlesOverviewChartTooltipMetric")}>
                  <span
                    className={`${cn("articlesOverviewChartTooltipSwatch")} ${cn(meta.swatchClass)}`}
                    style={{ backgroundColor: meta.color }}
                    aria-hidden="true"
                  />
                  <span>{meta.label}</span>
                </th>
                <td className={cn("articlesOverviewChartTooltipValue")}>{tooltip[meta.key].toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <footer className={cn("articlesOverviewChartTooltipFooter")}>
          <span className={cn("articlesOverviewChartTooltipFooterLabel")}>Total</span>
          <span className={cn("articlesOverviewChartTooltipFooterValue")}>{tooltipTotal.toLocaleString()}</span>
        </footer>
      </div>
      <span className={cn("articlesOverviewChartTooltipCaret")} aria-hidden="true" />
    </div>
  ) : null;

  if (!series.length) {
    return <div className={cn("articlesOverviewChartEmpty")}>No activity in this period yet.</div>;
  }

  const labelEvery = Math.max(1, Math.floor(series.length / 7));
  const hoverX = hoverIndex !== null ? layout.xs[hoverIndex] : null;

  return (
    <>
      <div ref={wrapRef} className={wrapClassName || cn("articlesOverviewChartWrap")}>
        <ul className={legendClassName || cn("articlesOverviewChartLegend")} aria-hidden="true">
          {SERIES_META.map((meta) => (
            <li key={meta.key}>
              <span className={cn("articlesOverviewChartLegendSwatch")} style={{ background: meta.color }} />
              {meta.label}
            </li>
          ))}
        </ul>

        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={label}
          className={cn("articlesOverviewChartSvg")}
          onMouseLeave={hideTooltip}
        >
          <defs>
            {SERIES_META.map((meta) => (
              <linearGradient key={meta.key} id={`${gradId}-${meta.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={meta.color} stopOpacity={0.32} />
                <stop offset="100%" stopColor={meta.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>

          {yTicks.map((tick, tickIndex) => {
            const y = padT + innerH - (innerH * tick) / max;
            return (
              <g key={`y-${tickIndex}-${tick}`}>
                <line
                  x1={padL}
                  y1={y}
                  x2={W - padR}
                  y2={y}
                  stroke="rgba(255,255,255,0.06)"
                  strokeDasharray="4 6"
                />
                <text x={padL - 10} y={y + 4} textAnchor="end" fontSize={11} fill="rgba(255,255,255,0.38)">
                  {tick}
                </text>
              </g>
            );
          })}

          {hoverX !== null && (
            <line
              x1={hoverX}
              y1={padT}
              x2={hoverX}
              y2={baselineY}
              stroke="rgba(255,255,255,0.16)"
              strokeWidth={1}
              className={cn("articlesOverviewChartHoverLine")}
            />
          )}

          <g className={cn("articlesOverviewChartSeriesGroup")}>
            {SERIES_META.map((meta) =>
              meta.fill ? (
                <path
                  key={`${meta.key}-area`}
                  d={areaPath(layout.seriesPoints[meta.key], baselineY)}
                  fill={`url(#${gradId}-${meta.key})`}
                  stroke="none"
                />
              ) : null,
            )}
            {SERIES_META.map((meta) => (
              <path
                key={`${meta.key}-line`}
                d={smoothPath(layout.seriesPoints[meta.key])}
                fill="none"
                stroke={meta.color}
                strokeWidth={meta.fill ? 2.5 : 2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className={cn("articlesOverviewChartLine")}
              />
            ))}
            {hoverIndex !== null &&
              SERIES_META.map((meta) => {
                const pt = layout.seriesPoints[meta.key][hoverIndex];
                if (!pt) return null;
                return (
                  <circle
                    key={`${meta.key}-dot`}
                    cx={pt.x}
                    cy={pt.y}
                    r={3.5}
                    fill={meta.color}
                    stroke="rgba(11,11,13,0.9)"
                    strokeWidth={1.5}
                  />
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
              className={cn("articlesOverviewChartHit")}
              onMouseMove={(e) => showTooltip(point, i, e.clientX, e.clientY)}
              onFocus={() => showTooltipFromSvg(point, i, layout.xs[i], padT + innerH / 2)}
              onBlur={hideTooltip}
              tabIndex={0}
              role="presentation"
            />
          ))}

          {series.map((point, i) =>
            i % labelEvery === 0 || i === series.length - 1 ? (
              <text
                key={`label-${point.date}`}
                x={layout.xs[i]}
                y={H - 10}
                textAnchor="middle"
                fontSize={11}
                fill="rgba(255,255,255,0.45)"
              >
                {formatChartAxisDate(point.date)}
              </text>
            ) : null,
          )}
        </svg>
      </div>
      {typeof document !== "undefined" && tooltipEl ? createPortal(tooltipEl, document.body) : null}
    </>
  );
}
