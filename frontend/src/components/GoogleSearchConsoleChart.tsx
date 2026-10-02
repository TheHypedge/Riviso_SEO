"use client";

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
import type { GscAnalyticsSeriesPoint } from "@/lib/api";

/** Clicks + impressions trend, straight from the GSC analytics series this tab already
 * fetches on mount. Separate from ContentVsSearchChart (which correlates publishing
 * activity against clicks) -- this one is GSC-only, no article data mixed in. */
export function GoogleSearchConsoleChart({ series }: { series: GscAnalyticsSeriesPoint[] }) {
  if (!series.length) return null;

  return (
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
          yAxisId="clicks"
          allowDecimals={false}
          tick={{ fill: "var(--aa-muted)", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={32}
        />
        <YAxis
          yAxisId="impressions"
          orientation="right"
          allowDecimals={false}
          tick={{ fill: "var(--aa-muted)", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={40}
        />
        <Tooltip
          labelFormatter={(label) => (typeof label === "string" ? formatChartTooltipDate(label) : label)}
          formatter={(value, name) => [
            typeof value === "number" ? value.toLocaleString() : value,
            name === "clicks" ? "Clicks" : "Impressions",
          ]}
          contentStyle={{
            background: "var(--aa-surface-card)",
            border: "1px solid var(--aa-hairline)",
            borderRadius: 8,
            fontSize: 12,
            color: "var(--aa-ink)",
          }}
        />
        <Line
          yAxisId="clicks"
          dataKey="clicks"
          name="clicks"
          stroke="var(--aa-info)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
        <Line
          yAxisId="impressions"
          dataKey="impressions"
          name="impressions"
          stroke="var(--aa-muted)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          dot={false}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
