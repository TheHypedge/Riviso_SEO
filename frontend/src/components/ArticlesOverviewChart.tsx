"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";

import {
  formatChartAxisDate,
  formatChartTooltipDate,
  type ArticlesOverviewDayPoint,
} from "@/lib/articlesOverview";

const SERIES_META = [
  { key: "published" as const, label: "Article published", color: "var(--aa-primary, #d97757)", swatchClass: "articlesOverviewChartTooltipSwatchPublished" },
  { key: "pending" as const, label: "Pending", color: "#e8e8ec", swatchClass: "articlesOverviewChartTooltipSwatchPending" },
  { key: "scheduled" as const, label: "Scheduled", color: "#f5c842", swatchClass: "articlesOverviewChartTooltipSwatchScheduled" },
] as const;

type TooltipState = {
  date: string;
  published: number;
  pending: number;
  scheduled: number;
  left: number;
  top: number;
};

function chartCls(styles: Record<string, string> | undefined, key: string): string {
  return styles?.[key] ?? key;
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

  const W = 900;
  const H = 300;
  const padL = 48;
  const padR = 20;
  const padT = 28;
  const padB = 44;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const max = useMemo(() => {
    if (!series.length) return 1;
    let m = 1;
    for (const p of series) {
      m = Math.max(m, p.published, p.pending, p.scheduled);
    }
    return m;
  }, [series]);

  const yTicks = useMemo(() => {
    const steps = 4;
    return Array.from({ length: steps + 1 }, (_, i) => Math.round((max * (steps - i)) / steps));
  }, [max]);

  const layout = useMemo(() => {
    const n = series.length;
    const groupW = innerW / Math.max(1, n);
    const gap = Math.min(4, groupW * 0.08);
    const barW = Math.max(3, (groupW - gap * 2) / SERIES_META.length - 2);
    return series.map((p, i) => {
      const gx = padL + groupW * i + groupW / 2;
      const bars = SERIES_META.map((meta, bi) => {
        const v = p[meta.key];
        const h = (innerH * v) / max;
        const x = gx - (SERIES_META.length * barW) / 2 - gap + bi * (barW + 2) + barW / 2;
        const y = padT + innerH - h;
        return { ...meta, value: v, x: x - barW / 2, y, w: barW, h };
      });
      return { point: p, gx, groupW, bars };
    });
  }, [series, innerW, innerH, max]);

  const showTooltip = useCallback(
    (point: ArticlesOverviewDayPoint, clientX: number, clientY: number) => {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const tipW = 252;
      const pad = 14;
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const wrapW = rect.width;
      const left = Math.min(Math.max(x, tipW / 2 + pad), wrapW - tipW / 2 - pad);
      const top = Math.max(y - 18, 52);
      setTooltip({
        date: point.date,
        published: point.published,
        pending: point.pending,
        scheduled: point.scheduled,
        left,
        top,
      });
    },
    [],
  );

  const hideTooltip = useCallback(() => setTooltip(null), []);

  const tooltipTotal = tooltip ? tooltip.published + tooltip.pending + tooltip.scheduled : 0;

  if (!series.length) {
    return <div className={cn("articlesOverviewChartEmpty")}>No activity in this period yet.</div>;
  }

  const labelEvery = Math.max(1, Math.floor(series.length / 7));

  return (
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
        height="auto"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={label}
        className={cn("articlesOverviewChartSvg")}
        onMouseLeave={hideTooltip}
      >
        <defs>
          {SERIES_META.map((meta) => (
            <linearGradient key={meta.key} id={`${gradId}-${meta.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={meta.color} stopOpacity={meta.key === "published" ? 1 : 0.95} />
              <stop offset="100%" stopColor={meta.color} stopOpacity={meta.key === "published" ? 0.55 : 0.35} />
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

        {layout.map(({ point, gx, groupW, bars }, i) => (
          <g key={point.date}>
            <rect
              x={padL + groupW * i}
              y={padT}
              width={groupW}
              height={innerH}
              fill="transparent"
              className={cn("articlesOverviewChartHit")}
              onMouseMove={(e) => showTooltip(point, e.clientX, e.clientY)}
              onFocus={() => showTooltip(point, gx, padT)}
              onBlur={hideTooltip}
              tabIndex={0}
              role="presentation"
            />
            {bars.map((bar) =>
              bar.h > 0.5 ? (
                <rect
                  key={bar.key}
                  x={bar.x}
                  y={bar.y}
                  width={bar.w}
                  height={bar.h}
                  rx={3}
                  fill={`url(#${gradId}-${bar.key})`}
                  className={cn("articlesOverviewChartBar")}
                />
              ) : (
                <rect
                  key={bar.key}
                  x={bar.x}
                  y={padT + innerH - 2}
                  width={bar.w}
                  height={2}
                  rx={1}
                  fill={bar.color}
                  fillOpacity={0.2}
                />
              ),
            )}
            {i % labelEvery === 0 || i === series.length - 1 ? (
              <text x={gx} y={H - 10} textAnchor="middle" fontSize={11} fill="rgba(255,255,255,0.45)">
                {formatChartAxisDate(point.date)}
              </text>
            ) : null}
          </g>
        ))}
      </svg>

      {tooltip ? (
        <div
          className={tooltipClassName || cn("articlesOverviewChartTooltip")}
          style={{
            left: tooltip.left,
            top: tooltip.top,
            transform: "translate(-50%, -100%)",
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
              <caption className={cn("articlesOverviewChartTooltipCaption")}>
                Article counts for selected day
              </caption>
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
      ) : null}
    </div>
  );
}
