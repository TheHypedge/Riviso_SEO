"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { api } from "@/lib/api";
import type {
  ProjectSummary,
  WorkspaceActivityDay,
  WorkspaceFeedItem,
  WorkspaceFilteredStats,
  WorkspaceOverviewResponse,
} from "@/lib/api";
import { articleEditorPath } from "@/lib/articlePaths";
import { formatDateTime, parseServerTimestamp } from "@/lib/dateFormat";
import { Card, DonutChart } from "@/components/ui";

// ── Types (mirrors ProjectOverviewDashboard.tsx — pure, theme-agnostic) ───────
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

type SortKey = "published" | "active" | "pending" | "drafts" | "updated";
type FeedFilter = "all" | "published" | "pending" | "draft" | "scheduled";

const FILTER_STORAGE_KEY = "rvs_overview_filters";

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
  if (unit === "month") r.setUTCDate(1);
  else if (unit === "quarter") r.setUTCMonth(Math.floor(r.getUTCMonth() / 3) * 3, 1);
  else r.setUTCMonth(0, 1);
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
    case "today": return { start: fmt(today), end: fmt(today), label: "Today" };
    case "yesterday": return { start: fmt(yest), end: fmt(yest), label: "Yesterday" };
    case "7d": return { start: fmt(addDays(today, -6)), end: fmt(today), label: "Last 7 days" };
    case "14d": return { start: fmt(addDays(today, -13)), end: fmt(today), label: "Last 14 days" };
    case "30d": return { start: fmt(addDays(today, -29)), end: fmt(today), label: "Last 30 days" };
    case "90d": return { start: fmt(addDays(today, -89)), end: fmt(today), label: "Last 90 days" };
    case "this_month": return { start: fmt(startOfUTC(today, "month")), end: fmt(today), label: "This month" };
    case "last_month": {
      const som = startOfUTC(today, "month");
      const eom = addDays(som, -1);
      return { start: fmt(startOfUTC(eom, "month")), end: fmt(eom), label: "Last month" };
    }
    case "this_quarter": return { start: fmt(startOfUTC(today, "quarter")), end: fmt(today), label: "This quarter" };
    case "last_quarter": {
      const soq = startOfUTC(today, "quarter");
      const eoq = addDays(soq, -1);
      return { start: fmt(startOfUTC(eoq, "quarter")), end: fmt(eoq), label: "Last quarter" };
    }
    case "this_year": return { start: fmt(startOfUTC(today, "year")), end: fmt(today), label: "This year" };
    default: return { start: fmt(addDays(today, -29)), end: fmt(today), label: "Custom range" };
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

interface Delta { pct: number | null; label: string; positive: boolean; isNew: boolean }

function computeDelta(current: number, previous: number): Delta {
  if (previous === 0) {
    if (current === 0) return { pct: null, label: "—", positive: true, isNew: false };
    return { pct: null, label: "New", positive: true, isNew: true };
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  return { pct, label: pct > 0 ? `+${pct}%` : `${pct}%`, positive: pct >= 0, isNew: false };
}

function relativeTime(iso: string | null | undefined): string {
  const d = parseServerTimestamp(iso);
  if (!d) return "—";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.round(diff / 86400)}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function sortProjects(list: ProjectSummary[], key: SortKey): ProjectSummary[] {
  return [...list].sort((a, b) => {
    switch (key) {
      case "published": return b.published - a.published;
      case "pending": return b.pending - a.pending;
      case "drafts": return b.draft - a.draft;
      case "updated": return (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "");
      case "active": {
        const scoreA = a.published + a.upcoming_scheduled * 0.5 + a.pending * 0.2;
        const scoreB = b.published + b.upcoming_scheduled * 0.5 + b.pending * 0.2;
        return scoreB - scoreA;
      }
      default: return 0;
    }
  });
}

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

const SERIES_COLOR: Record<string, string> = {
  published: "#2E8B57",
  scheduled: "#B8770B",
  draft: "#3B6FE0",
  pending: "#E15A2C",
};

const PRESETS: { key: DatePreset; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 days" },
  { key: "14d", label: "Last 14 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "this_quarter", label: "This quarter" },
  { key: "last_quarter", label: "Last quarter" },
  { key: "this_year", label: "This year" },
];

function DateRangePicker({ filters, onChange, onClose }: {
  filters: DashboardFilters; onChange: (f: DashboardFilters) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const fn = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [onClose]);

  return (
    <div ref={ref} className="absolute right-0 top-full z-dropdown mt-2 w-56 rounded-lg border border-border bg-surface p-2 shadow-md">
      {PRESETS.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => {
            const meta = getPresetMeta(p.key);
            onChange({ ...filters, preset: p.key, startDate: meta.start, endDate: meta.end });
            onClose();
          }}
          className={`block w-full rounded-sm px-3 py-1.5 text-left text-sm ${
            filters.preset === p.key ? "bg-accent-tint text-accent-hover font-medium" : "text-ink-secondary hover:bg-surface-sunken"
          }`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

// ── KPI card ──────────────────────────────────────────────────────────────────
function KpiCard({ label, value, current, previous, compareLabel, noCompare }: {
  label: string; value: number; current?: number; previous?: number; compareLabel?: string; noCompare?: boolean;
}) {
  const delta = useMemo<Delta | null>(() => {
    if (noCompare || current === undefined || previous === undefined) return null;
    return computeDelta(current, previous);
  }, [current, previous, noCompare]);

  return (
    <Card className="flex flex-col gap-2.5 p-[18px] shadow-sm">
      <span className="font-heading text-xs font-medium text-ink-secondary">{label}</span>
      <div className="flex items-center gap-2">
        <span className="font-heading text-[28px] font-bold leading-none text-ink">{value.toLocaleString()}</span>
        {delta ? (
          <span
            className={`rounded-[5px] px-1.5 py-0.5 text-[11px] font-semibold ${
              delta.isNew || delta.positive ? "bg-success-tint text-success-strong" : "bg-danger-tint text-danger"
            }`}
          >
            {delta.label}
          </span>
        ) : null}
      </div>
      {delta && compareLabel ? <span className="text-[11px] text-ink-tertiary">{compareLabel}</span> : null}
    </Card>
  );
}

// ── Activity trend: smooth gradient area (Published) + line (Scheduled),
// matching the Figma "Articles Published" chart. Catmull-Rom smoothing +
// gradient-area technique reused from ProjectActivityChart.tsx (dark-theme
// project tab chart) rather than re-derived — same math, trimmed to the two
// series Figma's legend shows; per-day drafts/pending stay in the KPI cards
// and donut chart above instead of crowding this line chart. ──────────────
type ChartPoint = { x: number; y: number };

function smoothPath(points: ChartPoint[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function areaPath(points: ChartPoint[], baselineY: number): string {
  if (points.length === 0) return "";
  const line = smoothPath(points);
  const first = points[0];
  const last = points[points.length - 1];
  return `${line} L ${last.x} ${baselineY} L ${first.x} ${baselineY} Z`;
}

function ActivityTrend({ series }: { series: WorkspaceActivityDay[] }) {
  const gradId = useId().replace(/:/g, "");
  const W = 900;
  const H = 220;
  const padL = 4;
  const padR = 4;
  const padT = 8;
  const padB = 8;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const baselineY = padT + innerH;
  const n = series.length;

  const max = Math.max(1, ...series.map((d) => Math.max(d.published, d.scheduled)));
  const xForIndex = (i: number) => (n <= 1 ? padL + innerW / 2 : padL + (innerW * i) / (n - 1));
  const yForValue = (v: number) => padT + innerH - (innerH * v) / max;

  const publishedPts = series.map((d, i) => ({ x: xForIndex(i), y: yForValue(d.published) }));
  const scheduledPts = series.map((d, i) => ({ x: xForIndex(i), y: yForValue(d.scheduled) }));

  if (series.length === 0) {
    return <div className="flex h-[220px] items-center justify-center text-sm text-ink-tertiary">No activity in this period.</div>;
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Published and scheduled articles over time">
      <defs>
        <linearGradient id={`${gradId}-published`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={SERIES_COLOR.published} stopOpacity={0.28} />
          <stop offset="100%" stopColor={SERIES_COLOR.published} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath(publishedPts, baselineY)} fill={`url(#${gradId}-published)`} stroke="none" />
      <path d={smoothPath(publishedPts)} fill="none" stroke={SERIES_COLOR.published} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      <path d={smoothPath(scheduledPts)} fill="none" stroke={SERIES_COLOR.scheduled} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="5 4" />
    </svg>
  );
}

// ── Project card ──────────────────────────────────────────────────────────────
function ProjectCard({ proj, onClick, isSelected }: {
  proj: ProjectSummary; onClick: (id: string) => void; isSelected: boolean;
}) {
  const domain = useMemo(() => {
    try {
      const raw = proj.website_url?.startsWith("http") ? proj.website_url : `https://${proj.website_url ?? ""}`;
      return new URL(raw).hostname.replace(/^www\./, "");
    } catch { return proj.website_url ?? ""; }
  }, [proj.website_url]);

  const pubPct = proj.total_articles > 0 ? Math.round((proj.published / proj.total_articles) * 100) : 0;

  return (
    <Card
      hoverLift
      onClick={() => onClick(proj.project_id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(proj.project_id); }}
      aria-pressed={isSelected}
      title={`Filter to ${proj.name}`}
      className={`flex cursor-pointer flex-col gap-3 p-5 ${isSelected ? "border-accent" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-semibold text-ink">{proj.name}</div>
          {domain ? <div className="truncate text-xs text-ink-tertiary">{domain}</div> : null}
        </div>
        {proj.platform ? (
          <span className="shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-bold text-ink-secondary">
            {proj.platform === "shopify" ? "Shopify" : "WP"}
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-4 gap-2 text-center">
        <div>
          <div className="text-sm font-bold" style={{ color: SERIES_COLOR.published }}>{proj.published}</div>
          <div className="text-[11px] text-ink-tertiary">Published</div>
        </div>
        <div>
          <div className="text-sm font-bold" style={{ color: SERIES_COLOR.scheduled }}>{proj.upcoming_scheduled}</div>
          <div className="text-[11px] text-ink-tertiary">Scheduled</div>
        </div>
        <div>
          <div className="text-sm font-bold" style={{ color: SERIES_COLOR.pending }}>{proj.pending}</div>
          <div className="text-[11px] text-ink-tertiary">Pending</div>
        </div>
        <div>
          <div className="text-sm font-bold" style={{ color: SERIES_COLOR.draft }}>{proj.draft}</div>
          <div className="text-[11px] text-ink-tertiary">Drafts</div>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
          <div className="h-full rounded-full bg-accent" style={{ width: `${pubPct}%` }} />
        </div>
        <span className="text-xs text-ink-tertiary">{pubPct}% published</span>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3">
        <span className="text-xs text-ink-tertiary">{relativeTime(proj.last_activity_at)}</span>
        <Link
          href={`/projects/${proj.project_id}`}
          onClick={(e) => e.stopPropagation()}
          className="text-xs font-semibold text-accent hover:text-accent-hover"
        >
          Open →
        </Link>
      </div>
    </Card>
  );
}

// ── Feed item ─────────────────────────────────────────────────────────────────
const STATUS_LABELS: Record<string, string> = {
  published: "Published", scheduled: "Scheduled", pending: "Pending", draft: "Draft",
};

function FeedItem({ item }: { item: WorkspaceFeedItem }) {
  const href = articleEditorPath(item.project_id, item.article_id);
  const statusLabel = STATUS_LABELS[item.status_tag] ?? item.status_tag;
  const hasDate = !!parseServerTimestamp(item.sort_at);
  const when = hasDate ? formatDateTime(item.sort_at) : "No date recorded";

  return (
    <div className="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: SERIES_COLOR[item.status_tag] ?? "#A6A29A" }}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        {href ? (
          <Link href={href} className="block truncate text-sm font-medium text-ink hover:text-accent" title={item.title}>
            {item.title}
          </Link>
        ) : (
          <span className="block truncate text-sm font-medium text-ink">{item.title}</span>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-tertiary">
          <span>{item.project_name}</span>
          <span style={{ color: SERIES_COLOR[item.status_tag] }}>{statusLabel}</span>
          <span>{when}</span>
        </div>
      </div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-6 gap-4">
        {[...Array(6)].map((_, i) => <div key={i} className="h-24 animate-pulse rounded-lg bg-surface-sunken" />)}
      </div>
      <div className="h-64 animate-pulse rounded-lg bg-surface-sunken" />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function ProjectOverviewDashboardLight({ onGoProjects }: { onGoProjects?: () => void }) {
  const [filters, setFiltersRaw] = useState<DashboardFilters>(() => {
    if (typeof window === "undefined") return defaultFilters();
    return loadFilters();
  });
  const [data, setData] = useState<WorkspaceOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>("published");
  const [feedFilter, setFeedFilter] = useState<FeedFilter>("all");
  const [searchQ, setSearchQ] = useState("");

  const setFilters = useCallback((f: DashboardFilters) => { setFiltersRaw(f); saveFilters(f); }, []);

  const load = useCallback(async () => {
    setLoading(true);
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
    }
  }, [filters]);

  useEffect(() => { void load(); }, [load]);

  const allProjects = data?.project_summaries ?? [];

  const activityFeed = useMemo(() => {
    if (!data) return [];
    const all: WorkspaceFeedItem[] = [...(data.recently_published ?? []), ...(data.pending ?? []), ...(data.drafts ?? [])];
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
  const insights = useMemo(() => (data ? buildInsights(data, compareLabel) : []), [data, compareLabel]);

  const handleProjectCardClick = useCallback((id: string) => {
    const newIds = selectedProjectIds.includes(id) ? selectedProjectIds.filter((x) => x !== id) : [...selectedProjectIds, id];
    setFilters({ ...filters, projectIds: newIds });
  }, [filters, selectedProjectIds, setFilters]);

  if (loading) return <OverviewSkeleton />;

  const stats = data?.stats;
  const fs = data?.filtered_stats;
  const cs = data?.comparison_stats;

  if (error || !data || !stats) {
    return (
      <Card className="flex flex-col items-center gap-3 p-8 text-center">
        <p className="font-semibold text-ink">Overview unavailable</p>
        <p className="text-sm text-ink-secondary">{error ?? "Unable to load workspace overview."}</p>
        <button type="button" className="text-sm font-semibold text-accent" onClick={() => void load()}>Try again</button>
      </Card>
    );
  }

  if (stats.project_count === 0 && onGoProjects) {
    return (
      <Card className="flex flex-col items-center gap-3 p-8 text-center">
        <p className="font-semibold text-ink">No projects yet</p>
        <p className="text-sm text-ink-secondary">Create your first project to see the overview dashboard come to life.</p>
        <button type="button" className="text-sm font-semibold text-accent" onClick={onGoProjects}>Go to projects</button>
      </Card>
    );
  }

  const rangeLabel = fmtRangeLabel(filters);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-ink">Dashboard</h1>
        <p className="text-[13px] text-ink-secondary">Overview of your projects, content pipeline, and performance</p>
      </div>

      {data.degraded ? (
        <div className="rounded-md border border-warning bg-warning-tint px-4 py-2.5 text-sm text-warning">
          Some data couldn&apos;t be loaded right now, so this view may be incomplete. Refresh to try again.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative">
          <button
            type="button"
            onClick={() => setDateOpen((v) => !v)}
            className="rounded-sm border border-border bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-sunken"
          >
            {rangeLabel} ▾
          </button>
          {dateOpen ? (
            <DateRangePicker filters={filters} onChange={setFilters} onClose={() => setDateOpen(false)} />
          ) : null}
        </div>
        <input
          type="search"
          placeholder="Search projects or articles…"
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
          className="w-72 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-tertiary focus:border-accent focus:outline-none"
        />
      </div>

      <div className="grid grid-cols-3 gap-4 md:grid-cols-6">
        <KpiCard label="Active projects" value={stats.project_count} noCompare />
        <KpiCard label="Published" value={fs?.published ?? stats.published} current={fs?.published} previous={cs?.published} compareLabel={compareLabel} />
        <KpiCard label="Scheduled" value={stats.upcoming_scheduled} noCompare />
        <KpiCard label="Drafts" value={fs?.draft ?? stats.draft} current={fs?.draft} previous={cs?.draft} compareLabel={compareLabel} />
        <KpiCard label="Pending" value={fs?.pending ?? stats.pending} current={fs?.pending} previous={cs?.pending} compareLabel={compareLabel} />
        <KpiCard label="Total content" value={fs?.total_articles ?? stats.total_articles} current={fs?.total_articles} previous={cs?.total_articles} compareLabel={compareLabel} />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="col-span-2 p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-heading text-[15px] font-semibold text-ink">Workspace activity</h2>
              <p className="text-xs text-ink-tertiary">{rangeLabel} · daily publishing and pipeline counts</p>
            </div>
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5 text-xs font-medium text-ink-secondary">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SERIES_COLOR.published }} aria-hidden="true" />
                Published
              </span>
              <span className="flex items-center gap-1.5 text-xs font-medium text-ink-secondary">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SERIES_COLOR.scheduled }} aria-hidden="true" />
                Scheduled
              </span>
            </div>
          </div>
          <ActivityTrend series={data.activity_series} />
        </Card>
        <Card className="p-5 shadow-sm">
          <h2 className="mb-1 font-heading text-[15px] font-semibold text-ink">Content distribution</h2>
          <p className="mb-4 text-xs text-ink-tertiary">Current workload breakdown</p>
          <DonutChart
            centerLabel="Articles"
            segments={[
              { label: "Published", value: fs?.published ?? stats.published, color: SERIES_COLOR.published },
              { label: "Scheduled", value: stats.upcoming_scheduled, color: SERIES_COLOR.scheduled },
              { label: "Drafts", value: fs?.draft ?? stats.draft, color: SERIES_COLOR.draft },
              { label: "Pending", value: fs?.pending ?? stats.pending, color: SERIES_COLOR.pending },
            ]}
          />
        </Card>
      </div>

      {sortedProjects.length > 0 ? (
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-heading text-[15px] font-semibold text-ink">Project performance</h2>
              <p className="text-xs text-ink-tertiary">
                {selectedProjectIds.length > 0
                  ? `Showing ${selectedProjectIds.length} of ${allProjects.length} projects — click a card to toggle filter`
                  : "Click a card to filter the dashboard to that project"}
              </p>
            </div>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
              className="rounded-sm border border-border bg-surface px-2.5 py-1.5 text-sm text-ink"
            >
              <option value="published">Most published</option>
              <option value="active">Most active</option>
              <option value="pending">Most pending</option>
              <option value="drafts">Most drafts</option>
              <option value="updated">Recently updated</option>
            </select>
          </div>
          <div className="grid grid-cols-3 gap-4">
            {sortedProjects.map((proj) => (
              <ProjectCard key={proj.project_id} proj={proj} onClick={handleProjectCardClick} isSelected={selectedProjectIds.includes(proj.project_id)} />
            ))}
          </div>
        </section>
      ) : null}

      <div className="grid grid-cols-2 gap-4">
        <Card className="p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-heading text-[15px] font-semibold text-ink">Recent activity</h2>
            <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-bold text-ink-secondary">{activityFeed.length}</span>
          </div>
          <div className="mb-3 flex gap-1.5">
            {(["all", "published", "pending", "draft", "scheduled"] as FeedFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFeedFilter(f)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  feedFilter === f ? "bg-accent-tint text-accent-hover" : "text-ink-tertiary hover:bg-surface-sunken"
                }`}
              >
                {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          {activityFeed.length === 0 ? (
            <p className="text-sm text-ink-tertiary">No activity in this period. Try a broader date range.</p>
          ) : (
            activityFeed.map((item) => <FeedItem key={`${item.status_tag}-${item.id}`} item={item} />)
          )}
        </Card>

        <Card className="p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-heading text-[15px] font-semibold text-ink">Upcoming schedule</h2>
            <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-bold text-ink-secondary">{data.upcoming_scheduled.length}</span>
          </div>
          {data.upcoming_scheduled.length === 0 ? (
            <p className="text-sm text-ink-tertiary">No articles scheduled. Use the Schedule tab in any project to queue content for automatic publishing.</p>
          ) : (
            data.upcoming_scheduled.map((item) => <FeedItem key={`sched-${item.id}`} item={item} />)
          )}
          {stats.upcoming_scheduled > data.upcoming_scheduled.length ? (
            <p className="mt-2 text-xs text-ink-tertiary">
              +{(stats.upcoming_scheduled - data.upcoming_scheduled.length).toLocaleString()} more scheduled
            </p>
          ) : null}
        </Card>
      </div>

      {insights.length > 0 ? (
        <Card className="p-5 shadow-sm">
          <h2 className="mb-3 font-heading text-[15px] font-semibold text-ink">Insights</h2>
          <div className="flex flex-col gap-2">
            {insights.map((text, i) => (
              <div key={i} className="flex items-start gap-2 text-sm text-ink-secondary">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span>{text}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
