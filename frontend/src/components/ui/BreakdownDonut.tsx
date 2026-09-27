"use client";

import { Cell, Pie, PieChart, Tooltip } from "recharts";

import { ChartContainer, ChartTooltipContent } from "./Chart";

type CssModule = { [key: string]: string };

/** Shared donut shell for any {key,label,color,value} breakdown -- used by Site
 * Audit's indexability/status-code/link-split charts and the Overview tab's
 * country/device breakdowns. Recharts' Pie animates its arc transitions by
 * default (no `isAnimationActive={false}` here), so live data updates redraw
 * smoothly instead of popping to the new shape. */
export function BreakdownDonut({
  title,
  centerUnitLabel,
  segments,
  values,
  styles,
}: {
  title: string;
  centerUnitLabel: string;
  segments: { key: string; label: string; color: string }[];
  values: Record<string, number>;
  styles: CssModule;
}) {
  const total = segments.reduce((sum, s) => sum + (values[s.key] || 0), 0);
  if (total === 0) return null;

  const slices = segments.map((seg) => ({ ...seg, value: values[seg.key] || 0 })).filter((s) => s.value > 0);

  return (
    <div className={`${styles.card} ${styles.seoAuditDonutCard}`}>
      <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
        {title}
      </h3>
      <div className={styles.seoAuditDonutWrap}>
        <div className="relative" style={{ width: 140, height: 140 }}>
          <ChartContainer height={140}>
            <PieChart>
              <Pie data={slices} dataKey="value" nameKey="label" innerRadius={50} outerRadius={70} startAngle={90} endAngle={-270} stroke="none" animationDuration={400}>
                {slices.map((s) => (
                  <Cell key={s.key} fill={s.color} />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltipContent formatter={(v) => Number(v).toLocaleString()} />} />
            </PieChart>
          </ChartContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-sans text-xl font-bold text-ink">{total.toLocaleString()}</span>
            <span className="font-sans text-[11px] text-ink-tertiary">{centerUnitLabel}</span>
          </div>
        </div>
        <ul className={styles.seoAuditDonutLegend}>
          {segments.filter((s) => (values[s.key] || 0) > 0).map((s) => (
            <li key={s.key}>
              <span className={styles.seoAuditDonutDot} style={{ background: s.color }} aria-hidden="true" />
              <span className={styles.seoAuditDonutLegendLabel}>{s.label}</span>
              <span className={styles.seoAuditDonutLegendValue}>{(values[s.key] || 0).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
