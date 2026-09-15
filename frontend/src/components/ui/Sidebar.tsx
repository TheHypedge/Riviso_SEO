import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "./cn";

export interface SidebarProps {
  children: ReactNode;
  className?: string;
}

export function Sidebar({ children, className }: SidebarProps) {
  return (
    <div className={cn("flex h-full w-full flex-col gap-6 font-sans", className)}>{children}</div>
  );
}

export interface NavGroupProps {
  label: string;
  children: ReactNode;
}

export function NavGroup({ label, children }: NavGroupProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className="px-3 font-heading text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
        {label}
      </span>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

/* border-0 -- Preflight is off project-wide (see tailwind.config.js), so native
   <button> UA chrome (grey border, grey background) is never reset by default.
   Without this every nav button shows the browser's own boxed-form-control look
   underneath the intended tint, active state included since nothing else ever
   touches border. */
const navItemBase =
  "flex w-full items-center gap-2.5 rounded-sm border-0 px-3 py-2 text-left text-sm font-medium transition-colors duration-150";

function navItemTone(active: boolean) {
  return active
    ? "bg-accent-tint text-accent-hover"
    : "bg-transparent text-ink hover:bg-surface-sunken";
}

/* Icon components in this codebase (ProjectTabIcon, DashboardNavIcon, ...) render a bare
   <svg> with no default width/height -- they size themselves entirely off a `className`
   prop that callers often don't pass. Sizing the slot here, with a child-selector, means
   every icon renders correctly regardless of whether the call site remembered to size it. */
const navIconSlot = "inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full";

export interface NavItemProps {
  label: string;
  icon?: ReactNode;
  active?: boolean;
  indent?: boolean;
  href?: string;
  onClick?: () => void;
}

/** Renders a <Link> when `href` is given, otherwise a <button> driving `onClick` — the
 * real app switches between tabs via client state, not route navigation, so button
 * mode is the common case; `href` exists for genuine cross-route items (dashboard link,
 * account card). */
export function NavItem({ label, icon, active = false, indent = false, href, onClick }: NavItemProps) {
  const className = cn(navItemBase, indent && "pl-8", navItemTone(active));
  const content = (
    <>
      {icon ? (
        <span className={navIconSlot} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {label}
    </>
  );

  if (href) {
    return (
      <Link href={href} aria-current={active ? "page" : undefined} className={className} onClick={onClick}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} aria-current={active ? "page" : undefined} className={className}>
      {content}
    </button>
  );
}

export interface SubNavChild {
  key: string;
  label: string;
  active?: boolean;
  onClick?: () => void;
}

export interface SubNavProps {
  label: string;
  icon?: ReactNode;
  active?: boolean;
  /** Whether the child list is shown. Controlled by the caller — in this app a Site
   * Audit-style parent's children are visible exactly when that tab is selected, not
   * an independently toggled expand/collapse state. */
  open: boolean;
  onSelect?: () => void;
  children: SubNavChild[];
}

export function SubNav({ label, icon, active = false, open, onSelect, children }: SubNavProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={open}
        className={cn(navItemBase, navItemTone(active))}
      >
        {icon ? (
          <span className={navIconSlot} aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className="flex-1">{label}</span>
        <span aria-hidden="true" className={cn("transition-transform duration-150", open && "rotate-90")}>
          {"›"}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-0.5">
          {children.map((child) => (
            <NavItem
              key={child.key}
              label={child.label}
              active={child.active}
              onClick={child.onClick}
              indent
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
