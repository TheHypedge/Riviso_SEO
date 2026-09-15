import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

import { cn } from "./cn";

export function DataTable({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLTableElement> & { children: ReactNode }) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-border">
      <table className={cn("w-full border-collapse font-sans text-sm", className)} {...rest}>
        {children}
      </table>
    </div>
  );
}

export function DataTableHead({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement> & { children: ReactNode }) {
  return (
    <thead className={cn("bg-surface-sunken", className)} {...rest}>
      {children}
    </thead>
  );
}

export function DataTableBody({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement> & { children: ReactNode }) {
  return (
    <tbody className={cn("divide-y divide-border", className)} {...rest}>
      {children}
    </tbody>
  );
}

export function DataTableRow({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { children: ReactNode }) {
  return (
    <tr className={cn("transition-colors duration-150 hover:bg-surface-sunken", className)} {...rest}>
      {children}
    </tr>
  );
}

export function DataTableHeaderCell({
  children,
  className,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <th
      className={cn(
        "px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-ink-secondary",
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function DataTableCell({
  children,
  className,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <td className={cn("px-4 py-3.5 align-middle text-ink", className)} {...rest}>
      {children}
    </td>
  );
}
