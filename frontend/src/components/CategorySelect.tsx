"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./CategorySelect.module.css";

export interface CategoryOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: CategoryOption[];
  onChange: (value: string) => void;
  isDirty?: boolean;
  ariaLabel?: string;
}

const UNCATEGORIZED: CategoryOption = { value: "", label: "Uncategorized" };
// Matches the CSS max-height so flip-up logic is accurate
const PANEL_MAX_H = 320;
const PANEL_MIN_W = 224;

export function CategorySelect({ value, options, onChange, isDirty, ariaLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const filteredOpts: CategoryOption[] = search.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  // Uncategorized is always first and not filtered by search
  const visibleOptions: CategoryOption[] = [UNCATEGORIZED, ...filteredOpts];

  const selectedLabel =
    ([UNCATEGORIZED, ...options].find((o) => o.value === value) ?? UNCATEGORIZED).label;

  // ── Positioning ────────────────────────────────────────────────────────────

  function recalcPos() {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const top =
      spaceBelow >= 120
        ? rect.bottom + 4
        : Math.max(8, rect.top - PANEL_MAX_H - 4);
    setPanelStyle({ top, left: rect.left, width: Math.max(rect.width, PANEL_MIN_W) });
  }

  // ── Open / close ───────────────────────────────────────────────────────────

  function openPanel() {
    recalcPos();
    setSearch("");
    setActiveIdx(Math.max(0, visibleOptions.findIndex((o) => o.value === value)));
    setOpen(true);
  }

  function closePanel(returnFocus = true) {
    setOpen(false);
    setSearch("");
    if (returnFocus) triggerRef.current?.focus();
  }

  function commitOption(opt: CategoryOption) {
    onChange(opt.value);
    closePanel(true);
  }

  // ── Effects ────────────────────────────────────────────────────────────────

  // Auto-focus search input when panel opens
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => searchRef.current?.focus(), 10);
    return () => clearTimeout(id);
  }, [open]);

  // Close when clicking outside the trigger + panel
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (
        !triggerRef.current?.contains(e.target as Node) &&
        !panelRef.current?.contains(e.target as Node)
      ) {
        closePanel(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Reposition when the page scrolls or resizes
  useEffect(() => {
    if (!open) return;
    function update() { recalcPos(); }
    window.addEventListener("scroll", update, { capture: true, passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, { capture: true });
      window.removeEventListener("resize", update);
    };
  }, [open]);

  // Scroll the highlighted option into view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  // Clamp activeIdx when search narrows the list
  useEffect(() => {
    setActiveIdx((i) => Math.min(i, Math.max(0, visibleOptions.length - 1)));
  }, [visibleOptions.length]);

  // ── Keyboard handling ──────────────────────────────────────────────────────

  function handleTriggerKeyDown(e: React.KeyboardEvent) {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      openPanel();
    }
  }

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, visibleOptions.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (visibleOptions[activeIdx]) commitOption(visibleOptions[activeIdx]);
        break;
      case "Escape":
        e.preventDefault();
        closePanel(true);
        break;
      case "Tab":
        closePanel(false);
        break;
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={styles.root}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        className={`${styles.trigger}${isDirty ? ` ${styles.triggerDirty}` : ""}`}
        onClick={() => (open ? closePanel(true) : openPanel())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className={styles.triggerLabel}>{selectedLabel}</span>
        <svg
          className={`${styles.chevron}${open ? ` ${styles.chevronOpen}` : ""}`}
          width="10"
          height="6"
          viewBox="0 0 10 6"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M1 1l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* Floating panel — position:fixed so it escapes any overflow/clip ancestors */}
      {open && (
        <div
          ref={panelRef}
          className={styles.panel}
          style={panelStyle}
        >
          {/* Search */}
          <div className={styles.searchWrap}>
            <svg
              className={styles.searchIcon}
              width="13"
              height="13"
              viewBox="0 0 13 13"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.4" />
              <path
                d="M8.75 8.75L11.25 11.25"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setActiveIdx(0);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search categories…"
              className={styles.searchInput}
              aria-label="Search categories"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {/* Options list */}
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel ?? "Categories"}
            className={styles.listbox}
          >
            {visibleOptions.map((opt, i) => {
              const isSelected = opt.value === value;
              const isActive = i === activeIdx;
              return (
                <li
                  key={opt.value === "" ? "__unc__" : opt.value}
                  role="option"
                  aria-selected={isSelected}
                  className={[
                    styles.option,
                    isActive ? styles.optionActive : "",
                    isSelected ? styles.optionSelected : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  // preventDefault keeps focus on the search input
                  onMouseDown={(e) => { e.preventDefault(); commitOption(opt); }}
                  onMouseEnter={() => setActiveIdx(i)}
                >
                  <span className={styles.optionLabel}>{opt.label}</span>
                  {isSelected && (
                    <svg
                      className={styles.optionCheck}
                      width="12"
                      height="9"
                      viewBox="0 0 12 9"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M1 4.5L4.5 8L11 1"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </li>
              );
            })}
            {filteredOpts.length === 0 && search.trim() && (
              <li className={styles.empty} role="presentation">
                No categories found
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
