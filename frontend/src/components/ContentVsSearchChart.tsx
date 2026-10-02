"use client";

import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatChartAxisDate, formatChartTooltipDate } from "@/lib/articlesOverview";

export type ContentVsSearchPoint = {
  date: string;
  published: number;
  pending: number;
  draft: number;
  impressions: number;
  clicks: number;
};

type SeriesKey = "published" | "pending" | "draft" | "impressions" | "clicks";

const SERIES_META: { key: SeriesKey; label: string; color: string; axis: "content" | "search" }[] = [
  { key: "published", label: "Published", color: "var(--aa-primary)", axis: "content" },
  { key: "pending", label: "Pending", color: "var(--aa-muted)", axis: "content" },
  { key: "draft", label: "Draft", color: "var(--aa-muted-soft, var(--aa-muted))", axis: "content" },
  { key: "impressions", label: "Impressions", color: "var(--aa-warning)", axis: "search" },
  { key: "clicks", label: "Clicks", color: "var(--aa-info)", axis: "search" },
];

const SERIES_LABEL: Record<SeriesKey, string> = Object.fromEntries(
  SERIES_META.map((m) => [m.key, m.label]),
) as Record<SeriesKey, string>;

/** Content (Published/Pending/Draft, left axis -- small integers) vs Search Performance
 * (Impressions/Clicks, right axis -- much larger numbers) by day, each series its own
 * toggleable line. Checkbox legend mirrors ProjectActivityChart's existing pattern
 * (same `projectActivityToggle*` classes) for visual consistency, not a new UI. */
export function ContentVsSearchChart({
  series,
  styles,
}: {
  series: ContentVsSearchPoint[];
  styles: Record<string, string>;
}) {
  // Published + Clicks on by default -- same two series the chart originally showed
  // before the other three became available as opt-in toggles.
  const [visible, setVisible] = useState<Set<SeriesKey>>(() => new Set(["published", "clicks"]));

  function toggle(key: SeriesKey) {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size === 1) return prev; // keep at least one series visible
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  if (!series.length) return null;

  return (
    <div>
      <div className={styles.projectActivityToggleRow} role="group" aria-label="Toggle chart series">
        {SERIES_META.map((meta) => {
          const isOn = visible.has(meta.key);
          return (
            <button
              key={meta.key}
              type="button"
              className={styles.projectActivityToggle}
              aria-pressed={isOn}
              onClick={() => toggle(meta.key)}
            >
              <span
                className={`${styles.projectActivityToggleBox} ${isOn ? styles.projectActivityToggleBoxOn : ""}`}
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

      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--aa-hairline)" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(d: string) => formatChartAxisDate(d)}
            tick={{ fill: "var(--aa-muted)", fontSize: 11 }}
            axisLine={{ stroke: "var(--aa-hairline)" }}
            tickLine={false}
          />
          <YAxis
            yAxisId="content"
            allowDecimals={false}
            tick={{ fill: "var(--aa-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={28}
          />
          <YAxis
            yAxisId="search"
            orientation="right"
            allowDecimals={false}
            tick={{ fill: "var(--aa-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={44}
          />
          <Tooltip
            labelFormatter={(label) => (typeof label === "string" ? formatChartTooltipDate(label) : label)}
            formatter={(value, name) => [
              typeof value === "number" ? value.toLocaleString() : value,
              SERIES_LABEL[name as SeriesKey] || name,
            ]}
            contentStyle={{
              background: "var(--aa-surface-card)",
              border: "1px solid var(--aa-hairline)",
              borderRadius: 8,
              fontSize: 12,
              color: "var(--aa-ink)",
            }}
          />
          {SERIES_META.filter((meta) => visible.has(meta.key)).map((meta) => (
            <Line
              key={meta.key}
              yAxisId={meta.axis === "content" ? "content" : "search"}
              dataKey={meta.key}
              name={meta.key}
              stroke={meta.color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
