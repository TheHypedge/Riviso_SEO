"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ArticlesOverviewChart } from "@/components/ArticlesOverviewChart";
import { api } from "@/lib/api";
import type {
  ProjectSummary,
  WorkspaceActivityDay,
  WorkspaceFeedItem,
  WorkspaceFilteredStats,
  WorkspaceOverviewResponse,
} from "@/lib/api";
import { articleEditorPath } from "@/lib/articlePaths";

import s from "./ProjectOverviewDashboard.module.css";

// ── Types ─────────────────────────────────────────────────────────────────────
type DatePreset =
  | "today" | "yesterday" | "7d" | "14d" | "30d" | "90d"
  | "this_month" | "last_month" | "this_quarter" | "last_quarter"
  | "this_year" | "custom";

interface DashboardFilters {
  preset: DatePreset;
  startDate: string;
  endDate: string;
  projectIds: string[];
}

type Granularity = "daily" | "weekly" | "monthly";
type SortKey = "published" | "active" | "pending" | "drafts" | "updated";
type FeedFilter = "all" | "published" | "pending" | "draft" | "scheduled";

const FILTER_STORAGE_KEY = "rvs_overview_filters";

// ── Date helpers ──────────────────────────────────────────────────────────────
function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

function startOfUTC(d: Date, unit: "month" | "quarter" | "year"): Date {
  const r = new Date(d);
  if (unit === "month") {
    r.setUTCDate(1);
  } else if (unit === "quarter") {
    r.setUTCMonth(Math.floor(r.getUTCMonth() / 3) * 3, 1);
  } else {
    r.setUTCMonth(0, 1);
  }
  return r;
}

function todayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

interface PresetMeta { start: string; end: string; label: string }

function getPresetMeta(preset: DatePreset): PresetMeta {
  const today = todayUTC();
  const yest = addDays(today, -1);

  switch (preset) {
    case "today":       return { start: fmt(today), end: fmt(today), label: "Today" };
    case "yesterday":   return { start: fmt(yest), end: fmt(yest), label: "Yesterday" };
    case "7d":          return { start: fmt(addDays(today, -6)), end: fmt(today), label: "Last 7 days" };
    case "14d":         return { start: fmt(addDays(today, -13)), end: fmt(today), label: "Last 14 days" };
    case "30d":         return { start: fmt(addDays(today, -29)), end: fmt(today), label: "Last 30 days" };
    case "90d":         return { start: fmt(addDays(today, -89)), end: fmt(today), label: "Last 90 days" };
    case "this_month":  return { start: fmt(startOfUTC(today, "month")), end: fmt(today), label: "This month" };
    case "last_month": {
      const som = startOfUTC(today, "month");
      const eom = addDays(som, -1);
      return { start: fmt(startOfUTC(eom, "month")), end: fmt(eom), label: "Last month" };
    }
    case "this_quarter":  return { start: fmt(startOfUTC(today, "quarter")), end: fmt(today), label: "This quarter" };
    case "last_quarter": {
      const soq = startOfUTC(today, "quarter");
      const eoq = addDays(soq, -1);
      return { start: fmt(startOfUTC(eoq, "quarter")), end: fmt(eoq), label: "Last quarter" };
    }
    case "this_year":   return { start: fmt(startOfUTC(today, "year")), end: fmt(today), label: "This year" };
    default:            return { start: fmt(addDays(today, -29)), end: fmt(today), label: "Custom range" };
  }
}

function defaultFilters(): DashboardFilters {
  const meta = getPresetMeta("14d");
  return { preset: "14d", startDate: meta.start, endDate: meta.end, projectIds: [] };
}

function loadFilters(): DashboardFilters {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return defaultFilters();
    const saved = JSON.parse(raw) as Partial<DashboardFilters>;
    if (!saved.preset || !saved.startDate || !saved.endDate) return defaultFilters();
    // Recompute preset dates so relative presets stay current
    if (saved.preset !== "custom") {
      const meta = getPresetMeta(saved.preset);
      return { preset: saved.preset, startDate: meta.start, endDate: meta.end, projectIds: saved.projectIds ?? [] };
    }
    return { ...defaultFilters(), ...saved } as DashboardFilters;
  } catch { return defaultFilters(); }
}

function saveFilters(f: DashboardFilters) {
  try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(f)); } catch { /* noop */ }
}

function fmtShort(iso: string): string {
  try {
    return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  } catch { return iso; }
}

function fmtRangeLabel(f: DashboardFilters): string {
  if (f.preset === "custom") return `${fmtShort(f.startDate)} – ${fmtShort(f.endDate)}`;
  return getPresetMeta(f.preset).label;
}

function fmtCompareLabel(s: WorkspaceFilteredStats): string {
  if (!s.period_start || !s.period_end) return "vs. previous period";
  return `vs. ${fmtShort(s.period_start)} – ${fmtShort(s.period_end)}`;
}

// ── Delta helpers ─────────────────────────────────────────────────────────────
interface Delta { pct: number | null; label: string; positive: boolean; isNew: boolean }

function computeDelta(current: number, previous: number): Delta {
  if (previous === 0) {
    if (current === 0) return { pct: null, label: "—", positive: true, isNew: false };
    return { pct: null, label: "New", positive: true, isNew: true };
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  return { pct, label: pct > 0 ? `+${pct}%` : `${pct}%`, positive: pct >= 0, isNew: false };
}

// ── Relative time ─────────────────────────────────────────────────────────────
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const ms = Date.parse(iso.includes("T") ? iso : `${iso}T00:00:00Z`);
    if (!ms) return "—";
    const diff = (Date.now() - ms) / 1000;
    if (diff < 60) return "Just now";
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
    if (diff < 86400 * 30) return `${Math.round(diff / 86400)}d ago`;
    return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch { return "—"; }
}

function fmtSchedule(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso.includes("T") ? iso : `${iso}T00:00:00Z`);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return "—"; }
}

// ── Chart aggregation ─────────────────────────────────────────────────────────
function aggregateSeries(
  series: WorkspaceActivityDay[],
  gran: Granularity,
  hidden: Set<string>,
): WorkspaceActivityDay[] {
  const mask = (k: string, v: number) => (hidden.has(k) ? 0 : v);

  if (gran === "daily") {
    return series.map((d) => ({
      date: d.date,
      published: mask("published", d.published),
      pending: mask("pending", d.pending),
      scheduled: mask("scheduled", d.scheduled),
    }));
  }

  const buckets = new Map<string, WorkspaceActivityDay>();
  for (const day of series) {
    const d = new Date(day.date + "T00:00:00Z");
    let key: string;
    if (gran === "weekly") {
      const dow = d.getUTCDay();
      const monday = new Date(d);
      monday.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
      key = monday.toISOString().slice(0, 10);
    } else {
      key = day.date.slice(0, 7) + "-01";
    }
    const ex = buckets.get(key) ?? { date: key, published: 0, pending: 0, scheduled: 0 };
    ex.published += mask("published", day.published);
    ex.pending += mask("pending", day.pending);
    ex.scheduled += mask("scheduled", day.scheduled);
    buckets.set(key, ex);
  }
  return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ── Sorting helpers ───────────────────────────────────────────────────────────
function sortProjects(list: ProjectSummary[], key: SortKey): ProjectSummary[] {
  return [...list].sort((a, b) => {
    switch (key) {
      case "published": return b.published - a.published;
      case "pending":   return b.pending - a.pending;
      case "drafts":    return b.draft - a.draft;
      case "updated":   return (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "");
      case "active": {
        const scoreA = a.published + a.upcoming_scheduled * 0.5 + a.pending * 0.2;
        const scoreB = b.published + b.upcoming_scheduled * 0.5 + b.pending * 0.2;
        return scoreB - scoreA;
      }
      default: return 0;
    }
  });
}

// ── Inline SVG icons ──────────────────────────────────────────────────────────
function IcoFolder()   { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M1 3.5h4.5l1.5 1.5H15v8.5a.5.5 0 01-.5.5h-13A.5.5 0 011 13.5V3.5z" strokeLinejoin="round"/></svg>; }
function IcoCheck()    { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M5 8l2 2 4-4" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function IcoCal()      { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="12" rx="1.5" strokeLinejoin="round"/><path d="M1.5 6.5h13M5 1.5v2M11 1.5v2" strokeLinecap="round"/></svg>; }
function IcoFile()     { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 1.5h7l3 3V14a.5.5 0 01-.5.5h-9A.5.5 0 013 14V1.5z" strokeLinejoin="round"/><path d="M10 1.5V5h3" strokeLinejoin="round"/></svg>; }
function IcoClock()    { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function IcoLayers()   { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M8 1L15 5l-7 4-7-4 7-4zM1 10l7 4 7-4M1 7.5l7 4 7-4" strokeLinejoin="round" strokeLinecap="round"/></svg>; }
function IcoChevron()  { return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>; }
function IcoRefresh()  { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1.5 7a5.5 5.5 0 1010.5-2.5"/><path d="M12 2l.5 2.5H10"/></svg>; }
function IcoSearch()   { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.5"/><path d="M9.5 9.5l3 3"/></svg>; }
function IcoArrowUp()  { return <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 8.5V1.5M2 4l3-3 3 3"/></svg>; }
function IcoArrowDn()  { return <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 1.5v7M2 6l3 3 3-3"/></svg>; }
function IcoPen()      { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 1.5l3 3-8 8H1.5v-3l8-8z"/></svg>; }
function IcoPlus()     { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M7 1.5v11M1.5 7h11"/></svg>; }
function IcoUsers()    { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="5" cy="4.5" r="2.5"/><path d="M1 12.5c0-2.2 1.8-4 4-4s4 1.8 4 4"/><path d="M9.5 2a2.5 2.5 0 010 5M13 12.5c0-2.2-1.3-3.7-2.5-4"/></svg>; }
function IcoLink()     { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5.5 8.5a3.5 3.5 0 005 0l2-2a3.5 3.5 0 00-5-5L6 3"/><path d="M8.5 5.5a3.5 3.5 0 00-5 0l-2 2a3.5 3.5 0 005 5L8 11"/></svg>; }

// ── Date range picker ─────────────────────────────────────────────────────────
const PRESETS: { key: DatePreset; label: string }[] = [
  { key: "today",        label: "Today" },
  { key: "yesterday",    label: "Yesterday" },
  { key: "7d",           label: "Last 7 days" },
  { key: "14d",          label: "Last 14 days" },
  { key: "30d",          label: "Last 30 days" },
  { key: "90d",          label: "Last 90 days" },
  { key: "this_month",   label: "This month" },
  { key: "last_month",   label: "Last month" },
  { key: "this_quarter", label: "This quarter" },
  { key: "last_quarter", label: "Last quarter" },
  { key: "this_year",    label: "This year" },
  { key: "custom",       label: "Custom range" },
];

function DateRangePicker({
  filters,
  onChange,
  onClose,
}: {
  filters: DashboardFilters;
  onChange: (f: DashboardFilters) => void;
  onClose: () => void;
}) {
  const [customStart, setCustomStart] = useState(filters.startDate);
  const [customEnd, setCustomEnd]     = useState(filters.endDate);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [onClose]);

  const selectPreset = (preset: DatePreset) => {
    if (preset === "custom") {
      onChange({ ...filters, preset: "custom", startDate: customStart, endDate: customEnd });
    } else {
      const meta = getPresetMeta(preset);
      onChange({ ...filters, preset, startDate: meta.start, endDate: meta.end });
      onClose();
    }
  };

  const applyCustom = () => {
    if (customStart && customEnd && customStart <= customEnd) {
      onChange({ ...filters, preset: "custom", startDate: customStart, endDate: customEnd });
      onClose();
    }
  };

  return (
    <div ref={ref} className={s.datePickerPopover}>
      <div className={s.datePickerPresets}>
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`${s.datePresetBtn} ${filters.preset === p.key ? s.datePresetBtnActive : ""}`}
            onClick={() => selectPreset(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className={s.datePickerCustom}>
        <p className={s.datePickerCustomLabel}>Custom range</p>
        <div className={s.datePickerCustomRow}>
          <div className={s.dateInputGroup}>
            <label htmlFor="dp-start" className={s.dateInputLabel}>Start</label>
            <input
              id="dp-start"
              type="date"
              className={s.dateInput}
              value={customStart}
              onChange={(e) => { setCustomStart(e.target.value); }}
              max={customEnd || undefined}
            />
          </div>
          <span className={s.datePickerDash}>→</span>
          <div className={s.dateInputGroup}>
            <label htmlFor="dp-end" className={s.dateInputLabel}>End</label>
            <input
              id="dp-end"
              type="date"
              className={s.dateInput}
              value={customEnd}
              onChange={(e) => { setCustomEnd(e.target.value); }}
              min={customStart || undefined}
            />
          </div>
        </div>
        <button
          type="button"
          className={s.dateApplyBtn}
          disabled={!customStart || !customEnd || customStart > customEnd}
          onClick={applyCustom}
        >
          Apply range
        </button>
      </div>
    </div>
  );
}

// ── Project filter dropdown ───────────────────────────────────────────────────
function ProjectFilterDropdown({
  projects,
  selectedIds,
  onChange,
  onClose,
}: {
  projects: ProjectSummary[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [onClose]);

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  const allSelected = selectedIds.length === 0;

  return (
    <div ref={ref} className={s.projFilterPopover}>
      <div className={s.projFilterHeader}>
        <span className={s.projFilterTitle}>Filter by project</span>
        {selectedIds.length > 0 && (
          <button type="button" className={s.projFilterClear} onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </div>
      <div className={s.projFilterList}>
        <label className={`${s.projFilterRow} ${allSelected ? s.projFilterRowActive : ""}`}>
          <input
            type="checkbox"
            className={s.projFilterCheck}
            checked={allSelected}
            onChange={() => onChange([])}
            readOnly={allSelected}
          />
          <span className={s.projFilterName}>All projects</span>
          <span className={s.projFilterCount}>{projects.reduce((a, p) => a + p.total_articles, 0)}</span>
        </label>
        {projects.map((p) => {
          const checked = selectedIds.includes(p.project_id);
          return (
            <label
              key={p.project_id}
              className={`${s.projFilterRow} ${checked ? s.projFilterRowActive : ""}`}
            >
              <input
                type="checkbox"
                className={s.projFilterCheck}
                checked={checked}
                onChange={() => toggle(p.project_id)}
              />
              <span className={s.projFilterName} title={p.name}>{p.name}</span>
              <span className={s.projFilterCount}>{p.total_articles}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ── KPI card ──────────────────────────────────────────────────────────────────
const DONUT_COLORS: Record<string, string> = {
  published: "#5db872",
  scheduled: "#d4a017",
  draft:     "#7090c8",
  pending:   "#d97757",
};

function KpiCard({
  icon,
  label,
  value,
  current,
  previous,
  compareLabel,
  accentVar,
  noCompare,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  current?: number;
  previous?: number;
  compareLabel?: string;
  accentVar: string;
  noCompare?: boolean;
}) {
  const delta = useMemo<Delta | null>(() => {
    if (noCompare || current === undefined || previous === undefined) return null;
    return computeDelta(current, previous);
  }, [current, previous, noCompare]);

  return (
    <div className={s.kpiCard} style={{ "--kpi-accent": accentVar } as React.CSSProperties}>
      <div className={s.kpiTop}>
        <div className={s.kpiIcon}>{icon}</div>
        {delta && (
          <span className={`${s.kpiDelta} ${delta.isNew ? s.kpiDeltaNew : delta.positive ? s.kpiDeltaPos : s.kpiDeltaNeg}`}>
            {!delta.isNew && (
              <span className={s.kpiArrow}>{delta.positive ? <IcoArrowUp /> : <IcoArrowDn />}</span>
            )}
            {delta.label}
          </span>
        )}
      </div>
      <div className={s.kpiValue}>{value.toLocaleString()}</div>
      <div className={s.kpiLabel}>{label}</div>
      {delta && compareLabel && (
        <div className={s.kpiCompare}>{compareLabel}</div>
      )}
    </div>
  );
}

// ── Donut chart ───────────────────────────────────────────────────────────────
function DonutChart({
  published, scheduled, draft, pending, onSegmentClick,
}: {
  published: number; scheduled: number; draft: number; pending: number;
  onSegmentClick?: (key: string) => void;
}) {
  const segments = useMemo(() => {
    const items = [
      { key: "published", value: published },
      { key: "scheduled", value: scheduled },
      { key: "draft",     value: draft },
      { key: "pending",   value: pending },
    ];
    const total = Math.max(1, items.reduce((acc, i) => acc + i.value, 0));
    let offset = 0;
    return items.map((item) => {
      const pct = item.value / total;
      const seg = { ...item, pct, pctDisplay: Math.round(pct * 100), offset, total };
      offset += pct;
      return seg;
    });
  }, [published, scheduled, draft, pending]);

  const total = published + scheduled + draft + pending;
  const r = 52;
  const circ = 2 * Math.PI * r;
  const cx = 70;
  const cy = 70;
  const gap = 0.012;

  const LABELS: Record<string, string> = {
    published: "Published", scheduled: "Scheduled", draft: "Drafts", pending: "Pending",
  };

  return (
    <div className={s.donutWrap}>
      <div className={s.donutSvgWrap}>
        <svg width="140" height="140" viewBox="0 0 140 140" aria-hidden="true">
          {total === 0 ? (
            <circle cx={cx} cy={cy} r={r} fill="none" strokeWidth="14" stroke="rgba(255,255,255,0.07)" />
          ) : (
            segments.map((seg) => {
              const dashLen = Math.max(0, seg.pct * circ - gap * circ);
              const dashOff = -seg.offset * circ;
              return (
                <circle
                  key={seg.key}
                  cx={cx} cy={cy} r={r}
                  fill="none" strokeWidth="14"
                  stroke={DONUT_COLORS[seg.key]}
                  strokeDasharray={`${dashLen} ${circ}`}
                  strokeDashoffset={dashOff}
                  strokeLinecap="butt"
                  transform={`rotate(-90 ${cx} ${cy})`}
                  className={onSegmentClick ? s.donutSegmentClickable : ""}
                  onClick={() => onSegmentClick?.(seg.key)}
                  style={{ cursor: onSegmentClick ? "pointer" : undefined }}
                />
              );
            })
          )}
        </svg>
        <div className={s.donutCenter}>
          <span className={s.donutNum}>{total.toLocaleString()}</span>
          <span className={s.donutLbl}>Articles</span>
        </div>
      </div>

      <div className={s.donutLegend}>
        {segments.map((seg) => (
          <div key={seg.key} className={s.donutRow}>
            <span className={s.donutDot} style={{ background: DONUT_COLORS[seg.key] }} />
            <span className={s.donutRowLabel}>{LABELS[seg.key]}</span>
            <span className={s.donutRowCount}>{seg.value.toLocaleString()}</span>
            <span className={s.donutRowPct}>{seg.total > 0 ? `${seg.pctDisplay}%` : "0%"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Feed item ─────────────────────────────────────────────────────────────────
const STATUS_LABELS: Record<string, string> = {
  published: "Published", scheduled: "Scheduled", pending: "Pending", draft: "Draft",
};

function FeedItem({ item }: { item: WorkspaceFeedItem }) {
  const href = articleEditorPath(item.project_id, item.article_id);
  const when = item.status_tag === "scheduled"
    ? fmtSchedule(item.sort_at)
    : relativeTime(item.sort_at);

  return (
    <div className={s.feedItem}>
      <span
        className={s.feedDot}
        style={{ background: DONUT_COLORS[item.status_tag] ?? "rgba(255,255,255,0.3)" }}
        aria-label={STATUS_LABELS[item.status_tag] ?? item.status_tag}
      />
      <div className={s.feedBody}>
        {href ? (
          <Link href={href} className={s.feedTitle} title={item.title}>{item.title}</Link>
        ) : (
          <span className={s.feedTitle}>{item.title}</span>
        )}
        <div className={s.feedMeta}>
          <span className={s.feedProject}>{item.project_name}</span>
          <span className={s.feedWhen}>{when}</span>
        </div>
      </div>
      {href && (
        <Link href={href} className={s.feedAction} aria-label="Open article">
          <IcoLink />
        </Link>
      )}
    </div>
  );
}

// ── Project card ──────────────────────────────────────────────────────────────
function ProjectCard({
  proj,
  onClick,
  isSelected,
}: {
  proj: ProjectSummary;
  onClick: (id: string) => void;
  isSelected: boolean;
}) {
  const domain = useMemo(() => {
    try {
      const raw = proj.website_url?.startsWith("http") ? proj.website_url : `https://${proj.website_url ?? ""}`;
      return new URL(raw).hostname.replace(/^www\./, "");
    } catch { return proj.website_url ?? ""; }
  }, [proj.website_url]);

  const pubPct = proj.total_articles > 0
    ? Math.round((proj.published / proj.total_articles) * 100)
    : 0;

  return (
    <div
      className={`${s.projCard} ${isSelected ? s.projCardSelected : ""}`}
      onClick={() => onClick(proj.project_id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(proj.project_id); }}
      aria-pressed={isSelected}
      title={`Filter to ${proj.name}`}
    >
      <div className={s.projCardHead}>
        <div className={s.projCardMeta}>
          <span className={s.projCardName}>{proj.name}</span>
          {domain && <span className={s.projCardDomain}>{domain}</span>}
        </div>
        {proj.platform && (
          <span className={s.projCardBadge}>
            {proj.platform === "shopify" ? "Shopify" : "WP"}
          </span>
        )}
      </div>

      <div className={s.projCardStats}>
        <div className={s.projStatItem}>
          <span className={s.projStatVal} style={{ color: DONUT_COLORS.published }}>{proj.published}</span>
          <span className={s.projStatLbl}>Published</span>
        </div>
        <div className={s.projStatItem}>
          <span className={s.projStatVal} style={{ color: DONUT_COLORS.scheduled }}>{proj.upcoming_scheduled}</span>
          <span className={s.projStatLbl}>Scheduled</span>
        </div>
        <div className={s.projStatItem}>
          <span className={s.projStatVal} style={{ color: DONUT_COLORS.pending }}>{proj.pending}</span>
          <span className={s.projStatLbl}>Pending</span>
        </div>
        <div className={s.projStatItem}>
          <span className={s.projStatVal} style={{ color: DONUT_COLORS.draft }}>{proj.draft}</span>
          <span className={s.projStatLbl}>Drafts</span>
        </div>
      </div>

      <div className={s.projCardProgress}>
        <div className={s.projProgressBar}>
          <div
            className={s.projProgressFill}
            style={{ width: `${pubPct}%` }}
            aria-label={`${pubPct}% published`}
          />
        </div>
        <span className={s.projProgressPct}>{pubPct}% published</span>
      </div>

      <div className={s.projCardFoot}>
        <span className={s.projCardActivity}>
          {relativeTime(proj.last_activity_at)}
        </span>
        <Link
          href={`/projects/${proj.project_id}`}
          className={s.projCardOpen}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Open ${proj.name}`}
        >
          Open →
        </Link>
      </div>
    </div>
  );
}

// ── Quick actions ─────────────────────────────────────────────────────────────
function QuickActions({ onGoProjects }: { onGoProjects?: () => void }) {
  return (
    <div className={s.quickActions}>
      <span className={s.quickLabel}>Quick actions</span>
      <div className={s.quickBtns}>
        <button type="button" className={s.quickBtn} onClick={onGoProjects}>
          <IcoPlus /><span>New project</span>
        </button>
        <button type="button" className={s.quickBtn} onClick={onGoProjects}>
          <IcoPen /><span>Generate content</span>
        </button>
        <button type="button" className={s.quickBtn} onClick={onGoProjects}>
          <IcoCal /><span>View schedule</span>
        </button>
        <button type="button" className={s.quickBtn} onClick={onGoProjects}>
          <IcoFile /><span>Browse articles</span>
        </button>
        <button type="button" className={s.quickBtn} onClick={onGoProjects}>
          <IcoUsers /><span>Invite member</span>
        </button>
      </div>
    </div>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────
function DashboardSkeleton() {
  return (
    <div className={s.shell}>
      <div className={s.skelRow}>
        {[...Array(6)].map((_, i) => <div key={i} className={s.skelCard} />)}
      </div>
      <div className={s.skelCharts}>
        <div className={s.skelChartBig} /><div className={s.skelChartSm} />
      </div>
      <div className={s.skelProjects}>
        {[...Array(4)].map((_, i) => <div key={i} className={s.skelProject} />)}
      </div>
    </div>
  );
}

// ── Insights builder ──────────────────────────────────────────────────────────
function buildInsights(data: WorkspaceOverviewResponse, compareLabel: string): string[] {
  const out: string[] = [];
  const { stats, filtered_stats, comparison_stats, project_summaries = [] } = data;

  if (filtered_stats && comparison_stats) {
    const pubDelta = filtered_stats.published - comparison_stats.published;
    if (pubDelta > 0) out.push(`Publishing increased by ${pubDelta} article${pubDelta === 1 ? "" : "s"} ${compareLabel}.`);
    else if (pubDelta < 0) out.push(`Publishing decreased by ${Math.abs(pubDelta)} article${Math.abs(pubDelta) === 1 ? "" : "s"} ${compareLabel}.`);
  }

  const mostPub = [...project_summaries].sort((a, b) => b.published - a.published)[0];
  if (mostPub && mostPub.published > 0) {
    out.push(`${mostPub.name} leads with ${mostPub.published} published article${mostPub.published === 1 ? "" : "s"}.`);
  }

  const noSchedule = project_summaries.filter((p) => p.upcoming_scheduled === 0 && p.total_articles > 0);
  if (noSchedule.length > 0) {
    out.push(`${noSchedule.length} project${noSchedule.length === 1 ? " has" : "s have"} no upcoming scheduled content.`);
  }

  if (filtered_stats && filtered_stats.pending > 0) {
    out.push(`${filtered_stats.pending} article${filtered_stats.pending === 1 ? "" : "s"} created in this period ${filtered_stats.pending === 1 ? "is" : "are"} still pending.`);
  }

  if (stats.total_articles > 0 && stats.published > 0) {
    const rate = Math.round((stats.published / stats.total_articles) * 100);
    out.push(`${rate}% of your total content library is published.`);
  }

  if (out.length === 0) out.push("Your workspace is set up. Start by creating articles in your projects.");
  return out;
}

// ── Chart style passthrough ───────────────────────────────────────────────────
const CHART_STYLES: Record<string, string> = {
  articlesOverviewChartWrap: s.chartWrap,
  articlesOverviewChartLegend: s.chartLegend,
  articlesOverviewChartLegendSwatch: s.chartSwatch,
  articlesOverviewChartSvg: s.chartSvg,
  articlesOverviewChartTooltip: s.chartTooltip,
  articlesOverviewChartTooltipPanel: s.chartTooltipPanel,
  articlesOverviewChartTooltipHead: s.chartTooltipHead,
  articlesOverviewChartTooltipDate: s.chartTooltipDate,
  articlesOverviewChartTooltipCaption: s.chartTooltipCaption,
  articlesOverviewChartTooltipTable: s.chartTooltipTable,
  articlesOverviewChartTooltipMetric: s.chartTooltipMetric,
  articlesOverviewChartTooltipValue: s.chartTooltipValue,
  articlesOverviewChartTooltipFooter: s.chartTooltipFooter,
  articlesOverviewChartTooltipFooterLabel: s.chartTooltipFooterLabel,
  articlesOverviewChartTooltipFooterValue: s.chartTooltipFooterValue,
  articlesOverviewChartTooltipCaret: s.chartTooltipCaret,
  articlesOverviewChartTooltipSwatch: s.chartTooltipSwatch,
  articlesOverviewChartTooltipSwatchPublished: s.chartSwatchPublished,
  articlesOverviewChartTooltipSwatchPending: s.chartSwatchPending,
  articlesOverviewChartTooltipSwatchScheduled: s.chartSwatchScheduled,
  articlesOverviewChartEmpty: s.chartEmpty,
};

// ── Main component ────────────────────────────────────────────────────────────
export function ProjectOverviewDashboard({ onGoProjects }: { onGoProjects?: () => void }) {
  const [filters, setFiltersRaw] = useState<DashboardFilters>(() => {
    if (typeof window === "undefined") return defaultFilters();
    return loadFilters();
  });
  const [data, setData]           = useState<WorkspaceOverviewResponse | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [refreshing, setRefresh]  = useState(false);

  const [dateOpen, setDateOpen]   = useState(false);
  const [projOpen, setProjOpen]   = useState(false);
  const [gran, setGran]           = useState<Granularity>("daily");
  const [hiddenSeries, setHidden] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy]       = useState<SortKey>("published");
  const [feedFilter, setFeedFilter] = useState<FeedFilter>("all");
  const [searchQ, setSearchQ]     = useState("");

  const setFilters = useCallback((f: DashboardFilters) => {
    setFiltersRaw(f);
    saveFilters(f);
  }, []);

  const load = useCallback(async (fresh = false) => {
    if (fresh) setRefresh(true); else setLoading(true);
    setError(null);
    try {
      const d = await api.workspaceOverview(
        { startDate: filters.startDate, endDate: filters.endDate, projectIds: filters.projectIds },
        { skipGlobalLoading: true },
      );
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load workspace overview.");
    } finally {
      setLoading(false);
      setRefresh(false);
    }
  }, [filters]);

  useEffect(() => { void load(false); }, [load]);

  // Derive project list from data for the filter dropdown
  const allProjects = data?.project_summaries ?? [];

  const chartSeries = useMemo(
    () => aggregateSeries(data?.activity_series ?? [], gran, hiddenSeries),
    [data, gran, hiddenSeries],
  );

  const activityFeed = useMemo(() => {
    if (!data) return [];
    const all: WorkspaceFeedItem[] = [
      ...(data.recently_published ?? []),
      ...(data.pending ?? []),
      ...(data.drafts ?? []),
    ];
    const filtered = feedFilter === "all" ? all : all.filter((i) => i.status_tag === feedFilter);
    const q = searchQ.toLowerCase();
    const searched = q ? filtered.filter((i) => i.title.toLowerCase().includes(q) || i.project_name.toLowerCase().includes(q)) : filtered;
    searched.sort((a, b) => {
      const ta = a.sort_at ? Date.parse(a.sort_at) : 0;
      const tb = b.sort_at ? Date.parse(b.sort_at) : 0;
      return tb - ta;
    });
    return searched.slice(0, 12);
  }, [data, feedFilter, searchQ]);

  const sortedProjects = useMemo(() => {
    const sorted = sortProjects(allProjects, sortBy);
    const q = searchQ.toLowerCase();
    return q ? sorted.filter((p) => p.name.toLowerCase().includes(q)) : sorted;
  }, [allProjects, sortBy, searchQ]);

  const selectedProjectIds = filters.projectIds;
  const compareLabel = data?.comparison_stats ? fmtCompareLabel(data.comparison_stats) : "vs. previous period";
  const insights = useMemo(() => data ? buildInsights(data, compareLabel) : [], [data, compareLabel]);

  const handleProjectCardClick = useCallback((id: string) => {
    const newIds = selectedProjectIds.includes(id)
      ? selectedProjectIds.filter((x) => x !== id)
      : [...selectedProjectIds, id];
    setFilters({ ...filters, projectIds: newIds });
  }, [filters, selectedProjectIds, setFilters]);

  const filterLabel = useMemo(() => {
    if (selectedProjectIds.length === 0) return "All projects";
    if (selectedProjectIds.length === 1) {
      const p = allProjects.find((x) => x.project_id === selectedProjectIds[0]);
      return p?.name ?? "1 project";
    }
    return `${selectedProjectIds.length} projects`;
  }, [selectedProjectIds, allProjects]);

  const toggleSeries = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // ── Render ──
  if (loading) return <DashboardSkeleton />;

  const stats = data?.stats;
  const fs    = data?.filtered_stats;
  const cs    = data?.comparison_stats;

  if (error || !data || !stats) {
    return (
      <div className={s.errorState}>
        <p className={s.errorTitle}>Overview unavailable</p>
        <p className={s.errorMsg}>{error ?? "Unable to load workspace overview."}</p>
        <button type="button" className={s.retryBtn} onClick={() => void load(true)}>Try again</button>
      </div>
    );
  }

  if (stats.project_count === 0 && onGoProjects) {
    return (
      <div className={s.errorState}>
        <p className={s.errorTitle}>No projects yet</p>
        <p className={s.errorMsg}>Create your first project to see the overview dashboard come to life.</p>
        <button type="button" className={s.retryBtn} onClick={onGoProjects}>Go to projects</button>
      </div>
    );
  }

  const rangeLabel = fmtRangeLabel(filters);

  return (
    <div className={s.shell}>

      {/* ── Header ── */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>Project Overview</h1>
          <p className={s.subtitle}>
            Monitor publishing operations, content production, and project performance across every workspace.
          </p>
        </div>
        <div className={s.headerRight}>
          <div className={s.searchWrap}>
            <span className={s.searchIcon}><IcoSearch /></span>
            <input
              type="search"
              className={s.searchInput}
              placeholder="Search projects or articles…"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              aria-label="Search projects and articles"
            />
          </div>
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div className={s.filterBar}>
        <div className={s.filterLeft}>
          {/* Date range */}
          <div className={s.filterDropWrap}>
            <button
              type="button"
              className={`${s.filterBtn} ${dateOpen ? s.filterBtnActive : ""}`}
              onClick={() => { setDateOpen((v) => !v); setProjOpen(false); }}
              aria-expanded={dateOpen}
              aria-haspopup="true"
            >
              <IcoCal />
              <span>{rangeLabel}</span>
              <IcoChevron />
            </button>
            {dateOpen && (
              <DateRangePicker
                filters={filters}
                onChange={(f) => { setFilters(f); }}
                onClose={() => setDateOpen(false)}
              />
            )}
          </div>

          {/* Project filter */}
          {allProjects.length > 1 && (
            <div className={s.filterDropWrap}>
              <button
                type="button"
                className={`${s.filterBtn} ${projOpen ? s.filterBtnActive : ""} ${selectedProjectIds.length > 0 ? s.filterBtnFiltered : ""}`}
                onClick={() => { setProjOpen((v) => !v); setDateOpen(false); }}
                aria-expanded={projOpen}
                aria-haspopup="true"
              >
                <IcoFolder />
                <span>{filterLabel}</span>
                <IcoChevron />
              </button>
              {projOpen && (
                <ProjectFilterDropdown
                  projects={allProjects}
                  selectedIds={selectedProjectIds}
                  onChange={(ids) => {
                    setFilters({ ...filters, projectIds: ids });
                    setProjOpen(false);
                  }}
                  onClose={() => setProjOpen(false)}
                />
              )}
            </div>
          )}
        </div>

        <div className={s.filterRight}>
          {refreshing && <span className={s.refreshingLabel}>Refreshing…</span>}
          <button
            type="button"
            className={s.refreshBtn}
            onClick={() => void load(true)}
            disabled={refreshing}
            aria-label="Refresh dashboard"
          >
            <IcoRefresh />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* ── KPI cards ── */}
      <div className={s.kpiGrid} aria-label="Key performance indicators">
        <KpiCard
          icon={<IcoFolder />}
          label="Active projects"
          value={stats.project_count}
          accentVar="var(--aa-info)"
          noCompare
        />
        <KpiCard
          icon={<IcoCheck />}
          label="Published"
          value={fs?.published ?? stats.published}
          current={fs?.published}
          previous={cs?.published}
          compareLabel={compareLabel}
          accentVar="var(--aa-success)"
        />
        <KpiCard
          icon={<IcoCal />}
          label="Scheduled"
          value={stats.upcoming_scheduled}
          accentVar="var(--aa-warning)"
          noCompare
        />
        <KpiCard
          icon={<IcoFile />}
          label="Drafts"
          value={fs?.draft ?? stats.draft}
          current={fs?.draft}
          previous={cs?.draft}
          compareLabel={compareLabel}
          accentVar="#7090c8"
        />
        <KpiCard
          icon={<IcoClock />}
          label="Pending"
          value={fs?.pending ?? stats.pending}
          current={fs?.pending}
          previous={cs?.pending}
          compareLabel={compareLabel}
          accentVar="var(--aa-primary)"
        />
        <KpiCard
          icon={<IcoLayers />}
          label="Total content"
          value={fs?.total_articles ?? stats.total_articles}
          current={fs?.total_articles}
          previous={cs?.total_articles}
          compareLabel={compareLabel}
          accentVar="rgba(160,157,150,0.7)"
        />
      </div>

      {/* ── Charts row ── */}
      <div className={s.chartsRow}>

        {/* Activity chart */}
        <div className={s.chartCard}>
          <div className={s.chartCardHead}>
            <div>
              <h2 className={s.cardTitle}>Workspace activity</h2>
              <p className={s.cardSub}>{rangeLabel} · daily publishing and pipeline counts</p>
            </div>
            <div className={s.chartControls}>
              <div className={s.seriesToggle} role="group" aria-label="Toggle series">
                {[
                  { key: "published", label: "Published", color: DONUT_COLORS.published },
                  { key: "pending",   label: "Pending",   color: "#e8e8ec" },
                  { key: "scheduled", label: "Scheduled", color: DONUT_COLORS.scheduled },
                ].map((s_) => (
                  <button
                    key={s_.key}
                    type="button"
                    className={`${s.seriesBtn} ${hiddenSeries.has(s_.key) ? s.seriesBtnOff : ""}`}
                    onClick={() => toggleSeries(s_.key)}
                    aria-pressed={!hiddenSeries.has(s_.key)}
                  >
                    <span className={s.seriesDot} style={{ background: hiddenSeries.has(s_.key) ? "rgba(255,255,255,0.2)" : s_.color }} />
                    {s_.label}
                  </button>
                ))}
              </div>
              <div className={s.granToggle} role="group" aria-label="Granularity">
                {(["daily", "weekly", "monthly"] as Granularity[]).map((g) => (
                  <button
                    key={g}
                    type="button"
                    className={`${s.granBtn} ${gran === g ? s.granBtnActive : ""}`}
                    onClick={() => setGran(g)}
                    aria-pressed={gran === g}
                  >
                    {g === "daily" ? "D" : g === "weekly" ? "W" : "M"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <ArticlesOverviewChart
            series={chartSeries}
            label={`Workspace article activity — ${rangeLabel}`}
            styles={CHART_STYLES}
          />
        </div>

        {/* Distribution donut */}
        <div className={s.donutCard}>
          <div className={s.chartCardHead}>
            <div>
              <h2 className={s.cardTitle}>Content distribution</h2>
              <p className={s.cardSub}>Current workload breakdown</p>
            </div>
          </div>
          <DonutChart
            published={fs?.published ?? stats.published}
            scheduled={stats.upcoming_scheduled}
            draft={fs?.draft ?? stats.draft}
            pending={fs?.pending ?? stats.pending}
          />
        </div>
      </div>

      {/* ── Project performance ── */}
      {sortedProjects.length > 0 && (
        <section aria-labelledby="proj-perf-heading">
          <div className={s.sectionHead}>
            <div>
              <h2 id="proj-perf-heading" className={s.sectionTitle}>Project performance</h2>
              <p className={s.sectionSub}>
                {selectedProjectIds.length > 0
                  ? `Showing ${selectedProjectIds.length} of ${allProjects.length} projects — click a card to toggle filter`
                  : "Click a card to filter the dashboard to that project"}
              </p>
            </div>
            <div className={s.sortWrap}>
              <label htmlFor="proj-sort" className={s.sortLabel}>Sort by</label>
              <select
                id="proj-sort"
                className={s.sortSelect}
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortKey)}
              >
                <option value="published">Most published</option>
                <option value="active">Most active</option>
                <option value="pending">Most pending</option>
                <option value="drafts">Most drafts</option>
                <option value="updated">Recently updated</option>
              </select>
            </div>
          </div>

          {sortedProjects.length === 0 ? (
            <p className={s.emptyText}>No projects match your search.</p>
          ) : (
            <div className={s.projGrid}>
              {sortedProjects.map((proj) => (
                <ProjectCard
                  key={proj.project_id}
                  proj={proj}
                  onClick={handleProjectCardClick}
                  isSelected={selectedProjectIds.includes(proj.project_id)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── Activity + Schedule ── */}
      <div className={s.feedRow}>
        {/* Activity feed */}
        <div className={s.feedPanel}>
          <div className={s.feedPanelHead}>
            <h2 className={s.feedPanelTitle}>Recent activity</h2>
            <span className={s.feedCount}>{activityFeed.length}</span>
          </div>
          <div className={s.feedTabs} role="tablist" aria-label="Activity filter">
            {(["all", "published", "pending", "draft", "scheduled"] as FeedFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={feedFilter === f}
                className={`${s.feedTab} ${feedFilter === f ? s.feedTabActive : ""}`}
                onClick={() => setFeedFilter(f)}
              >
                {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          {activityFeed.length === 0 ? (
            <p className={s.feedEmpty}>No activity in this period. Try a broader date range.</p>
          ) : (
            activityFeed.map((item) => (
              <FeedItem key={`${item.status_tag}-${item.id}`} item={item} />
            ))
          )}
        </div>

        {/* Upcoming schedule */}
        <div className={s.feedPanel}>
          <div className={s.feedPanelHead}>
            <h2 className={s.feedPanelTitle}>Upcoming schedule</h2>
            <span className={s.feedCount}>{data.upcoming_scheduled.length}</span>
          </div>
          {data.upcoming_scheduled.length === 0 ? (
            <p className={s.feedEmpty}>
              No articles scheduled. Use the Schedule tab in any project to queue content for automatic publishing.
            </p>
          ) : (
            data.upcoming_scheduled.map((item) => (
              <FeedItem key={`sched-${item.id}`} item={item} />
            ))
          )}
          {stats.upcoming_scheduled > data.upcoming_scheduled.length && (
            <p className={s.feedMore}>
              +{(stats.upcoming_scheduled - data.upcoming_scheduled.length).toLocaleString()} more scheduled
            </p>
          )}
        </div>
      </div>

      {/* ── Insights ── */}
      {insights.length > 0 && (
        <section className={s.insightsPanel} aria-labelledby="insights-heading">
          <h2 id="insights-heading" className={s.sectionTitle} style={{ margin: 0, marginBottom: 14 }}>
            Insights
          </h2>
          <div className={s.insightsList}>
            {insights.map((text, i) => (
              <div key={i} className={s.insightItem}>
                <span className={s.insightDot} />
                <span>{text}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Quick actions ── */}
      <QuickActions onGoProjects={onGoProjects} />
    </div>
  );
}
