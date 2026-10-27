"use client";

import { TagSelect } from "@/components/TagSelect";

export type CategoryItem = { id: number; name: string };

/** WordPress categories as removable chips; the dropdown lists only categories not yet added. */
export function CategoryMultiSelect({
  categories,
  value,
  onChange,
  ariaLabel = "Categories",
}: {
  categories: CategoryItem[];
  value: number[];
  onChange: (ids: number[]) => void;
  ariaLabel?: string;
}) {
  return (
    <TagSelect
      options={categories.map((c) => ({ value: String(c.id), label: c.name }))}
      value={value.map(String)}
      onChange={(vals) => onChange(vals.map(Number).filter(Number.isFinite))}
      ariaLabel={ariaLabel}
      placeholder="Search categories…"
      emptyText="No categories found in WordPress."
    />
  );
}
