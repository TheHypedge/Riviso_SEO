import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "./cn";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  hoverLift?: boolean;
}

export function Card({ children, hoverLift = false, className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-surface shadow-xs font-sans",
        hoverLift && "transition-shadow duration-150 hover:shadow-sm",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
