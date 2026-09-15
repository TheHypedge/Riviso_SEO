import { cn } from "./cn";

export interface BarRowProps {
  label: string;
  value: number;
  max: number;
  color?: string;
  valueLabel?: string;
  className?: string;
}

export function BarRow({ label, value, max, color = "#E15A2C", valueLabel, className }: BarRowProps) {
  const fraction = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;

  return (
    <div className={cn("flex flex-col gap-1.5 font-sans", className)}>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-ink">{label}</span>
        <span className="font-mono text-xs text-ink-secondary">{valueLabel ?? value}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${fraction * 100}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}
