import { cn } from "./cn";

export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

export interface DonutChartProps {
  segments: DonutSegment[];
  centerLabel?: string;
  size?: number;
  className?: string;
}

export function DonutChart({ segments, centerLabel, size = 160, className }: DonutChartProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const strokeWidth = size * 0.16;
  const radius = size / 2 - strokeWidth / 2;
  const circumference = 2 * Math.PI * radius;

  let cursor = 0;

  return (
    <div className={cn("flex flex-col gap-4 font-sans sm:flex-row sm:items-center", className)}>
      <div className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="#F4F3F0"
            strokeWidth={strokeWidth}
          />
          {total > 0
            ? segments
                .filter((s) => s.value > 0)
                .map((segment) => {
                  const fraction = segment.value / total;
                  const segLength = fraction * circumference;
                  const offset = -cursor * circumference;
                  cursor += fraction;
                  return (
                    <circle
                      key={segment.label}
                      cx={size / 2}
                      cy={size / 2}
                      r={radius}
                      fill="none"
                      stroke={segment.color}
                      strokeWidth={strokeWidth}
                      strokeDasharray={`${segLength} ${circumference - segLength}`}
                      strokeDashoffset={offset}
                    />
                  );
                })
            : null}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold text-ink">{total}</span>
          {centerLabel ? (
            <span className="text-xs font-medium text-ink-tertiary">{centerLabel}</span>
          ) : null}
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        {segments.map((segment) => (
          <li key={segment.label} className="flex items-center gap-2 text-sm text-ink-secondary">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: segment.color }}
              aria-hidden="true"
            />
            <span className="text-ink">{segment.label}</span>
            <span className="font-mono text-xs text-ink-tertiary">{segment.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
