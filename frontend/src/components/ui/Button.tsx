import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger-outline";
export type ButtonSize = "default" | "sm";

/* border-0 on primary/ghost -- Preflight is off project-wide, so a variant with
   no intentional border needs to say so explicitly or the browser's native
   <button> border shows through underneath. secondary/danger-outline already
   declare their own border and don't need it. */
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "border-0 bg-accent text-white hover:bg-accent-hover",
  secondary: "bg-surface border border-border text-ink shadow-xs hover:border-border-strong hover:shadow-sm",
  ghost: "border-0 bg-transparent text-ink-secondary hover:bg-surface-sunken hover:text-ink",
  "danger-outline": "bg-surface border border-danger text-danger hover:bg-danger-tint",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  default: "text-sm px-3.5 py-2",
  sm: "text-xs px-2.5 py-1.5",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "default",
  icon,
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-sm font-sans font-semibold transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
