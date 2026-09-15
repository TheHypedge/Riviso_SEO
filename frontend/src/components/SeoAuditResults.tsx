"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { CartesianGrid, Cell, Line, LineChart, Pie, PieChart, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import type { SeoAuditCounts, SeoAuditIssue, SeoAuditIssueGroup, SeoAuditRun, SeoAuditUrlRow } from "@/lib/api";
import { ScoreGauge, formatSiteAuditTimestamp } from "@/components/TechnicalAuditResults";
import { useFocusTrap } from "@/lib/useFocusTrap";
import {
  ChartContainer,
  ChartTooltipContent,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  DataTable,
  DataTableHead,
  DataTableBody,
  DataTableRow,
  DataTableHeaderCell,
  DataTableCell,
} from "@/components/ui";

type CssModule = { [key: string]: string };

function statusPillClass(styles: CssModule, status: string | null | undefined): string {
  if (status === "good") return `${styles.statusPill} ${styles.statusPublished}`;
  if (status === "needs_improvement") return `${styles.statusPill} ${styles.statusDraft}`;
  if (status === "poor") return `${styles.statusPill} ${styles.statusPending}`;
  return `${styles.statusPill} ${styles.statusNeutral}`;
}

function indexabilityStatus(v: string): "good" | "needs_improvement" | "poor" | null {
  if (v === "indexable") return "good";
  if (v === "blocked") return "needs_improvement";
  if (v === "non_indexable") return "poor";
  return null;
}

const INDEXABILITY_LABELS: Record<string, string> = {
  indexable: "Indexable",
  non_indexable: "Non-indexable",
  blocked: "Blocked",
  unknown: "Unknown",
};

function indexabilityLabel(v: string): string {
  return INDEXABILITY_LABELS[v] || v;
}

function scoreStatus(score: number | null | undefined): "good" | "needs_improvement" | "poor" | null {
  if (score === null || score === undefined) return null;
  if (score >= 90) return "good";
  if (score >= 50) return "needs_improvement";
  return "poor";
}

const DIMENSION_LABELS: Record<string, string> = {
  crawlability: "Crawlability",
  indexability: "Indexability",
  on_page: "On-Page",
  internal_links: "Internal Linking",
};

const ICON_STROKE = { fill: "none" as const, stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function DimensionIcon({ dimension }: { dimension: string }) {
  switch (dimension) {
    case "crawlability":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" {...ICON_STROKE} />
          <path d="M20 20l-4.3-4.3" {...ICON_STROKE} />
        </svg>
      );
    case "indexability":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 4h11l5 5v11H4z" {...ICON_STROKE} />
          <path d="M15 4v5h5" {...ICON_STROKE} />
          <path d="M8 13h8M8 17h5" {...ICON_STROKE} />
        </svg>
      );
    case "on_page":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 6h16M4 12h10M4 18h13" {...ICON_STROKE} />
        </svg>
      );
    case "internal_links":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="6" cy="12" r="3" {...ICON_STROKE} />
          <circle cx="18" cy="6" r="3" {...ICON_STROKE} />
          <circle cx="18" cy="18" r="3" {...ICON_STROKE} />
          <path d="M8.6 10.7L15.4 7.3M8.6 13.3L15.4 16.7" {...ICON_STROKE} />
        </svg>
      );
    default:
      return null;
  }
}

const SEVERITY_LABELS: Record<string, string> = { issue: "Critical", warning: "Warning", opportunity: "Opportunity" };

function severityPillClass(styles: CssModule, severity: string): string {
  if (severity === "issue") return `${styles.statusPill} ${styles.statusPending}`;
  if (severity === "warning") return `${styles.statusPill} ${styles.statusDraft}`;
  return `${styles.statusPill} ${styles.statusNeutral}`;
}

/* ── Running-state progress: derived from real crawl counts, not a timer.
   Unlike Technical Audit's single opaque PageSpeed call, the crawler reports
   genuine incremental counts every few seconds, so the stage state here is a
   direct read of real backend progress -- never fabricated. ─────────────── */

const SEO_RUN_STAGES = ["Validating website", "Crawling pages", "Analyzing links & issues"];

const ANALYSIS_STAGE_LABELS: Record<string, string> = {
  loading_pages: "Reading crawled pages",
  mapping_links: "Mapping internal links",
  evaluating_issues: "Evaluating issues",
};

export function SeoAuditRunProgress({
  counts,
  analysisProgress,
  styles,
}: {
  counts?: SeoAuditCounts | null;
  analysisProgress?: import("@/lib/api").SeoAuditAnalysisProgress | null;
  styles: CssModule;
}) {
  const discovered = counts?.discovered ?? 0;
  const fetched = counts?.fetched ?? 0;
  const queued = counts?.queued ?? 0;

  let stageIndex = 0;
  if (discovered > 0) stageIndex = 1;
  if (discovered > 0 && queued === 0 && fetched >= discovered) stageIndex = 2;

  // Real fetched/discovered ratio -- not simulated. `discovered` can still climb as
  // the crawl finds more pages, so this isn't a strictly monotonic "% complete";
  // it settles once discovery outpaces fetching, same behavior any BFS crawler has.
  const pct = discovered > 0 ? Math.min(100, Math.round((fetched / discovered) * 100)) : 0;

  return (
    <div className={styles.siteAuditRunChecklist} role="status" aria-label="Running SEO Audit">
      {stageIndex === 1 && discovered > 0 ? (
        <div
          className={styles.seoAuditProgressBar}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Crawled ${fetched} of ${discovered} discovered pages`}
        >
          <div className={styles.seoAuditProgressBarFill} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {SEO_RUN_STAGES.map((label, i) => {
        const state = i < stageIndex ? "done" : i === stageIndex ? "active" : "pending";
        return (
          <div key={label} className={styles.siteAuditRunChecklistItem} data-state={state}>
            <span className={styles.siteAuditRunChecklistMark} aria-hidden="true">
              {state === "done" ? "✓" : state === "active" ? <span className={styles.siteAuditBtnSpinner} /> : "○"}
            </span>
            {label}
            {i === 1 && discovered > 0 ? (
              <span className={styles.muted} style={{ marginLeft: 8, fontSize: 12 }}>
                {fetched}/{discovered} pages
              </span>
            ) : null}
            {i === 2 && state === "active" && analysisProgress ? (
              <span className={styles.muted} style={{ marginLeft: 8, fontSize: 12 }}>
                {ANALYSIS_STAGE_LABELS[analysisProgress.stage] || analysisProgress.stage}
                {analysisProgress.loaded !== null ? ` — ${analysisProgress.loaded.toLocaleString()}${analysisProgress.total ? `/${analysisProgress.total.toLocaleString()}` : ""}` : "…"}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ── Live crawl feed: pages appear one by one as the worker actually crawls them.
   Polls the small, indexed "recently crawled" endpoint every 2s while running --
   real backend state, not a simulated stream (§82: "do not display fake progress"
   applies just as much to *which pages* as to the percentage). ────────────────── */

/* ── Compact single-line "currently crawling" indicator: replaces the old
   multi-row scrolling log. One line, cross-fades to the next URL as it lands --
   still real backend state (polled, not simulated), just not a growing list
   that eats the page. ───────────────────────────────────────────────────── */

export function SeoAuditCompactCrawlStatus({ projectId, auditId, styles }: { projectId: string; auditId: string; styles: CssModule }) {
  const [row, setRow] = useState<SeoAuditUrlRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const res = await api.getSeoAuditRecentUrls(projectId, auditId, 1);
        if (!cancelled) setRow(res.items?.[0] || null);
      } catch {
        // Transient poll failure -- keep trying rather than clearing what's shown.
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, auditId]);

  if (!row) return null;
  const ok = typeof row.status_code === "number" && row.status_code < 400;

  return (
    <div key={row.id} className={styles.seoAuditCompactStatus} role="status" aria-live="polite">
      <span className={styles.seoAuditCompactStatusDot} data-ok={ok ? "true" : "false"} aria-hidden="true" />
      <span className={styles.seoAuditCompactStatusUrl}>{row.url}</span>
      <span className={styles.seoAuditCompactStatusMeta}>
        {row.status_code ?? "—"}
        {row.response_time_ms ? ` · ${row.response_time_ms}ms` : ""}
      </span>
    </div>
  );
}

/* ── Preview Issues: simple, no-graph-needed checks (missing title/meta/H1,
   thin content) run client-side over a sample of already-crawled pages while
   the audit is still running. Deliberately NOT the full 18-rule issue engine --
   things like orphan pages or broken internal links need the complete link
   graph, which only exists once the crawl finishes. Labeled as a preview over
   a bounded sample so it never reads as a final, total count. ────────────── */

const PREVIEW_ISSUE_CHECKS: { key: string; label: string; test: (r: SeoAuditUrlRow) => boolean }[] = [
  { key: "missing_title", label: "Missing Title Tag", test: (r) => r.indexability !== "blocked" && !r.title },
  { key: "missing_meta", label: "Missing Meta Description", test: (r) => r.indexability !== "blocked" && !r.meta_description },
  { key: "missing_h1", label: "Missing H1", test: (r) => r.indexability !== "blocked" && r.h1_count === 0 },
  { key: "thin_content", label: "Thin Content (under 300 words)", test: (r) => typeof r.word_count === "number" && r.word_count > 0 && r.word_count < 300 },
];

export function SeoAuditPreviewIssuesTable({ projectId, auditId, styles }: { projectId: string; auditId: string; styles: CssModule }) {
  const [rows, setRows] = useState<SeoAuditUrlRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const res = await api.getSeoAuditRecentUrls(projectId, auditId, 50);
        if (!cancelled) setRows(res.items || []);
      } catch {
        // Transient poll failure -- keep showing the last good sample.
      }
      if (!cancelled) timer = setTimeout(poll, 5000);
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, auditId]);

  if (rows.length === 0) return null;

  const counts = PREVIEW_ISSUE_CHECKS.map((c) => ({ ...c, affected: rows.filter(c.test).length })).filter((c) => c.affected > 0);

  return (
    <div className={`${styles.card} ${styles.cardWide}`}>
      <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
        Issues Preview
      </h3>
      <p className={styles.muted} style={{ margin: "-4px 0 8px", fontSize: 11 }}>
        Based on the {rows.length} most recently crawled page{rows.length === 1 ? "" : "s"} -- full analysis (including broken/orphan links) runs once crawling completes.
      </p>
      {counts.length === 0 ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
          No issues found in the pages crawled so far.
        </p>
      ) : (
        <div className={styles.siteAuditFindingList}>
          {counts.map((c) => (
            <div key={c.key} className={styles.siteAuditFindingRowStatic}>
              <div className={styles.siteAuditFindingHead}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{c.label}</span>
              </div>
              <p className={styles.muted} style={{ margin: "4px 0 0", fontSize: 12 }}>
                {c.affected} of {rows.length} sampled page{rows.length === 1 ? "" : "s"}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Summary: gauge + 4 dimension cards ─────────────────────────────────── */

export function SeoAuditSummary({ audit, styles }: { audit: SeoAuditRun; styles: CssModule }) {
  const health = audit.health_score;
  const overall = health?.overall ?? null;
  const status = scoreStatus(overall);
  const entries = [
    { key: "crawlability", value: health?.crawlability ?? null },
    { key: "indexability", value: health?.indexability ?? null },
    { key: "on_page", value: health?.on_page ?? null },
    { key: "internal_links", value: health?.internal_links ?? null },
  ];
  const counts = audit.counts;

  return (
    <div className={`${styles.card} ${styles.cardWide} ${styles.siteAuditSummaryCard}`}>
      <div className={styles.siteAuditSummaryGauge}>
        <ScoreGauge score={overall} styles={styles} />
        <span className={styles.siteAuditGaugeCaption}>SEO Health Score</span>
        {status ? <span className={statusPillClass(styles, status)}>{status === "good" ? "Good" : status === "needs_improvement" ? "Needs Improvement" : "Poor"}</span> : null}
      </div>
      <div className={styles.siteAuditCategoryGrid}>
        {entries.map((e) => {
          const st = scoreStatus(e.value);
          return (
            <div key={e.key} className={styles.siteAuditCategoryCard}>
              <span className={styles.siteAuditCategoryIcon} data-status={st || "unknown"} aria-hidden="true">
                <DimensionIcon dimension={e.key} />
              </span>
              <span className={styles.siteAuditCategoryLabel}>{DIMENSION_LABELS[e.key] || e.key}</span>
              <span className={styles.siteAuditCategoryValue}>
                {e.value === null ? "—" : e.value}
                <span className={styles.siteAuditCategoryValueUnit}>/100</span>
              </span>
              {st ? <span className={statusPillClass(styles, st)}>{st === "good" ? "Good" : st === "needs_improvement" ? "Needs Improvement" : "Poor"}</span> : null}
            </div>
          );
        })}
      </div>
      <div className={styles.siteAuditHealthMessage}>
        <p style={{ margin: 0, fontSize: 13 }}>
          Crawled {counts.fetched.toLocaleString()} of {counts.discovered.toLocaleString()} discovered URLs
          {counts.failed ? `, ${counts.failed} failed` : ""}
          {counts.blocked ? `, ${counts.blocked} blocked by robots.txt` : ""}.
          {typeof audit.orphan_count === "number" && audit.orphan_count > 0 ? ` ${audit.orphan_count} page${audit.orphan_count === 1 ? "" : "s"} found with no internal links pointing to them.` : ""}
        </p>
      </div>
    </div>
  );
}

/* ── KPI strip: 6 overview tiles (Crawled URLs, Issues, Broken Links,
   Redirects, Internal Links, External Links). Every value read straight off
   stored audit docs -- the trend sparkline and "vs period" delta are built
   from the audit history array already fetched once by the parent page (an
   indexed, bounded `limit=20` query -- see database.py's
   `(project_id, started_at)` index on `seo_audits`), filtered client-side to
   the selected window. No extra network round-trip per period change, and no
   fabricated trend when a project doesn't have enough audit history yet --
   the sparkline/delta simply don't render for a single-audit project. ───── */

const KPI_ICON_STROKE = { fill: "none" as const, stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function KpiIcon({ kind }: { kind: "crawled" | "issues" | "broken" | "redirects" | "internal" | "external" }) {
  switch (kind) {
    case "crawled":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" {...KPI_ICON_STROKE} />
          <path d="M3 12h18M12 3c2.5 2.5 3.5 5.8 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.8-3.5-9s1-6.5 3.5-9z" {...KPI_ICON_STROKE} />
        </svg>
      );
    case "issues":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" {...KPI_ICON_STROKE} />
          <path d="M9 9l6 6M15 9l-6 6" {...KPI_ICON_STROKE} />
        </svg>
      );
    case "broken":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8.5 15.5l-2 2a3 3 0 01-4.2-4.2l3-3a3 3 0 014.2 0" {...KPI_ICON_STROKE} />
          <path d="M15.5 8.5l2-2a3 3 0 014.2 4.2l-3 3a3 3 0 01-4.2 0" {...KPI_ICON_STROKE} />
          <path d="M9 9l1.5 1.5M14 14l1 1" {...KPI_ICON_STROKE} />
        </svg>
      );
    case "redirects":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 8h13l-3-3M20 16H7l3 3" {...KPI_ICON_STROKE} />
        </svg>
      );
    case "internal":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="6" cy="12" r="2.5" {...KPI_ICON_STROKE} />
          <circle cx="18" cy="6" r="2.5" {...KPI_ICON_STROKE} />
          <circle cx="18" cy="18" r="2.5" {...KPI_ICON_STROKE} />
          <path d="M8.2 10.8L15.8 7.2M8.2 13.2L15.8 16.8" {...KPI_ICON_STROKE} />
        </svg>
      );
    case "external":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 6H5.5A1.5 1.5 0 004 7.5v11A1.5 1.5 0 005.5 20h11a1.5 1.5 0 001.5-1.5V15" {...KPI_ICON_STROKE} />
          <path d="M14 4h6v6M20 4L11 13" {...KPI_ICON_STROKE} />
        </svg>
      );
    default:
      return null;
  }
}

type SparkPoint = { ts: string; value: number };

/** Small trend line, Recharts-backed. `good` controls whether an increase reads
 * as the positive color (more crawled URLs) or the negative one (more broken
 * links). Hover reveals the exact value/date via the shared chart tooltip. */
function Sparkline({ points, good }: { points: SparkPoint[]; good: "up" | "down" }) {
  if (points.length < 2) return null;
  const values = points.map((p) => p.value);
  const flat = values[values.length - 1] === values[0];
  const trendingUp = values[values.length - 1] > values[0];
  const positive = good === "up" ? trendingUp : !trendingUp;
  const color = flat ? "var(--aa-muted)" : positive ? "var(--aa-success)" : "var(--aa-error)";
  return (
    <ChartContainer height={28} className="w-[72px]">
      <LineChart data={points} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <XAxis dataKey="ts" hide />
        <Tooltip
          content={
            <ChartTooltipContent
              labelFormatter={(l) => formatSiteAuditTimestamp(String(l))}
              formatter={(v) => Number(v).toLocaleString()}
            />
          }
        />
        <Line dataKey="value" name="Value" type="monotone" stroke={color} strokeWidth={1.75} dot={false} isAnimationActive={false} />
      </LineChart>
    </ChartContainer>
  );
}

function periodDelta(series: SparkPoint[]): { pct: number; positive: boolean; diff: number } | null {
  if (series.length < 2) return null;
  const first = series[0].value;
  const last = series[series.length - 1].value;
  if (first === 0) return null;
  const pct = Math.round(((last - first) / first) * 100);
  if (pct === 0 && last === first) return null;
  return { pct, positive: last >= first, diff: last - first };
}

const PERIOD_OPTIONS: { key: 7 | 14 | 30; label: string }[] = [
  { key: 7, label: "7D" },
  { key: 14, label: "14D" },
  { key: 30, label: "30D" },
];

export function SeoAuditKpiStrip({
  audit,
  projectId,
  history,
  styles,
}: {
  audit: SeoAuditRun;
  projectId: string;
  history?: SeoAuditRun[];
  styles: CssModule;
}) {
  const [priorityCounts, setPriorityCounts] = useState<{ high: number; medium: number; low: number } | null>(null);
  const [periodDays, setPeriodDays] = useState<7 | 14 | 30>(7);

  useEffect(() => {
    let cancelled = false;
    api
      .getSeoAuditIssueGroups(projectId, audit.id)
      .then((res) => {
        if (cancelled) return;
        const groups = (res.groups || []).filter((g) => g.severity === "issue");
        const counts = { high: 0, medium: 0, low: 0 };
        for (const g of groups) counts[g.priority] += g.affected_urls;
        setPriorityCounts(counts);
      })
      .catch(() => {
        if (!cancelled) setPriorityCounts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, audit.id]);

  const currentTs = audit.completed_at || audit.started_at;
  const windowStart = new Date(currentTs.replace(" ", "T") + "Z");
  windowStart.setUTCDate(windowStart.getUTCDate() - periodDays);
  const windowStartIso = windowStart.toISOString().slice(0, 19).replace("T", " ");

  // Completed runs within the selected window, oldest first, current run last.
  // Filtered client-side from the already-fetched, indexed, bounded (limit=20)
  // history -- no new request when the period selector changes.
  const runsInWindow = [...(history || []).filter((r) => r.id !== audit.id && (r.status === "completed" || r.status === "partial")), audit]
    .filter((r) => {
      const ts = r.completed_at || r.started_at;
      return ts >= windowStartIso && ts <= currentTs;
    })
    .sort((a, b) => (a.completed_at || a.started_at).localeCompare(b.completed_at || b.started_at));

  function seriesFor(getValue: (r: SeoAuditRun) => number | null | undefined): SparkPoint[] {
    return runsInWindow
      .map((r) => ({ ts: r.completed_at || r.started_at, value: getValue(r) }))
      .filter((p): p is SparkPoint => typeof p.value === "number");
  }

  const issueCount = audit.severity_counts?.issue ?? null;
  // `counts.broken_links`/`counts.redirects` update every ~3s during an active
  // crawl; `broken_links_count`/`redirects_count` are only set once the whole
  // pipeline finishes. Preferring the live field lets these tiles climb in real
  // time instead of sitting at "--" until the run completes -- falls back to the
  // post-completion aggregate for audits crawled before this field existed.
  const liveBrokenLinks = audit.counts.broken_links ?? audit.broken_links_count ?? null;
  const liveRedirects = audit.counts.redirects ?? audit.redirects_count ?? null;

  const crawledSeries = seriesFor((r) => r.counts.fetched);
  const brokenSeries = seriesFor((r) => r.broken_links_count);
  const redirectsSeries = seriesFor((r) => r.redirects_count);

  const crawledDelta = periodDelta(crawledSeries);
  const brokenDelta = periodDelta(brokenSeries);
  const redirectsDelta = periodDelta(redirectsSeries);

  return (
    <div>
      <div className={styles.seoAuditKpiPeriodRow}>
        <span className={styles.muted} style={{ fontSize: 12 }}>
          Comparing against
        </span>
        <div className={styles.segmentGroup} aria-label="Comparison period">
          {PERIOD_OPTIONS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={styles.miniBtn}
              onClick={() => setPeriodDays(p.key)}
              aria-pressed={periodDays === p.key}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.seoAuditKpiStrip}>
        {/* Crawled URLs */}
        <div className={styles.seoAuditKpiTile}>
          <span className={styles.seoAuditKpiIcon} data-tone="info" aria-hidden="true">
            <KpiIcon kind="crawled" />
          </span>
          <span className={styles.seoAuditKpiValue}>{audit.counts.fetched.toLocaleString()}</span>
          <span className={styles.seoAuditKpiLabel}>Crawled URLs</span>
          <div className={styles.seoAuditKpiFoot}>
            {crawledDelta ? (
              <span className={styles.seoAuditKpiDelta} data-positive={crawledDelta.positive ? "true" : "false"}>
                {crawledDelta.positive ? "▲" : "▼"} {Math.abs(crawledDelta.diff).toLocaleString()} ({Math.abs(crawledDelta.pct)}%)
              </span>
            ) : (
              <span className={styles.seoAuditKpiDeltaEmpty}>Not enough audits in this window</span>
            )}
            <Sparkline points={crawledSeries} good="up" />
          </div>
        </div>

        {/* Issues */}
        <div className={styles.seoAuditKpiTile}>
          <span className={styles.seoAuditKpiIcon} data-tone="danger" aria-hidden="true">
            <KpiIcon kind="issues" />
          </span>
          <span className={styles.seoAuditKpiValue} data-tone={issueCount ? "poor" : ""}>
            {issueCount === null ? "—" : issueCount.toLocaleString()}
          </span>
          <span className={styles.seoAuditKpiLabel}>Issues</span>
          {priorityCounts && issueCount ? (
            <span className={styles.seoAuditKpiBreakdown}>
              <span data-severity="high">{priorityCounts.high} High</span>
              <span data-severity="medium">{priorityCounts.medium} Medium</span>
              <span data-severity="low">{priorityCounts.low} Low</span>
            </span>
          ) : null}
        </div>

        {/* Broken Links */}
        <div className={styles.seoAuditKpiTile}>
          <span className={styles.seoAuditKpiIcon} data-tone="danger" aria-hidden="true">
            <KpiIcon kind="broken" />
          </span>
          <span className={styles.seoAuditKpiValue} data-tone={liveBrokenLinks ? "poor" : ""}>
            {liveBrokenLinks === null ? "—" : liveBrokenLinks.toLocaleString()}
          </span>
          <span className={styles.seoAuditKpiLabel}>Broken Links</span>
          <div className={styles.seoAuditKpiFoot}>
            {brokenDelta ? (
              <span className={styles.seoAuditKpiDelta} data-positive={!brokenDelta.positive ? "true" : "false"}>
                {brokenDelta.positive ? "▲" : "▼"} {Math.abs(brokenDelta.diff).toLocaleString()} ({Math.abs(brokenDelta.pct)}%)
              </span>
            ) : (
              <span className={styles.seoAuditKpiDeltaEmpty}>Not enough audits in this window</span>
            )}
            <Sparkline points={brokenSeries} good="down" />
          </div>
        </div>

        {/* Redirects */}
        <div className={styles.seoAuditKpiTile}>
          <span className={styles.seoAuditKpiIcon} data-tone="neutral" aria-hidden="true">
            <KpiIcon kind="redirects" />
          </span>
          <span className={styles.seoAuditKpiValue}>
            {liveRedirects === null ? "—" : liveRedirects.toLocaleString()}
          </span>
          <span className={styles.seoAuditKpiLabel}>Redirects</span>
          {redirectsDelta ? (
            <span className={styles.seoAuditKpiDeltaText}>
              {redirectsDelta.positive ? "+" : ""}
              {redirectsDelta.diff.toLocaleString()} vs {periodDays}d ago
            </span>
          ) : (
            <span className={styles.seoAuditKpiDeltaEmpty}>Not enough audits in this window</span>
          )}
        </div>

        {/* Internal Links */}
        <div className={styles.seoAuditKpiTile}>
          <span className={styles.seoAuditKpiIcon} data-tone="neutral" aria-hidden="true">
            <KpiIcon kind="internal" />
          </span>
          <span className={styles.seoAuditKpiValue}>{audit.counts.internal.toLocaleString()}</span>
          <span className={styles.seoAuditKpiLabel}>Internal Links</span>
          <span className={styles.seoAuditKpiDeltaEmpty}>in total</span>
        </div>

        {/* External Links */}
        <div className={styles.seoAuditKpiTile}>
          <span className={styles.seoAuditKpiIcon} data-tone="neutral" aria-hidden="true">
            <KpiIcon kind="external" />
          </span>
          <span className={styles.seoAuditKpiValue}>{audit.counts.external.toLocaleString()}</span>
          <span className={styles.seoAuditKpiLabel}>External Links</span>
          <span className={styles.seoAuditKpiDeltaEmpty}>in total</span>
        </div>
      </div>
    </div>
  );
}

/* ── Indexability donut: real breakdown across the whole crawl, hand-rolled
   SVG (no chart library), mirrors ScoreGauge's technique. Deliberately not a
   content-type donut (HTML/CSS/JS/Images) -- Phase 1 only crawls HTML pages,
   so that split would have to be faked. This is the honest substitute. ──── */

const DONUT_SEGMENTS: { key: "indexable" | "non_indexable" | "blocked" | "unknown"; label: string; color: string }[] = [
  { key: "indexable", label: "Indexable", color: "var(--aa-success, #5db872)" },
  { key: "non_indexable", label: "Non-indexable", color: "var(--aa-error, #c64545)" },
  { key: "blocked", label: "Blocked", color: "var(--aa-warning, #d4a017)" },
  { key: "unknown", label: "Unknown", color: "var(--aa-on-dark-soft, #a09d96)" },
];

export function SeoAuditIndexabilityDonut({ breakdown, styles }: { breakdown?: SeoAuditRun["indexability_breakdown"]; styles: CssModule }) {
  if (!breakdown) return null;
  const total = breakdown.indexable + breakdown.non_indexable + breakdown.blocked + breakdown.unknown;
  if (total === 0) return null;

  const slices = DONUT_SEGMENTS.map((seg) => ({ ...seg, value: breakdown[seg.key] })).filter((s) => s.value > 0);

  return (
    <div className={`${styles.card} ${styles.seoAuditDonutCard}`}>
      <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
        Indexability Breakdown
      </h3>
      <div className={styles.seoAuditDonutWrap}>
        <div className="relative" style={{ width: 140, height: 140 }}>
          <ChartContainer height={140}>
            <PieChart>
              <Pie data={slices} dataKey="value" nameKey="label" innerRadius={50} outerRadius={70} startAngle={90} endAngle={-270} stroke="none">
                {slices.map((s) => (
                  <Cell key={s.key} fill={s.color} />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltipContent formatter={(v) => Number(v).toLocaleString()} />} />
            </PieChart>
          </ChartContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-sans text-xl font-bold text-ink">{total.toLocaleString()}</span>
            <span className="font-sans text-[11px] text-ink-tertiary">URLs</span>
          </div>
        </div>
        <ul className={styles.seoAuditDonutLegend}>
          {DONUT_SEGMENTS.filter((s) => breakdown[s.key] > 0).map((s) => (
            <li key={s.key}>
              <span className={styles.seoAuditDonutDot} style={{ background: s.color }} aria-hidden="true" />
              <span className={styles.seoAuditDonutLegendLabel}>{s.label}</span>
              <span className={styles.seoAuditDonutLegendValue}>{breakdown[s.key].toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ── Issues trend: critical + warning issue counts across the last 8 completed
   crawls, one combined line -- matches Figma's Crawl Trend Card (44:2) exactly.
   Reuses the same `history` array already fetched once by the parent page for
   the KPI strip's sparklines, no new request. Hidden until there are at least
   2 completed audits -- same "no fabricated trend" rule as Sparkline above. ── */

function trendTickDate(iso: string): string {
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

export function SeoAuditIssuesTrendChart({ history, styles }: { history: SeoAuditRun[]; styles: CssModule }) {
  const points = history
    .filter((r) => r.status === "completed" || r.status === "partial")
    .sort((a, b) => (a.completed_at || a.started_at).localeCompare(b.completed_at || b.started_at))
    .slice(-8)
    .map((r) => ({
      ts: r.completed_at || r.started_at,
      value: (r.severity_counts?.issue ?? 0) + (r.severity_counts?.warning ?? 0),
    }));

  if (points.length < 2) return null;

  return (
    <div className={`${styles.card} ${styles.cardWide}`}>
      <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
        Issues Trend
      </h3>
      <p className={styles.muted} style={{ margin: "-4px 0 8px", fontSize: 11 }}>
        Critical + warning issues found per crawl, last {points.length} audits
      </p>
      <ChartContainer height={140}>
        <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
          <CartesianGrid vertical={false} stroke="var(--aa-hairline)" />
          <XAxis dataKey="ts" tickFormatter={trendTickDate} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--aa-on-dark-soft, #a09d96)" }} />
          <YAxis tickLine={false} axisLine={false} allowDecimals={false} tick={{ fontSize: 11, fill: "var(--aa-on-dark-soft, #a09d96)" }} />
          <Tooltip
            content={
              <ChartTooltipContent
                labelFormatter={(l) => formatSiteAuditTimestamp(String(l))}
                formatter={(v) => Number(v).toLocaleString()}
              />
            }
          />
          <Line dataKey="value" name="Issues" type="monotone" stroke="var(--aa-error)" strokeWidth={2} dot={{ r: 3, fill: "var(--aa-error)" }} isAnimationActive={false} />
        </LineChart>
      </ChartContainer>
    </div>
  );
}

/* ── Crawl stats: duration/requests/response time/pages-per-sec, all real. ── */

export function SeoAuditCrawlStats({ audit, projectId, styles }: { audit: SeoAuditRun; projectId: string; styles: CssModule }) {
  const [lastUrl, setLastUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getSeoAuditRecentUrls(projectId, audit.id, 1)
      .then((res) => {
        if (!cancelled) setLastUrl(res.items?.[0]?.url || null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, audit.id]);

  const durationS = audit.duration_ms ? audit.duration_ms / 1000 : null;
  const requests = audit.counts.fetched + audit.counts.failed;
  const pagesPerSec = durationS && durationS > 0 ? (audit.counts.fetched / durationS).toFixed(1) : null;

  const stats = [
    { label: "Duration", value: durationS ? `${durationS.toFixed(1)}s` : "—" },
    { label: "Requests", value: requests.toLocaleString() },
    { label: "Avg Response", value: audit.avg_response_time_ms ? `${audit.avg_response_time_ms}ms` : "—" },
    { label: "Pages/Sec", value: pagesPerSec ?? "—" },
  ];

  return (
    <div className={`${styles.card} ${styles.seoAuditDonutCard}`}>
      <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
        Crawl Stats
      </h3>
      <div className={styles.seoAuditStatsGrid}>
        {stats.map((s) => (
          <div key={s.label} className={styles.seoAuditStatTile}>
            <span className={styles.seoAuditStatValue}>{s.value}</span>
            <span className={styles.seoAuditStatLabel}>{s.label}</span>
          </div>
        ))}
      </div>
      {lastUrl ? (
        <p className={styles.muted} style={{ margin: "10px 0 0", fontSize: 12, wordBreak: "break-all" }}>
          Last URL crawled: {lastUrl}
        </p>
      ) : null}
    </div>
  );
}

/* ── Top Issues: top 5 by priority, with an honest "% of total" derived from
   data already returned (no new endpoint). ─────────────────────────────── */

export function SeoAuditTopIssuesTable({
  projectId,
  auditId,
  totalCrawled,
  onViewAll,
  styles,
}: {
  projectId: string;
  auditId: string;
  totalCrawled: number;
  onViewAll: () => void;
  styles: CssModule;
}) {
  const [groups, setGroups] = useState<SeoAuditIssueGroup[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getSeoAuditIssueGroups(projectId, auditId)
      .then((res) => {
        if (!cancelled) setGroups(res.groups || []);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, auditId]);

  if (loading) return null;

  const top5 = groups.slice(0, 5);

  return (
    <div className={`${styles.card} ${styles.cardWide}`}>
      <div className={styles.analyticsHeaderRow}>
        <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
          Top Issues
        </h3>
        {groups.length > 0 ? (
          <button type="button" className={styles.siteAuditViewAllBtn} onClick={onViewAll}>
            View all issues →
          </button>
        ) : null}
      </div>
      {groups.length === 0 ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
          No issues detected in the crawled pages. Nice work.
        </p>
      ) : (
        <DataTable>
          <DataTableHead>
            <DataTableRow>
              <DataTableHeaderCell>Issue</DataTableHeaderCell>
              <DataTableHeaderCell>URLs</DataTableHeaderCell>
              <DataTableHeaderCell>% of Total</DataTableHeaderCell>
              <DataTableHeaderCell>Impact</DataTableHeaderCell>
              <DataTableHeaderCell>Effort</DataTableHeaderCell>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {top5.map((g) => (
              <DataTableRow key={g.rule_id}>
                <DataTableCell>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{g.category}</span>
                    <span className={severityPillClass(styles, g.severity)}>{SEVERITY_LABELS[g.severity] || g.severity}</span>
                  </div>
                </DataTableCell>
                <DataTableCell>{g.affected_urls.toLocaleString()}</DataTableCell>
                <DataTableCell>{totalCrawled > 0 ? `${((g.affected_urls / totalCrawled) * 100).toFixed(2)}%` : "—"}</DataTableCell>
                <DataTableCell>
                  <span style={{ color: levelColor(g.priority), fontWeight: 600 }}>{LEVEL_LABELS[g.priority] || g.priority}</span>
                </DataTableCell>
                <DataTableCell>
                  <span style={{ color: levelColor(g.effort), fontWeight: 600 }}>{g.effort ? LEVEL_LABELS[g.effort] || g.effort : "—"}</span>
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
    </div>
  );
}

/* ── Issue list: grouped by rule, expandable to the affected URLs ──────── */

const SEVERITY_FILTERS: { key: "" | "issue" | "warning" | "opportunity"; label: string }[] = [
  { key: "", label: "All" },
  { key: "issue", label: "Errors" },
  { key: "warning", label: "Warnings" },
  { key: "opportunity", label: "Opportunities" },
];

function levelColor(level: string | undefined): string {
  if (level === "high") return "var(--aa-error, #c64545)";
  if (level === "medium") return "var(--aa-warning, #d4a017)";
  if (level === "low") return "var(--aa-success, #5db872)";
  return "var(--aa-on-dark-soft, #a09d96)";
}

const LEVEL_LABELS: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };

function SortHeaderButton({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc" | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 border-0 bg-transparent p-0 font-sans text-xs font-semibold uppercase tracking-wide ${active ? "text-ink" : "text-ink-secondary"}`}
    >
      {label}
      <span aria-hidden="true" className={active ? "opacity-100" : "opacity-30"}>
        {dir === "asc" ? "▲" : "▼"}
      </span>
    </button>
  );
}

export function SeoAuditIssuesList({
  projectId,
  auditId,
  totalCrawled,
  styles,
}: {
  projectId: string;
  auditId: string;
  totalCrawled: number;
  styles: CssModule;
}) {
  const [groups, setGroups] = useState<SeoAuditIssueGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ruleIssues, setRuleIssues] = useState<Record<string, SeoAuditIssue[]>>({});
  const [severityFilter, setSeverityFilter] = useState<"" | "issue" | "warning" | "opportunity">("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: "urls" | "pct"; dir: "asc" | "desc" } | null>(null);

  function toggleSort(key: "urls" | "pct") {
    setSort((prev) => (prev?.key === key ? { key, dir: prev.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getSeoAuditIssueGroups(projectId, auditId)
      .then((res) => {
        if (!cancelled) setGroups(res.groups || []);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, auditId]);

  const toggle = useCallback(
    (ruleId: string) => {
      if (expanded === ruleId) {
        setExpanded(null);
        return;
      }
      setExpanded(ruleId);
      if (!ruleIssues[ruleId]) {
        api
          .getSeoAuditIssuesForRule(projectId, auditId, ruleId)
          .then((res) => setRuleIssues((prev) => ({ ...prev, [ruleId]: res.issues || [] })))
          .catch(() => setRuleIssues((prev) => ({ ...prev, [ruleId]: [] })));
      }
    },
    [expanded, ruleIssues, projectId, auditId],
  );

  if (loading) return null;
  if (groups.length === 0) {
    return (
      <div className={`${styles.card} ${styles.cardWide}`}>
        <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
          Issues
        </h3>
        <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
          No issues detected in the crawled pages. Nice work.
        </p>
      </div>
    );
  }

  // Real counts per severity bucket (sum of affected URLs across that
  // bucket's rule groups), for the filter tab labels -- e.g. "Errors (120)".
  const severityCounts = { issue: 0, warning: 0, opportunity: 0 };
  for (const g of groups) severityCounts[g.severity] = (severityCounts[g.severity] || 0) + g.affected_urls;
  const filterTabs: { key: "" | "issue" | "warning" | "opportunity"; label: string }[] = [
    { key: "", label: "All Issues" },
    { key: "issue", label: `Errors (${severityCounts.issue})` },
    { key: "warning", label: `Warnings (${severityCounts.warning})` },
    { key: "opportunity", label: `Opportunities (${severityCounts.opportunity})` },
  ];

  const qLower = q.trim().toLowerCase();
  const filtered = groups.filter((g) => {
    if (severityFilter && g.severity !== severityFilter) return false;
    if (qLower && !g.category.toLowerCase().includes(qLower) && !g.rule_id.toLowerCase().includes(qLower)) return false;
    return true;
  });
  if (sort) {
    const sign = sort.dir === "asc" ? 1 : -1;
    const valueOf = sort.key === "urls" ? (g: SeoAuditIssueGroup) => g.affected_urls : (g: SeoAuditIssueGroup) => g.affected_urls / (totalCrawled || 1);
    filtered.sort((a, b) => sign * (valueOf(a) - valueOf(b)));
  }

  function exportCsv() {
    const header = ["Issue", "Severity", "URLs", "% of Total", "Impact", "Effort"];
    const rows = filtered.map((g) => [
      g.category,
      SEVERITY_LABELS[g.severity] || g.severity,
      String(g.affected_urls),
      totalCrawled > 0 ? `${((g.affected_urls / totalCrawled) * 100).toFixed(2)}%` : "",
      g.priority ? LEVEL_LABELS[g.priority] || g.priority : "",
      g.effort ? LEVEL_LABELS[g.effort] || g.effort : "",
    ]);
    const csv = [header, ...rows]
      .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "seo-audit-issues.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={`${styles.card} ${styles.cardWide}`}>
      <div className={styles.analyticsHeaderRow}>
        <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
          Issues
        </h3>
        <div className={styles.segmentGroup} aria-label="Severity filter">
          {filterTabs.map((f) => (
            <button key={f.key || "all"} type="button" className={styles.miniBtn} onClick={() => setSeverityFilter(f.key)} aria-pressed={severityFilter === f.key}>
              {f.label}
            </button>
          ))}
        </div>
        <button type="button" className={styles.btnSecondary} onClick={exportCsv} disabled={filtered.length === 0}>
          Export
        </button>
      </div>
      <input className={styles.input} placeholder="Search issues…" value={q} onChange={(e) => setQ(e.target.value)} style={{ margin: "10px 0" }} />
      {filtered.length === 0 ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
          No issues match this filter.
        </p>
      ) : (
        <DataTable>
          <DataTableHead>
            <DataTableRow>
              <DataTableHeaderCell>Issue</DataTableHeaderCell>
              <DataTableHeaderCell className="text-right">
                <SortHeaderButton label="URLs" active={sort?.key === "urls"} dir={sort?.key === "urls" ? sort.dir : null} onClick={() => toggleSort("urls")} />
              </DataTableHeaderCell>
              <DataTableHeaderCell className="text-right">
                <SortHeaderButton label="% of Total" active={sort?.key === "pct"} dir={sort?.key === "pct" ? sort.dir : null} onClick={() => toggleSort("pct")} />
              </DataTableHeaderCell>
              <DataTableHeaderCell>Impact</DataTableHeaderCell>
              <DataTableHeaderCell>Effort</DataTableHeaderCell>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {filtered.map((g) => (
              <Fragment key={g.rule_id}>
                <DataTableRow
                  onClick={() => toggle(g.rule_id)}
                  style={{ cursor: "pointer" }}
                  aria-expanded={expanded === g.rule_id}
                >
                  <DataTableCell>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 600 }}>{g.category}</span>
                      <span className={severityPillClass(styles, g.severity)}>{SEVERITY_LABELS[g.severity] || g.severity}</span>
                    </div>
                  </DataTableCell>
                  <DataTableCell className="text-right tabular-nums">{g.affected_urls.toLocaleString()}</DataTableCell>
                  <DataTableCell className="text-right tabular-nums">{totalCrawled > 0 ? `${((g.affected_urls / totalCrawled) * 100).toFixed(2)}%` : "—"}</DataTableCell>
                  <DataTableCell>
                    <span style={{ color: levelColor(g.priority), fontWeight: 600 }}>{LEVEL_LABELS[g.priority] || g.priority}</span>
                  </DataTableCell>
                  <DataTableCell>
                    <span style={{ color: levelColor(g.effort), fontWeight: 600 }}>{g.effort ? LEVEL_LABELS[g.effort] || g.effort : "—"}</span>
                  </DataTableCell>
                </DataTableRow>
                {expanded === g.rule_id ? (
                  <DataTableRow key={`${g.rule_id}-detail`}>
                    <DataTableCell colSpan={5} style={{ background: "var(--aa-surface-soft)" }}>
                      {(ruleIssues[g.rule_id] || []).slice(0, 20).map((iss) => (
                        <div key={iss.id} style={{ padding: "3px 0", fontSize: 12, wordBreak: "break-all" }}>
                          {iss.url}
                        </div>
                      ))}
                      {(ruleIssues[g.rule_id] || []).length === 0 ? <p className={styles.muted} style={{ margin: 0, fontSize: 12 }}>Loading…</p> : null}
                      {(ruleIssues[g.rule_id] || [])[0]?.recommendation ? (
                        <p className={styles.muted} style={{ margin: "8px 0 0", fontSize: 12 }}>
                          {ruleIssues[g.rule_id][0].recommendation}
                        </p>
                      ) : null}
                    </DataTableCell>
                  </DataTableRow>
                ) : null}
              </Fragment>
            ))}
          </DataTableBody>
        </DataTable>
      )}
    </div>
  );
}

/* ── URL Explorer: server-paginated, filterable table ───────────────────── */

export function SeoAuditUrlExplorer({ projectId, auditId, styles }: { projectId: string; auditId: string; styles: CssModule }) {
  const [rows, setRows] = useState<SeoAuditUrlRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [indexability, setIndexability] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedUrlId, setSelectedUrlId] = useState<string | null>(null);
  const perPage = 25;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getSeoAuditUrls(projectId, auditId, { page, per_page: perPage, q: q || undefined, indexability: indexability || undefined })
      .then((res) => {
        if (cancelled) return;
        setRows(res.items || []);
        setTotal(res.total || 0);
      })
      .catch(() => {
        if (!cancelled) {
          setRows([]);
          setTotal(0);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, auditId, page, indexability]);

  const totalPages = Math.max(1, Math.ceil(total / perPage));

  return (
    <div className={`${styles.card} ${styles.cardWide}`}>
      <div className={styles.analyticsHeaderRow}>
        <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
          URL Explorer
        </h3>
        <div className={styles.segmentGroup} aria-label="Indexability filter">
          {(["", "indexable", "non_indexable", "blocked"] as const).map((v) => (
            <button
              key={v || "all"}
              type="button"
              className={styles.miniBtn}
              onClick={() => {
                setIndexability(v);
                setPage(1);
              }}
              aria-pressed={indexability === v}
            >
              {v === "" ? "All" : v === "indexable" ? "Indexable" : v === "non_indexable" ? "Non-indexable" : "Blocked"}
            </button>
          ))}
        </div>
      </div>
      <input
        className={styles.input}
        placeholder="Search URL or title…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setPage(1);
        }}
        style={{ marginBottom: 10 }}
      />
      {loading ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
          No URLs match this filter.
        </p>
      ) : (
        <DataTable>
          <DataTableHead>
            <DataTableRow>
              <DataTableHeaderCell>URL / Title</DataTableHeaderCell>
              <DataTableHeaderCell className="text-right">Words</DataTableHeaderCell>
              <DataTableHeaderCell className="text-right">Depth</DataTableHeaderCell>
              <DataTableHeaderCell>Indexable</DataTableHeaderCell>
              <DataTableHeaderCell>Status</DataTableHeaderCell>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {rows.map((r) => (
              <DataTableRow key={r.id} onClick={() => setSelectedUrlId(r.id)} style={{ cursor: "pointer" }}>
                <DataTableCell>
                  <div style={{ fontWeight: 600, fontSize: 12, wordBreak: "break-all" }}>{r.url}</div>
                  <div className={styles.muted} style={{ fontSize: 11, marginTop: 2 }}>
                    {r.title || "(no title)"}
                  </div>
                </DataTableCell>
                <DataTableCell className="text-right tabular-nums">{r.word_count ?? 0}</DataTableCell>
                <DataTableCell className="text-right tabular-nums">{r.crawl_depth}</DataTableCell>
                <DataTableCell>
                  <span className={statusPillClass(styles, indexabilityStatus(r.indexability))}>{indexabilityLabel(r.indexability)}</span>
                </DataTableCell>
                <DataTableCell>
                  <span className={statusPillClass(styles, r.status_code && r.status_code < 400 ? "good" : "poor")}>{r.status_code ?? "—"}</span>
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
      {totalPages > 1 ? (
        <div className={styles.analyticsHeaderRow} style={{ marginTop: 10 }}>
          <button type="button" className={styles.btnSecondary} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            Previous
          </button>
          <span className={styles.muted} style={{ fontSize: 12 }}>
            Page {page} of {totalPages} · {total.toLocaleString()} URLs
          </span>
          <button type="button" className={styles.btnSecondary} disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            Next
          </button>
        </div>
      ) : null}
      {selectedUrlId ? (
        <SeoAuditUrlDetailDrawer projectId={projectId} auditId={auditId} urlId={selectedUrlId} onClose={() => setSelectedUrlId(null)} styles={styles} />
      ) : null}
    </div>
  );
}

/* ── URL detail drawer: Overview + SEO + Links tabs, all real fields already
   stored by the crawler (title/meta/canonical/robots/h1/h2/word count/
   inlinks/outlinks). Headers/Content/Rendered tabs from the spec are omitted --
   no header capture, duplicate-hash, or rendering data exists yet (deferred,
   see the approved plan). Modal rather than a true slide-in drawer -- reuses
   the existing accessible .modalBackdrop/.modalPanel pattern already proven
   across the app instead of inventing a new drawer CSS family. ───────────── */

export function SeoAuditUrlDetailDrawer({
  projectId,
  auditId,
  urlId,
  onClose,
  styles,
}: {
  projectId: string;
  auditId: string;
  urlId: string;
  onClose: () => void;
  styles: CssModule;
}) {
  const [detail, setDetail] = useState<import("@/lib/api").SeoAuditUrlDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"overview" | "seo" | "links">("overview");
  const trapRef = useFocusTrap(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    api
      .getSeoAuditUrlDetail(projectId, auditId, urlId)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, auditId, urlId]);

  const url = detail?.url;

  return (
    <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="URL detail">
      <div ref={trapRef} className={styles.modalPanel} style={{ maxWidth: 640 }}>
        <div className={styles.modalHead}>
          <h3 className={styles.modalTitle} style={{ wordBreak: "break-all", fontSize: 14 }}>
            {url?.url || "Loading…"}
          </h3>
          <button type="button" className={styles.btnSecondary} onClick={onClose}>
            Close
          </button>
        </div>
        <div className={styles.modalBody}>
          {loading ? (
            <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
              Loading…
            </p>
          ) : !url ? (
            <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
              Could not load this URL's details.
            </p>
          ) : (
            <Tabs value={tab} onValueChange={(v) => setTab(v as "overview" | "seo" | "links")}>
              <TabsList aria-label="URL detail sections" className="mb-3">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="seo">SEO</TabsTrigger>
                <TabsTrigger value="links">Links</TabsTrigger>
              </TabsList>

              <TabsContent value="overview">
                <div className={styles.seoAuditDetailFieldList}>
                  <DetailField label="Status" value={url.status_code ? `${url.status_code} ${url.status_text || ""}`.trim() : "—"} />
                  <DetailField label="Indexability" value={`${url.indexability}${url.indexability_reason ? ` — ${url.indexability_reason}` : ""}`} />
                  <DetailField label="Crawl Depth" value={String(url.crawl_depth)} />
                  <DetailField label="Word Count" value={url.word_count?.toLocaleString() ?? "—"} />
                  <DetailField label="Response Time" value={url.response_time_ms ? `${url.response_time_ms}ms` : "—"} />
                  <DetailField label="Content Type" value={url.content_type || "—"} />
                  {url.redirect_url ? <DetailField label="Redirects to" value={url.redirect_url} /> : null}
                </div>
              </TabsContent>

              <TabsContent value="seo">
                <div className={styles.seoAuditDetailFieldList}>
                  <DetailField label="Title" value={url.title || "Missing"} sub={url.title_length ? `${url.title_length} characters` : undefined} />
                  <DetailField label="Meta Description" value={url.meta_description || "Missing"} sub={url.meta_description_length ? `${url.meta_description_length} characters` : undefined} />
                  <DetailField label="H1" value={url.h1 || "Missing"} sub={url.h1_count > 1 ? `${url.h1_count} H1 tags found` : undefined} />
                  <DetailField label="H2" value={url.h2 || "None"} sub={url.h2_count > 0 ? `${url.h2_count} H2 tags` : undefined} />
                  <DetailField label="Canonical" value={url.canonical || "Missing"} />
                  <DetailField label="Meta Robots" value={url.robots_meta || "Not set"} />
                </div>
              </TabsContent>

              <TabsContent value="links">
                <div className={styles.seoAuditDetailFieldList}>
                  <DetailField label="Internal Inlinks" value={String(detail.inlinks.length)} />
                  <DetailField label="Outlinks" value={String(detail.outlinks.length)} />
                  {detail.inlinks.length > 0 ? (
                    <div>
                      <span className={styles.muted} style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                        Linked from
                      </span>
                      <ul style={{ margin: "6px 0 0", paddingLeft: 0, listStyle: "none" }}>
                        {detail.inlinks.slice(0, 10).map((l, i) => (
                          <li key={i} style={{ fontSize: 12, wordBreak: "break-all", padding: "3px 0" }}>
                            {l.anchor_text ? `"${l.anchor_text}" — ` : ""}
                            {l.discovered_in}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailField({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ padding: "8px 0", borderBottom: "1px solid var(--aa-hairline)" }}>
      <div style={{ fontSize: 11, color: "var(--aa-on-dark-soft, #a09d96)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, wordBreak: "break-word" }}>{value}</div>
      {sub ? (
        <div style={{ fontSize: 11, color: "var(--aa-on-dark-soft, #a09d96)", marginTop: 2 }}>{sub}</div>
      ) : null}
    </div>
  );
}

/* ── Audit history list ─────────────────────────────────────────────────── */

export function SeoAuditHistoryList({
  history,
  selectedRunId,
  onSelectRun,
  styles,
}: {
  history: SeoAuditRun[];
  selectedRunId: string | null;
  onSelectRun: (id: string | null) => void;
  styles: CssModule;
}) {
  const completed = history.filter((r) => r.status === "completed" || r.status === "partial");
  if (completed.length === 0) return null;
  return (
    <div className={`${styles.card} ${styles.cardWide}`}>
      <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
        Audit History
      </h3>
      <p className={styles.muted} style={{ margin: "-4px 0 8px", fontSize: 11 }}>
        Every crawl run for this project — click to open the full snapshot.
      </p>
      <ul className={styles.siteAuditHistoryList}>
        {completed.map((run) => {
          const isSelected = selectedRunId === run.id;
          const st = scoreStatus(run.health_score?.overall ?? null);
          return (
            <li key={run.id}>
              <button
                type="button"
                className={styles.siteAuditHistoryRow}
                onClick={() => onSelectRun(isSelected ? null : run.id)}
                aria-current={isSelected ? "true" : undefined}
              >
                <span className={styles.siteAuditBreakdownDot} data-status={st || "unknown"} aria-hidden="true" />
                <span className={styles.siteAuditHistoryDate}>{formatSiteAuditTimestamp(run.completed_at || run.started_at)}</span>
                <span className={styles.siteAuditHistoryScores}>
                  <span className={styles.muted}>Score</span> {run.health_score?.overall ?? "—"}
                  <span className={styles.muted} style={{ marginLeft: 10 }}>
                    URLs
                  </span>{" "}
                  {run.counts.fetched}
                </span>
                <span className={styles.siteAuditHistoryChevron} aria-hidden="true">
                  {isSelected ? "▾" : "›"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
