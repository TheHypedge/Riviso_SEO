"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TechnicalAuditRun, TechnicalAuditStrategyResult } from "@/lib/api";

type CssModule = { [key: string]: string };
type Strategy = "mobile" | "desktop";

export function formatSiteAuditTimestamp(iso: string | null | undefined): string {
  if (!iso) return "Not available";
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return "Not available";
  return (
    d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) +
    " • " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  );
}

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const CWV_LABELS: Record<string, string> = {
  lcp: "Largest Contentful Paint",
  inp: "Interaction to Next Paint",
  cls: "Cumulative Layout Shift",
  fcp: "First Contentful Paint",
  speed_index: "Speed Index",
  tbt: "Total Blocking Time",
  ttfb: "Time to First Byte",
};
const PRIMARY_CWV = ["lcp", "inp", "cls", "fcp"];
const SUPPORTING_CWV = ["speed_index", "tbt", "ttfb"];

/**
 * Google's own published Core Web Vitals thresholds (not a Riviso-invented scale) --
 * centralized here once so no component duplicates a magic number. Units match each
 * metric's `numeric_value` from pagespeed_client.py (ms for time-based metrics, a
 * unitless score for CLS). Source: web.dev/articles/defining-core-web-vitals-thresholds.
 */
const CWV_THRESHOLDS: Record<string, { good: number; poor: number; unit: "ms" | "s" | "score" }> = {
  lcp: { good: 2500, poor: 4000, unit: "ms" },
  inp: { good: 200, poor: 500, unit: "ms" },
  cls: { good: 0.1, poor: 0.25, unit: "score" },
  fcp: { good: 1800, poor: 3000, unit: "ms" },
};

const ICON_STROKE = { fill: "none" as const, stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function CategoryIcon({ category }: { category: string }) {
  switch (category) {
    case "performance":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 20a8 8 0 1 0-8-8" {...ICON_STROKE} />
          <path d="M12 12l4-5" {...ICON_STROKE} />
          <path d="M12 4v1.5M4 12H2.5M21.5 12H20" {...ICON_STROKE} />
        </svg>
      );
    case "accessibility":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="5" r="1.6" {...ICON_STROKE} />
          <path d="M5 8.5c2.3.9 4.6 1.3 7 1.3s4.7-.4 7-1.3" {...ICON_STROKE} />
          <path d="M12 9.8V14M12 14l-3 6.5M12 14l3 6.5" {...ICON_STROKE} />
        </svg>
      );
    case "best_practices":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2l8 3.5v5.5c0 5-3.4 8.9-8 11-4.6-2.1-8-6-8-11V5.5L12 2z" {...ICON_STROKE} />
          <path d="M9 12.5l2 2 4-4.5" {...ICON_STROKE} />
        </svg>
      );
    case "pagespeed_seo":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" {...ICON_STROKE} />
          <path d="M20 20l-4.8-4.8" {...ICON_STROKE} />
        </svg>
      );
    default:
      return null;
  }
}

function statusPillClass(styles: CssModule, status: string | null | undefined): string {
  if (status === "good") return `${styles.statusPill} ${styles.statusPublished}`;
  if (status === "needs_improvement") return `${styles.statusPill} ${styles.statusDraft}`;
  if (status === "poor") return `${styles.statusPill} ${styles.statusPending}`;
  return `${styles.statusPill} ${styles.statusNeutral}`;
}

function statusLabel(status: string | null | undefined): string {
  if (status === "good") return "Good";
  if (status === "needs_improvement") return "Needs Improvement";
  if (status === "poor") return "Poor";
  return "Unknown";
}

function scoreStatus(score: number | null): "good" | "needs_improvement" | "poor" | null {
  if (score === null || score === undefined) return null;
  if (score >= 90) return "good";
  if (score >= 50) return "needs_improvement";
  return "poor";
}

/**
 * Deterministic composite of Performance + Accessibility + Best Practices (never PageSpeed
 * SEO, kept out so this stays a *technical* health read, not a blended technical/SEO number).
 * Explicitly labeled "Riviso Technical Health Score" wherever shown, per
 * SITE-AUDIT-GUIDE.md §24: a Riviso-derived score is fine as long as it's computed from real
 * PageSpeed data (never random/hardcoded) and the underlying Google scores stay visible.
 */
function technicalHealthScore(result: TechnicalAuditStrategyResult | null | undefined): number | null {
  if (!result) return null;
  const parts = [result.scores.performance, result.scores.accessibility, result.scores.best_practices].filter(
    (v): v is number => typeof v === "number",
  );
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
}

const CATEGORY_LABELS: Record<string, string> = {
  performance: "Performance",
  accessibility: "Accessibility",
  best_practices: "Best Practices",
  pagespeed_seo: "PageSpeed SEO",
};

/**
 * Deterministic, real-data-derived contextual message: identifies the lowest-scoring
 * category (ties broken by the order above) and, where a findings list exists for it,
 * names up to two real finding titles from that list -- never invented copy.
 */
function buildHealthMessage(result: TechnicalAuditStrategyResult, health: number | null): string {
  const entries: Array<{ key: string; value: number | null }> = [
    { key: "performance", value: result.scores.performance },
    { key: "accessibility", value: result.scores.accessibility },
    { key: "best_practices", value: result.scores.best_practices },
  ];
  const scored = entries.filter((e): e is { key: string; value: number } => typeof e.value === "number");
  if (scored.length === 0) return "Run a Technical Audit to see a health summary for this page.";

  const weakest = scored.reduce((a, b) => (b.value < a.value ? b : a));
  if (health !== null && health >= 90) {
    return "Great job! Your site is performing well. Keep an eye on Core Web Vitals as content and traffic grow.";
  }

  const findings = weakest.key === "performance" ? result.opportunities : weakest.key === "accessibility" ? result.accessibility_failures : result.best_practices_failures;
  const names = findings
    .map((f) => f.title)
    .filter((t): t is string => Boolean(t))
    .slice(0, 2);
  const label = CATEGORY_LABELS[weakest.key] || weakest.key;
  const severity = weakest.value < 50 ? "requires attention" : "has room to improve";

  if (names.length > 0) {
    return `${label} ${severity}. The primary opportunities are related to ${names.join(" and ")}.`;
  }
  return `${label} ${severity}. Review the ${label.toLowerCase()} findings below for details.`;
}

/* ── Score gauge (270° arc) ─────────────────────────────────────────────── */

export function ScoreGauge({
  score,
  size = 148,
  strokeWidth = 12,
  styles,
}: {
  score: number | null;
  size?: number;
  strokeWidth?: number;
  styles?: CssModule;
}) {
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const arcFraction = 0.75; // 270 of 360 degrees; gap sits at the bottom
  const arcLength = circumference * arcFraction;
  const clamped = score === null ? 0 : Math.max(0, Math.min(100, score));
  const filled = (clamped / 100) * arcLength;
  const status = scoreStatus(score);
  const colorVar =
    status === "good" ? "var(--aa-success, #5db872)" : status === "needs_improvement" ? "var(--aa-warning, #d4a017)" : status === "poor" ? "var(--aa-error, #c64545)" : "var(--aa-on-dark-soft, #a09d96)";

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Score ${score === null ? "not available" : Math.round(score) + " out of 100"}`}>
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke="var(--aa-hairline, rgba(255,255,255,0.1))"
        strokeWidth={strokeWidth}
        strokeDasharray={`${arcLength} ${circumference - arcLength}`}
        strokeLinecap="round"
        transform={`rotate(135 ${cx} ${cy})`}
      />
      {score !== null ? (
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={colorVar}
          strokeWidth={strokeWidth}
          strokeDasharray={`${filled} ${circumference - filled}`}
          strokeLinecap="round"
          transform={`rotate(135 ${cx} ${cy})`}
          className={styles?.siteAuditGaugeArc}
        />
      ) : null}
      <text x={cx} y={cy - 2} textAnchor="middle" fontSize={size * 0.26} fontWeight={700} fill="var(--aa-on-dark, #faf9f5)">
        {score === null ? "—" : Math.round(score)}
      </text>
      <text x={cx} y={cy + size * 0.13} textAnchor="middle" fontSize={size * 0.08} fill="var(--aa-on-dark-soft, #a09d96)">
        / 100
      </text>
    </svg>
  );
}

/* ── Running-state checklist: illustrative staged progress, not a claim of real
   per-stage backend status (mobile + desktop run concurrently server-side, so
   there's no genuine per-stage signal to bind to). Advances on a fixed timer so the
   page never sits on an empty/blank state while PSI's 20-45s round trip is in flight. */

const RUN_STAGES = ["Validating website", "Connecting to PageSpeed Insights", "Running mobile analysis", "Running desktop analysis"];

export function SiteAuditRunChecklist({ styles }: { styles: CssModule }) {
  const [stageIndex, setStageIndex] = useState(0);
  useEffect(() => {
    setStageIndex(0);
    const id = setInterval(() => {
      setStageIndex((i) => Math.min(i + 1, RUN_STAGES.length - 1));
    }, 4000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className={styles.siteAuditRunChecklist} role="status" aria-label="Running Technical Audit">
      {RUN_STAGES.map((label, i) => {
        const state = i < stageIndex ? "done" : i === stageIndex ? "active" : "pending";
        return (
          <div key={label} className={styles.siteAuditRunChecklistItem} data-state={state}>
            <span className={styles.siteAuditRunChecklistMark} aria-hidden="true">
              {state === "done" ? "✓" : state === "active" ? <span className={styles.siteAuditBtnSpinner} /> : "○"}
            </span>
            {label}
          </div>
        );
      })}
    </div>
  );
}

/* ── Summary: gauge + category breakdown + delta vs previous audit ─────── */

export function TechnicalAuditSummary({
  audit,
  previousAudit,
  strategy,
  styles,
}: {
  audit: TechnicalAuditRun;
  previousAudit: TechnicalAuditRun | null;
  strategy: Strategy;
  styles: CssModule;
}) {
  const result = strategy === "mobile" ? audit.mobile : audit.desktop;
  const health = technicalHealthScore(result);
  const status = scoreStatus(health);
  const prevResult = previousAudit ? (strategy === "mobile" ? previousAudit.mobile : previousAudit.desktop) : null;
  const prevHealth = technicalHealthScore(prevResult);
  const delta = health !== null && prevHealth !== null ? health - prevHealth : null;

  const scoreEntries: Array<{ key: string; label: string; value: number | null }> = [
    { key: "performance", label: "Performance", value: result.scores.performance },
    { key: "accessibility", label: "Accessibility", value: result.scores.accessibility },
    { key: "best_practices", label: "Best Practices", value: result.scores.best_practices },
    { key: "pagespeed_seo", label: "PageSpeed SEO", value: result.scores.pagespeed_seo },
  ];
  const message = buildHealthMessage(result, health);

  return (
    <div className={`${styles.card} ${styles.cardWide} ${styles.siteAuditSummaryCard}`}>
      <div className={styles.siteAuditSummaryGauge}>
        <ScoreGauge score={health} styles={styles} />
        <span className={styles.siteAuditGaugeCaption}>Overall Site Health</span>
        {status ? <span className={statusPillClass(styles, status)}>{statusLabel(status)}</span> : null}
        {delta !== null && delta !== 0 ? (
          <span className={delta > 0 ? styles.siteAuditDeltaUp : styles.siteAuditDeltaDown}>
            {delta > 0 ? "▲" : "▼"} {Math.abs(delta)} vs previous audit
          </span>
        ) : delta === 0 ? (
          <span className={styles.muted} style={{ fontSize: 12 }}>
            No change vs previous audit
          </span>
        ) : null}
      </div>
      <div className={styles.siteAuditCategoryGrid}>
        {scoreEntries.map((s) => {
          const st = scoreStatus(s.value);
          return (
            <div key={s.key} className={styles.siteAuditCategoryCard}>
              <span className={styles.siteAuditCategoryIcon} data-status={st || "unknown"} aria-hidden="true">
                <CategoryIcon category={s.key} />
              </span>
              <span className={styles.siteAuditCategoryLabel}>{s.label}</span>
              <span className={styles.siteAuditCategoryValue}>
                {s.value === null ? "—" : s.value}
                <span className={styles.siteAuditCategoryValueUnit}>/100</span>
              </span>
              {st ? <span className={statusPillClass(styles, st)}>{statusLabel(st)}</span> : null}
            </div>
          );
        })}
      </div>
      <div className={styles.siteAuditHealthMessage}>
        <p style={{ margin: 0, fontSize: 13 }}>{message}</p>
        <p className={styles.muted} style={{ margin: "4px 0 0", fontSize: 11 }}>
          PageSpeed SEO is a Lighthouse category, not Riviso&rsquo;s SEO Audit.
        </p>
      </div>
    </div>
  );
}

/* ── Trend chart: Mobile vs Desktop Performance over audit history ─────── */

type RangeKey = "7d" | "30d" | "3m" | "6m" | "1y" | "all";
const RANGE_DAYS: Record<RangeKey, number | null> = { "7d": 7, "30d": 30, "3m": 90, "6m": 180, "1y": 365, all: null };

function parseAuditDate(iso: string): number {
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
  return new Date(normalized).getTime();
}

export function TechnicalAuditTrendChart({ history, styles }: { history: TechnicalAuditRun[]; styles: CssModule }) {
  const gradId = useId().replace(/:/g, "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<RangeKey>("30d");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; transform: string } | null>(null);

  // history arrives newest-first; the chart reads oldest-to-newest, filtered to the selected range.
  const points = useMemo(() => {
    const days = RANGE_DAYS[range];
    const cutoff = days ? Date.now() - days * 86400000 : null;
    return [...history]
      .filter((r) => !cutoff || parseAuditDate(r.created_at) >= cutoff)
      .sort((a, b) => parseAuditDate(a.created_at) - parseAuditDate(b.created_at));
  }, [history, range]);

  const W = 700;
  const H = 220;
  const padL = 36;
  const padR = 16;
  const padT = 20;
  const padB = 32;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const xForIndex = useCallback((i: number, n: number) => (n <= 1 ? padL + innerW / 2 : padL + (innerW * i) / (n - 1)), [innerW]);
  const yForScore = useCallback((v: number) => padT + innerH - (innerH * v) / 100, [innerH]);

  const series = useMemo(() => {
    const n = points.length;
    const mobile = points.map((p, i) => ({ x: xForIndex(i, n), y: yForScore(p.mobile.scores.performance ?? 0), v: p.mobile.scores.performance }));
    const desktop = points.map((p, i) => ({ x: xForIndex(i, n), y: yForScore(p.desktop.scores.performance ?? 0), v: p.desktop.scores.performance }));
    return { mobile, desktop };
  }, [points, xForIndex, yForScore]);

  const linePath = (pts: { x: number; y: number }[]) => (pts.length ? `M ${pts.map((p) => `${p.x} ${p.y}`).join(" L ")}` : "");

  const showTooltip = useCallback((index: number, clientX: number, clientY: number) => {
    const tipW = 180;
    const pad = 12;
    const clampedX = typeof window !== "undefined" ? Math.min(Math.max(clientX, tipW / 2 + pad), window.innerWidth - tipW / 2 - pad) : clientX;
    setHoverIndex(index);
    setTooltip({ x: clampedX, y: clientY, transform: "translate(-50%, calc(-100% - 12px))" });
  }, []);
  const hideTooltip = useCallback(() => {
    setHoverIndex(null);
    setTooltip(null);
  }, []);

  const hoverPoint = hoverIndex !== null ? points[hoverIndex] : null;
  const yTicks = [0, 25, 50, 75, 100];
  const colWidth = points.length > 1 ? innerW / (points.length - 1) : innerW;

  const tooltipEl =
    tooltip && hoverPoint ? (
      <div
        role="tooltip"
        style={{ position: "fixed", left: tooltip.x, top: tooltip.y, transform: tooltip.transform, zIndex: 10000 }}
        className={styles.siteAuditChartTooltip}
      >
        <div className={styles.siteAuditChartTooltipDate}>{formatSiteAuditTimestamp(hoverPoint.created_at)}</div>
        <div className={styles.siteAuditChartTooltipRow}>
          <span className={styles.siteAuditChartTooltipSwatch} style={{ background: "var(--aa-info, #7090c8)" }} />
          Mobile <strong>{hoverPoint.mobile.scores.performance ?? "—"}</strong>
        </div>
        <div className={styles.siteAuditChartTooltipRow}>
          <span className={styles.siteAuditChartTooltipSwatch} style={{ background: "var(--aa-success, #5db872)" }} />
          Desktop <strong>{hoverPoint.desktop.scores.performance ?? "—"}</strong>
        </div>
      </div>
    ) : null;

  return (
    <div className={`${styles.card} ${styles.cardWide}`}>
      <div className={styles.analyticsHeaderRow}>
        <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
          Technical Performance Trend
        </h3>
        {points.length > 1 ? (
          <div className={styles.segmentGroup} aria-label="Date range">
            {(["7d", "30d", "3m", "6m", "1y", "all"] as const).map((r) => (
              <button key={r} type="button" className={styles.miniBtn} onClick={() => setRange(r)} aria-pressed={range === r}>
                {r === "all" ? "All" : r.toUpperCase()}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {points.length < 2 ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
          Run a few more audits to see your performance trend over time.
        </p>
      ) : (
        <>
          <ul className={styles.siteAuditChartLegend} aria-hidden="true">
            <li>
              <span className={styles.siteAuditChartLegendSwatch} style={{ background: "var(--aa-info, #7090c8)" }} /> Mobile
            </li>
            <li>
              <span className={styles.siteAuditChartLegendSwatch} style={{ background: "var(--aa-success, #5db872)" }} /> Desktop
            </li>
          </ul>
          <div ref={wrapRef}>
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Mobile and desktop performance score trend" onMouseLeave={hideTooltip}>
              {yTicks.map((tick) => (
                <g key={tick}>
                  <line x1={padL} y1={yForScore(tick)} x2={W - padR} y2={yForScore(tick)} stroke="var(--aa-hairline)" strokeDasharray="4 6" />
                  <text x={padL - 8} y={yForScore(tick) + 4} textAnchor="end" fontSize={10} fill="var(--aa-muted)">
                    {tick}
                  </text>
                </g>
              ))}
              {hoverIndex !== null ? (
                <line x1={xForIndex(hoverIndex, points.length)} y1={padT} x2={xForIndex(hoverIndex, points.length)} y2={padT + innerH} stroke="var(--aa-hairline)" />
              ) : null}
              <path d={linePath(series.desktop)} fill="none" stroke="var(--aa-success, #5db872)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              <path d={linePath(series.mobile)} fill="none" stroke="var(--aa-info, #7090c8)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              {hoverIndex !== null ? (
                <>
                  <circle cx={series.mobile[hoverIndex]?.x} cy={series.mobile[hoverIndex]?.y} r={3.5} fill="var(--aa-info, #7090c8)" stroke="var(--aa-surface-card)" strokeWidth={1.5} />
                  <circle cx={series.desktop[hoverIndex]?.x} cy={series.desktop[hoverIndex]?.y} r={3.5} fill="var(--aa-success, #5db872)" stroke="var(--aa-surface-card)" strokeWidth={1.5} />
                </>
              ) : null}
              {points.map((p, i) => (
                <rect
                  key={p.id}
                  x={padL + colWidth * (i - 0.5)}
                  y={padT}
                  width={colWidth}
                  height={innerH}
                  fill="transparent"
                  onMouseMove={(e) => showTooltip(i, e.clientX, e.clientY)}
                  onFocus={() => showTooltip(i, xForIndex(i, points.length), padT + innerH / 2)}
                  onBlur={hideTooltip}
                  tabIndex={0}
                  role="presentation"
                />
              ))}
              {points.map((p, i) =>
                i === 0 || i === points.length - 1 || i % Math.max(1, Math.floor(points.length / 5)) === 0 ? (
                  <text key={`lbl-${p.id}`} x={xForIndex(i, points.length)} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--aa-muted)">
                    {formatShortDate(p.created_at)}
                  </text>
                ) : null,
              )}
            </svg>
          </div>
        </>
      )}
      {typeof document !== "undefined" && tooltipEl ? createPortal(tooltipEl, document.body) : null}
    </div>
  );
}

/* ── CWV metric threshold bar: Good | Needs Improvement | Poor, from Google's own
   published cutoffs (CWV_THRESHOLDS above) -- never a Riviso-invented scale. ─── */

function MetricThresholdBar({ metricKey, numericValue, styles }: { metricKey: string; numericValue: number | null | undefined; styles: CssModule }) {
  const t = CWV_THRESHOLDS[metricKey];
  if (!t || numericValue === null || numericValue === undefined) return null;
  // Map value -> 0-100% position. Scale each third of the bar to one band so the
  // marker stays legible even when poor values are many multiples of the good cutoff.
  const pct =
    numericValue <= t.good
      ? (numericValue / t.good) * 33.33
      : numericValue <= t.poor
        ? 33.33 + ((numericValue - t.good) / (t.poor - t.good)) * 33.33
        : Math.min(100, 66.67 + ((numericValue - t.poor) / t.poor) * 33.33);
  return (
    <div className={styles.siteAuditThresholdBar} aria-hidden="true">
      <div className={styles.siteAuditThresholdBarTrack}>
        <span className={styles.siteAuditThresholdBarMarker} style={{ left: `${Math.max(1, Math.min(99, pct))}%` }} />
      </div>
      <div className={styles.siteAuditThresholdBarLabels}>
        <span>Good</span>
        <span>Needs Improvement</span>
        <span>Poor</span>
      </div>
    </div>
  );
}

/* ── Audit history list ─────────────────────────────────────────────────── */

export function TechnicalAuditHistoryList({
  history,
  selectedRunId,
  onSelectRun,
  styles,
}: {
  history: TechnicalAuditRun[];
  selectedRunId: string | null;
  onSelectRun: (id: string | null) => void;
  styles: CssModule;
}) {
  if (history.length === 0) return null;
  return (
    <div className={`${styles.card} ${styles.cardWide}`}>
      <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
        Audit History
      </h3>
      <ul className={styles.siteAuditHistoryList}>
        {history.map((run) => {
          const isSelected = selectedRunId === run.id;
          const health = technicalHealthScore(run.mobile);
          const status = scoreStatus(health);
          return (
            <li key={run.id}>
              <button
                type="button"
                className={styles.siteAuditHistoryRow}
                onClick={() => onSelectRun(isSelected ? null : run.id)}
                aria-current={isSelected ? "true" : undefined}
              >
                <span className={styles.siteAuditBreakdownDot} data-status={status || "unknown"} aria-hidden="true" />
                <span className={styles.siteAuditHistoryDate}>{formatSiteAuditTimestamp(run.created_at)}</span>
                <span className={styles.siteAuditHistoryScores}>
                  <span className={styles.muted}>Mobile</span> {run.mobile.scores.performance ?? "—"}
                  <span className={styles.muted} style={{ marginLeft: 10 }}>
                    Desktop
                  </span>{" "}
                  {run.desktop.scores.performance ?? "—"}
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

/* ── Detail: CWV, opportunities, diagnostics, accessibility for one run ── */

export function TechnicalAuditResults({
  audit,
  strategy,
  onStrategyChange,
  styles,
}: {
  audit: TechnicalAuditRun;
  strategy: Strategy;
  onStrategyChange: (s: Strategy) => void;
  styles: CssModule;
}) {
  const result: TechnicalAuditStrategyResult = strategy === "mobile" ? audit.mobile : audit.desktop;
  const [expandedOpportunity, setExpandedOpportunity] = useState<string | null>(null);
  const [expandedDiagnostic, setExpandedDiagnostic] = useState<string | null>(null);
  const [showAllOpportunities, setShowAllOpportunities] = useState(false);
  const [showAllDiagnostics, setShowAllDiagnostics] = useState(false);
  const ACTION_CENTER_CAP = 5;
  const visibleOpportunities = showAllOpportunities ? result.opportunities : result.opportunities.slice(0, ACTION_CENTER_CAP);
  const visibleDiagnostics = showAllDiagnostics ? result.diagnostics : result.diagnostics.slice(0, ACTION_CENTER_CAP);

  return (
    <>
      <div className={`${styles.card} ${styles.cardWide}`}>
        <div className={styles.analyticsHeaderRow}>
          <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
            Core Web Vitals
          </h3>
          <div className={styles.segmentGroup} aria-label="Device">
            {(["mobile", "desktop"] as const).map((st) => (
              <button key={st} type="button" className={styles.miniBtn} onClick={() => onStrategyChange(st)} aria-pressed={strategy === st}>
                {st === "mobile" ? "Mobile" : "Desktop"}
              </button>
            ))}
          </div>
        </div>
        {Object.keys(result.core_web_vitals).length === 0 ? (
          <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
            PageSpeed Insights did not return Core Web Vitals data for this page.
          </p>
        ) : (
          <>
            <div className={styles.siteAuditCwvGrid}>
              {PRIMARY_CWV.filter((k) => result.core_web_vitals[k]).map((k) => {
                const cwv = result.core_web_vitals[k];
                return (
                  <div key={k} className={styles.siteAuditScoreTile}>
                    <span className={styles.siteAuditScoreLabel}>{CWV_LABELS[k] || k}</span>
                    <span className={styles.siteAuditScoreValue} style={{ fontSize: 22 }}>
                      {cwv.display_value || "—"}
                    </span>
                    <span className={statusPillClass(styles, cwv.status)}>{statusLabel(cwv.status)}</span>
                    <MetricThresholdBar metricKey={k} numericValue={cwv.numeric_value} styles={styles} />
                  </div>
                );
              })}
            </div>
            {SUPPORTING_CWV.some((k) => result.core_web_vitals[k]) ? (
              <div className={styles.siteAuditSupportingRow}>
                {SUPPORTING_CWV.filter((k) => result.core_web_vitals[k]).map((k) => {
                  const cwv = result.core_web_vitals[k];
                  return (
                    <div key={k} className={styles.siteAuditSupportingItem}>
                      <span className={styles.muted} style={{ fontSize: 11 }}>
                        {CWV_LABELS[k] || k}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{cwv.display_value || "—"}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </>
        )}
      </div>

      {result.opportunities.length > 0 || result.diagnostics.length > 0 ? (
        <div className={styles.siteAuditActionCenter}>
          {result.opportunities.length > 0 ? (
            <div className={`${styles.card}`}>
              <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
                Top Opportunities
              </h3>
              <div className={styles.siteAuditFindingList}>
                {visibleOpportunities.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={styles.siteAuditFindingRow}
                    onClick={() => setExpandedOpportunity(expandedOpportunity === o.id ? null : o.id)}
                    aria-expanded={expandedOpportunity === o.id}
                  >
                    <div className={styles.siteAuditFindingHead}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{o.title}</span>
                      {o.display_value ? (
                        <span className={styles.muted} style={{ fontSize: 12 }}>
                          {o.display_value}
                        </span>
                      ) : null}
                    </div>
                    {expandedOpportunity === o.id ? (
                      <div className={styles.siteAuditFindingBody}>
                        {o.description ? <p style={{ margin: "6px 0 0", fontSize: 12 }}>{o.description}</p> : null}
                        {typeof o.affected_resources === "number" && o.affected_resources > 0 ? (
                          <p className={styles.muted} style={{ margin: "4px 0 0", fontSize: 12 }}>
                            {o.affected_resources} affected resource{o.affected_resources === 1 ? "" : "s"}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </button>
                ))}
              </div>
              {result.opportunities.length > ACTION_CENTER_CAP ? (
                <button type="button" className={styles.siteAuditViewAllBtn} onClick={() => setShowAllOpportunities((v) => !v)}>
                  {showAllOpportunities ? "Show fewer" : `View all ${result.opportunities.length}`}
                </button>
              ) : null}
            </div>
          ) : null}

          {result.diagnostics.length > 0 ? (
            <div className={`${styles.card}`}>
              <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
                Diagnostics
              </h3>
              <div className={styles.siteAuditFindingList}>
                {visibleDiagnostics.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className={styles.siteAuditFindingRow}
                    onClick={() => setExpandedDiagnostic(expandedDiagnostic === d.id ? null : d.id)}
                    aria-expanded={expandedDiagnostic === d.id}
                  >
                    <div className={styles.siteAuditFindingHead}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{d.title}</span>
                      {d.display_value ? (
                        <span className={styles.muted} style={{ fontSize: 12 }}>
                          {d.display_value}
                        </span>
                      ) : null}
                    </div>
                    {expandedDiagnostic === d.id && d.description ? (
                      <div className={styles.siteAuditFindingBody}>
                        <p style={{ margin: "6px 0 0", fontSize: 12 }}>{d.description}</p>
                      </div>
                    ) : null}
                  </button>
                ))}
              </div>
              {result.diagnostics.length > ACTION_CENTER_CAP ? (
                <button type="button" className={styles.siteAuditViewAllBtn} onClick={() => setShowAllDiagnostics((v) => !v)}>
                  {showAllDiagnostics ? "Show fewer" : `View all ${result.diagnostics.length}`}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {result.accessibility_failures.length > 0 || result.best_practices_failures.length > 0 || result.accessibility_summary || result.best_practices_summary ? (
        <div className={`${styles.card} ${styles.cardWide}`}>
          <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
            Accessibility &amp; Best Practices
          </h3>
          {result.accessibility_summary ? (
            <div className={styles.siteAuditSummaryChips} aria-label="Accessibility check results">
              <span className={styles.siteAuditSummaryChip} data-status="good">
                <span className={styles.siteAuditBreakdownDot} data-status="good" aria-hidden="true" /> Passed {result.accessibility_summary.passed}
              </span>
              <span className={styles.siteAuditSummaryChip} data-status="needs_improvement">
                <span className={styles.siteAuditBreakdownDot} data-status="needs_improvement" aria-hidden="true" /> Warnings {result.accessibility_summary.warnings}
              </span>
              <span className={styles.siteAuditSummaryChip} data-status="poor">
                <span className={styles.siteAuditBreakdownDot} data-status="poor" aria-hidden="true" /> Failed {result.accessibility_summary.failed}
              </span>
            </div>
          ) : null}
          {result.accessibility_failures.length === 0 && result.best_practices_failures.length === 0 ? (
            <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
              No additional diagnostics require attention.
            </p>
          ) : (
            <div className={styles.siteAuditFindingList}>
              {[...result.accessibility_failures, ...result.best_practices_failures].map((f) => (
                <div key={f.id} className={styles.siteAuditFindingRowStatic}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{f.title}</span>
                  {f.description ? (
                    <p className={styles.muted} style={{ margin: "4px 0 0", fontSize: 12 }}>
                      {f.description}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}

/* ── Bottom insight banner: rotating, evidence-based performance facts ──── */

const INSIGHT_FACTS: Array<{ title: string; body: string; href: string; hrefLabel: string }> = [
  {
    title: "Did you know?",
    body: "Google's Core Web Vitals use a 75th-percentile threshold: a page only passes LCP, INP, and CLS if at least 75% of real-user visits meet the “good” cutoff.",
    href: "https://web.dev/articles/defining-core-web-vitals-thresholds",
    hrefLabel: "View Performance Guide",
  },
  {
    title: "Did you know?",
    body: "Largest Contentful Paint (LCP) measures how quickly the largest visible element renders — Google's “good” threshold is 2.5 seconds or less.",
    href: "https://web.dev/articles/lcp",
    hrefLabel: "View Performance Guide",
  },
  {
    title: "Did you know?",
    body: "Interaction to Next Paint (INP) replaced First Input Delay as a Core Web Vital in 2024 — it measures responsiveness across a page's entire lifespan, not just the first interaction.",
    href: "https://web.dev/articles/inp",
    hrefLabel: "View Performance Guide",
  },
];

export function SiteAuditInsightBanner({ styles, seed }: { styles: CssModule; seed?: string }) {
  const index = useMemo(() => {
    if (!seed) return 0;
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return h % INSIGHT_FACTS.length;
  }, [seed]);
  const fact = INSIGHT_FACTS[index];
  return (
    <div className={styles.siteAuditInsightBanner}>
      <div className={styles.siteAuditInsightIcon} aria-hidden="true">
        💡
      </div>
      <div className={styles.siteAuditInsightBody}>
        <strong>{fact.title}</strong>
        <p style={{ margin: "2px 0 0", fontSize: 13 }}>{fact.body}</p>
      </div>
      <a href={fact.href} target="_blank" rel="noreferrer" className={styles.siteAuditInsightLink}>
        {fact.hrefLabel} →
      </a>
    </div>
  );
}
