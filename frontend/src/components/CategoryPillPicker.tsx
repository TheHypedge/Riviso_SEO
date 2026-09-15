"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import editorStyles from "@/app/projects/[projectId]/articles/[articleId]/articleEditor.module.css";

export type PillCategory = { id: number; name: string };

type Props = {
  categories: PillCategory[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
  placeholder?: string;
};

/** Type-to-filter, click-to-add category picker: selected categories render as
 * removable pills, typing filters the remaining WordPress categories, matches
 * are clicked (or Enter) to add. Replaces a plain `<select multiple>` list. */
export function CategoryPillPicker({ categories, selectedIds, onChange, disabled, placeholder }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();

  const selected = useMemo(
    () => selectedIds.map((id) => categories.find((c) => c.id === id)).filter((c): c is PillCategory => !!c),
    [selectedIds, categories],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = categories.filter((c) => !selectedIds.includes(c.id));
    return (q ? pool.filter((c) => c.name.toLowerCase().includes(q)) : pool).slice(0, 30);
  }, [categories, selectedIds, query]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function addCategory(cat: PillCategory) {
    if (selectedIds.includes(cat.id)) return;
    onChange([...selectedIds, cat.id]);
    setQuery("");
    inputRef.current?.focus();
  }

  function removeCategory(id: number) {
    onChange(selectedIds.filter((x) => x !== id));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cat = matches[activeIndex];
      if (cat) addCategory(cat);
    } else if (e.key === "Backspace" && !query && selected.length) {
      removeCategory(selected[selected.length - 1].id);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className={editorStyles.categoryPicker} ref={rootRef}>
      <div
        className={editorStyles.categoryPickerField}
        onClick={() => {
          if (disabled) return;
          setOpen(true);
          inputRef.current?.focus();
        }}
      >
        {selected.map((c) => (
          <span key={c.id} className={editorStyles.categoryPill}>
            {c.name}
            {!disabled ? (
              <button
                type="button"
                className={editorStyles.categoryPillRemove}
                aria-label={`Remove ${c.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  removeCategory(c.id);
                }}
              >
                ×
              </button>
            ) : null}
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          className={editorStyles.categoryPickerInput}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onFocus={() => {
            setActiveIndex(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          placeholder={selected.length ? "" : placeholder || "Type to search categories…"}
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
        />
      </div>
      {open && !disabled ? (
        <div id={listboxId} className={editorStyles.categoryPickerDropdown} role="listbox">
          {matches.length ? (
            matches.map((c, i) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                className={`${editorStyles.categoryPickerOption} ${i === activeIndex ? editorStyles.categoryPickerOptionActive : ""}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => addCategory(c)}
              >
                {c.name}
              </button>
            ))
          ) : (
            <div className={editorStyles.categoryPickerEmpty}>
              {query.trim() ? "No matching category" : "All categories added"}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
