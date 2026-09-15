import type { ReactNode } from "react";

import { Card } from "./Card";
import { cn } from "./cn";

export interface EmptyStateCardProps {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyStateCard({ icon, title, description, action, className }: EmptyStateCardProps) {
  return (
    <Card className={cn("flex flex-col items-center gap-3 p-8 text-center", className)}>
      {icon ? (
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-sunken text-ink-secondary">
          {icon}
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <h3 className="font-sans text-md font-semibold text-ink">{title}</h3>
        <p className="max-w-sm font-sans text-sm text-ink-secondary">{description}</p>
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </Card>
  );
}
