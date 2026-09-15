"use client";

import type { ReactElement, ReactNode } from "react";
import { ResponsiveContainer } from "recharts";

import { cn } from "./cn";

/** Wraps a Recharts chart in a sized, responsive container using the app's font/tokens — the shadcn ChartContainer pattern, simplified to this repo's existing design tokens instead of shadcn's --chart-N CSS variable scheme. */
export function ChartContainer({
  children,
  className,
  height = 240,
}: {
  children: ReactElement;
  className?: string;
  height?: number | string;
}) {
  return (
    <div className={cn("w-full font-sans", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

interface TooltipPayloadEntry {
  name?: string;
  value?: number | string;
  color?: string;
  payload?: Record<string, unknown>;
}

export interface ChartTooltipContentProps {
  active?: boolean;
  label?: string | number;
  payload?: TooltipPayloadEntry[];
  formatter?: (value: number | string, name?: string) => ReactNode;
  labelFormatter?: (label: string | number) => ReactNode;
}

/** Recharts `<Tooltip content={<ChartTooltipContent />} />` — styled like the rest of ui/ (bg-surface card, border-border, shadow-md) instead of Recharts' default plain white box. */
export function ChartTooltipContent({ active, label, payload, formatter, labelFormatter }: ChartTooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 shadow-md font-sans text-xs">
      {label !== undefined ? (
        <div className="mb-1 font-semibold text-ink">{labelFormatter ? labelFormatter(label) : label}</div>
      ) : null}
      <div className="flex flex-col gap-1">
        {payload.map((entry, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: entry.color }} aria-hidden="true" />
            {entry.name ? <span className="text-ink-secondary">{entry.name}</span> : null}
            <span className="font-semibold text-ink">
              {entry.value !== undefined ? (formatter ? formatter(entry.value, entry.name) : entry.value) : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
