import type { ReactNode } from "react";

import { Card } from "./Card";
import { cn } from "./cn";

export interface StatCardProps {
  value: ReactNode;
  label: string;
  sublabel?: string;
  hero?: boolean;
  className?: string;
  valueClassName?: string;
}

export function StatCard({ value, label, sublabel, hero = false, className, valueClassName }: StatCardProps) {
  return (
    <Card
      className={cn(
        "flex flex-col gap-1 p-5",
        hero && "border-accent-tint-border bg-accent-tint",
        className,
      )}
    >
      <span
        className={cn(
          "font-sans text-3xl font-bold leading-none",
          hero ? "text-accent-hover" : "text-ink",
          valueClassName,
        )}
      >
        {value}
      </span>
      <span className="font-sans text-sm font-medium text-ink-secondary">{label}</span>
      {sublabel ? <span className="font-sans text-xs text-ink-tertiary">{sublabel}</span> : null}
    </Card>
  );
}
