"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import s from "./tagSelect.module.css";

export type TagOption = { value: string; label: string; hint?: string };

type Props = {
  options: TagOption[];
  value: string[];
  onChange: (values: string[]) => void;
  ariaLabel: string;
  placeholder?: string;
  /** Lets the user add free text that isn't in `options` (Enter or the "Add" row). */
  allowCustom?: boolean;
  max?: number;
  emptyText?: string;
};

/**
 * Searchable multi-select that renders picks as removable chips. The dropdown only lists
 * options not yet picked, so a long catalogue (countries, tones, categories) never sprawls.
 */
export function TagSelect({
  options,
  value,
  onChange,
  ariaLabel,
  placeholder = "Search…",
  allowCustom = false,
  max,
  emptyText = "No options available.",
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const full = max !== undefined && value.length >= max;
  const q = query.trim();
  const available = useMemo(() => {
    const ql = q.toLowerCase();
    const open = options.filter((o) => !value.includes(o.value));
    if (!ql) return open;
    // Rank so Enter picks the obvious one: exact > starts-with > word-start > contains.
    const rank = (o: TagOption) => {
      const l = o.label.toLowerCase();
      if (l === ql || o.value.toLowerCase() === ql) return 0;
      if (l.startsWith(ql)) return 1;
      if (l.includes(` ${ql}`)) return 2;
      return l.includes(ql) ? 3 : 9;
    };
    return open
      .map((o) => ({ o, r: rank(o) }))
      .filter((x) => x.r < 9)
      .sort((a, b) => a.r - b.r)
      .map((x) => x.o);
  }, [options, value, q]);
  const canAddCustom =
    allowCustom &&
    !!q &&
    !value.some((v) => v.toLowerCase() === q.toLowerCase()) &&
    !options.some((o) => o.label.toLowerCase() === q.toLowerCase());
  // Row 0 is the "Add …" row when custom entry is possible.
  const rows = full ? [] : [...(canAddCustom ? [{ value: q, label: `Add “${q}”`, custom: true }] : []), ...available];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function add(v: string) {
    if (full || !v || value.includes(v)) return;
    // Focus never leaves the input: option rows preventDefault on mousedown.
    onChange([...value, v]);
    setQuery("");
    setActive(0);
  }

  function remove(v: string) {
    onChange(value.filter((x) => x !== v));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const row = open ? rows[active] : undefined;
      if (row) {
        e.preventDefault();
        add(row.value);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && !query && value.length) {
      remove(value[value.length - 1]);
    }
  }

  const activeId = open && rows[active] ? `${listId}-${active}` : undefined;

  return (
    <div className={s.root} ref={rootRef}>
      <div
        className={s.box}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            inputRef.current?.focus();
            setOpen(true);
          }
        }}
      >
        {value.map((v) => {
          const label = byValue.get(v)?.label ?? v;
          return (
            <span key={v} className={s.chip}>
              {label}
              <button
                type="button"
                className={s.chipX}
                onClick={(e) => {
                  remove(v);
                  // Keep keyboard focus in the field, but don't pop the list over the page.
                  e.currentTarget.closest(`.${s.box}`)?.querySelector("input")?.focus();
                  setOpen(false);
                }}
                aria-label={`Remove ${label}`}
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          className={s.input}
          value={query}
          placeholder={value.length ? (full ? "" : "Add more…") : placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
        />
        {max !== undefined ? (
          <span className={s.count} aria-live="polite">
            {value.length}/{max}
          </span>
        ) : null}
      </div>
      {open ? (
        <ul className={s.panel} id={listId} role="listbox" aria-label={ariaLabel} aria-multiselectable="true">
          {full ? (
            <li className={s.empty} role="presentation">
              Limit of {max} reached — remove one to add another.
            </li>
          ) : rows.length === 0 ? (
            <li className={s.empty} role="presentation">
              {options.length === 0 ? emptyText : q ? `No match for “${q}”.` : "Everything is already added."}
            </li>
          ) : (
            rows.map((o, i) => (
              <li
                key={`${"custom" in o ? "custom-" : ""}${o.value}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={false}
                className={s.option}
                data-active={i === active || undefined}
                data-custom={"custom" in o || undefined}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(o.value);
                }}
              >
                {o.label}
                {"hint" in o && o.hint ? <span className={s.hint}>{o.hint}</span> : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
