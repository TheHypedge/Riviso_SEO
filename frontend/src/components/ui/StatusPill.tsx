import { cn } from "./cn";

export type PillStatus = "published" | "scheduled" | "draft" | "warning" | "danger";

const STATUS_CLASSES: Record<PillStatus, string> = {
  published: "bg-success-tint text-success-strong",
  scheduled: "bg-info-tint text-info-strong",
  draft: "bg-surface-sunken text-ink-secondary",
  warning: "bg-warning-tint text-warning",
  danger: "bg-danger-tint text-danger",
};

const DOT_CLASSES: Record<PillStatus, string> = {
  published: "bg-success",
  scheduled: "bg-info",
  draft: "bg-ink-tertiary",
  warning: "bg-warning",
  danger: "bg-danger",
};

const DEFAULT_LABELS: Record<PillStatus, string> = {
  published: "Published",
  scheduled: "Scheduled",
  draft: "Draft",
  warning: "Warning",
  danger: "Danger",
};

export interface StatusPillProps {
  status: PillStatus;
  label?: string;
  className?: string;
}

export function StatusPill({ status, label, className }: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-sans text-xs font-bold",
        STATUS_CLASSES[status],
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASSES[status])} aria-hidden="true" />
      {label ?? DEFAULT_LABELS[status]}
    </span>
  );
}
