import { cn } from "./cn";

export type GaugeStatus = "success" | "warning" | "danger";

const STATUS_COLOR: Record<GaugeStatus, string> = {
  success: "#2E8B57",
  warning: "#B8770B",
  danger: "#C13B2D",
};

// Lighthouse-style thresholds: 0-49 danger, 50-89 warning, 90-100 success.
function statusForRatio(ratio: number): GaugeStatus {
  if (ratio >= 0.9) return "success";
  if (ratio >= 0.5) return "warning";
  return "danger";
}

export interface GaugeProps {
  value: number;
  max?: number;
  status?: GaugeStatus;
  size?: number;
  label?: string;
  className?: string;
}

const ZONES: Array<{ status: GaugeStatus; from: number; to: number }> = [
  { status: "danger", from: 0, to: 0.49 },
  { status: "warning", from: 0.49, to: 0.9 },
  { status: "success", from: 0.9, to: 1 },
];

export function Gauge({ value, max = 100, status, size = 128, label, className }: GaugeProps) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const resolvedStatus = status ?? statusForRatio(ratio);
  const strokeWidth = size * 0.09;
  const radius = size / 2 - strokeWidth;
  const circumference = 2 * Math.PI * radius;

  return (
    <div
      className={cn("relative inline-flex items-center justify-center", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${label ?? "Score"}: ${Math.round(value)} of ${max}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        {ZONES.map((zone) => {
          const zoneLength = (zone.to - zone.from) * circumference;
          const gapLength = circumference - zoneLength;
          const offset = -zone.from * circumference;
          return (
            <circle
              key={zone.status}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={STATUS_COLOR[zone.status]}
              strokeOpacity={0.14}
              strokeWidth={strokeWidth}
              strokeDasharray={`${zoneLength} ${gapLength}`}
              strokeDashoffset={offset}
            />
          );
        })}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={STATUS_COLOR[resolvedStatus]}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${ratio * circumference} ${circumference}`}
          className="transition-[stroke-dasharray] duration-500 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center font-sans">
        <span className="text-2xl font-bold text-ink">{Math.round(value)}</span>
        {label ? <span className="text-xs font-medium text-ink-tertiary">{label}</span> : null}
      </div>
    </div>
  );
}
