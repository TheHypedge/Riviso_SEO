/**
 * Pure view logic for the Technical Audit screen. No React, no fetching -- every value is
 * read from a stored PageSpeed Insights result or is arithmetic on it.
 */
import type {
  TechnicalAuditCwvEntry,
  TechnicalAuditField,
  TechnicalAuditFieldMetric,
  TechnicalAuditFinding,
  TechnicalAuditIndexEntry,
  TechnicalAuditOpportunity,
  TechnicalAuditStrategyResult,
} from "./api";

export type Strategy = "mobile" | "desktop";
export type Status = "good" | "needs_improvement" | "poor";
export type ScoreKey = keyof TechnicalAuditStrategyResult["scores"];
export type MetricKey = "lcp" | "inp" | "cls" | "fcp" | "speed_index" | "tbt" | "ttfb";

/** Lighthouse's own category score bands: 90-100 good, 50-89 needs improvement, 0-49 poor.
 * Source: https://developer.chrome.com/docs/lighthouse/performance/performance-scoring */
export function scoreStatus(score: number | null | undefined): Status | null {
  if (score === null || score === undefined) return null;
  if (score >= 90) return "good";
  if (score >= 50) return "needs_improvement";
  return "poor";
}

export function statusLabel(status: string | null | undefined): string {
  if (status === "good") return "Good";
  if (status === "needs_improvement") return "Needs Improvement";
  if (status === "poor") return "Poor";
  return "Unknown";
}

/**
 * Riviso Technical Health Score: mean of Performance, Accessibility and Best Practices.
 * PageSpeed SEO is deliberately excluded. Do not change this formula.
 */
export function technicalHealthScore(result: TechnicalAuditStrategyResult | null | undefined): number | null {
  if (!result?.scores) return null;
  const parts = [result.scores.performance, result.scores.accessibility, result.scores.best_practices].filter(
    (v): v is number => typeof v === "number",
  );
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
}

export const SCORE_LABELS: Record<ScoreKey, string> = {
  performance: "Performance",
  accessibility: "Accessibility",
  best_practices: "Best Practices",
  pagespeed_seo: "PageSpeed SEO",
};

export const METRIC_LABELS: Record<MetricKey, string> = {
  lcp: "Largest Contentful Paint",
  inp: "Interaction to Next Paint",
  cls: "Cumulative Layout Shift",
  fcp: "First Contentful Paint",
  speed_index: "Speed Index",
  tbt: "Total Blocking Time",
  ttfb: "Time to First Byte",
};

export const METRIC_SHORT: Record<MetricKey, string> = {
  lcp: "LCP",
  inp: "INP",
  cls: "CLS",
  fcp: "FCP",
  speed_index: "Speed Index",
  tbt: "TBT",
  ttfb: "TTFB",
};

/** Google's Core Web Vitals (FCP is not one). */
export const CORE_WEB_VITALS: MetricKey[] = ["lcp", "inp", "cls"];

/**
 * Published "good" / "poor" limits, in the unit of each metric's `numeric_value` (ms, or a
 * unitless score for CLS). Only documented values live here; TBT and Speed Index are
 * intentionally absent until verified (they fall back to Lighthouse's own score band).
 * - LCP, INP, CLS, FCP: https://web.dev/articles/defining-core-web-vitals-thresholds, https://web.dev/articles/fcp
 * - TTFB: https://web.dev/articles/ttfb (good <= 0.8 s, poor > 1.8 s)
 */
export const METRIC_THRESHOLDS: Partial<Record<MetricKey, { good: number; poor: number; unit: "ms" | "score" }>> = {
  lcp: { good: 2500, poor: 4000, unit: "ms" },
  inp: { good: 200, poor: 500, unit: "ms" },
  cls: { good: 0.1, poor: 0.25, unit: "score" },
  fcp: { good: 1800, poor: 3000, unit: "ms" },
  ttfb: { good: 800, poor: 1800, unit: "ms" },
};

export function formatMs(ms: number): string {
  return Math.abs(ms) >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** "Good ≤ 2.5 s" from a documented threshold, or null when none is documented. */
export function goodTarget(metric: MetricKey): string | null {
  const t = METRIC_THRESHOLDS[metric];
  if (!t) return null;
  return `Good ≤ ${t.unit === "ms" ? formatMs(t.good) : String(t.good)}`;
}

export type Difference = { text: string; words: string } | null;

/** Desktop − mobile for a 0-100 score, e.g. {text: "+12", words: "desktop is 12 points higher"}. */
export function scoreDifference(mobile: number | null | undefined, desktop: number | null | undefined): Difference {
  if (typeof mobile !== "number" || typeof desktop !== "number") return null;
  const d = desktop - mobile;
  if (d === 0) return { text: "Same", words: "same on both devices" };
  return { text: `${d > 0 ? "+" : "−"}${Math.abs(d)}`, words: `desktop is ${Math.abs(d)} points ${d > 0 ? "higher" : "lower"}` };
}

/** Desktop − mobile for a metric where lower is better (time in ms, or CLS). */
export function metricDifference(metric: MetricKey, mobile: TechnicalAuditCwvEntry | undefined, desktop: TechnicalAuditCwvEntry | undefined): Difference {
  const m = mobile?.numeric_value;
  const d = desktop?.numeric_value;
  if (typeof m !== "number" || typeof d !== "number") return null;
  const diff = d - m;
  const isScore = metric === "cls";
  const magnitude = isScore ? Math.abs(diff).toFixed(3).replace(/\.?0+$/, "") : formatMs(Math.abs(diff));
  if ((isScore && Math.abs(diff) < 0.0005) || (!isScore && Math.round(Math.abs(diff)) === 0)) {
    return { text: "Same", words: "same on both devices" };
  }
  if (isScore) {
    return { text: `${diff > 0 ? "+" : "−"}${magnitude}`, words: diff < 0 ? "less layout shift on desktop" : "more layout shift on desktop" };
  }
  const better = diff < 0;
  return { text: `${magnitude} ${better ? "faster" : "slower"} on desktop`, words: `${magnitude} ${better ? "faster" : "slower"} on desktop` };
}

/** Lighthouse text with Markdown links reduced to their labels, for one-line previews. */
export function plainLighthouseText(text: string | null | undefined): string {
  return (text || "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Improves LCP, FCP" from Google's per-metric savings, or null when none were reported. */
export function improvesText(metricSavings: Record<string, number> | null | undefined): string | null {
  const keys = Object.entries(metricSavings || {})
    .filter(([, v]) => typeof v === "number" && v > 0)
    .map(([k]) => k);
  return keys.length ? `Improves ${keys.join(", ")}` : null;
}

/** Largest single time saving Google estimated (overall, else the largest per-metric). */
export function bestSavingsMs(f: Pick<TechnicalAuditOpportunity, "overall_savings_ms" | "metric_savings">): number {
  const values = [f.overall_savings_ms ?? 0, ...Object.values(f.metric_savings || {})].filter((v): v is number => typeof v === "number");
  return values.length ? Math.max(0, ...values) : 0;
}

export type TopInsight =
  | { kind: "metric"; key: string; metric: MetricKey; status: Status; entry: TechnicalAuditCwvEntry }
  | { kind: "opportunity"; key: string; finding: TechnicalAuditOpportunity }
  | { kind: "diagnostic" | "accessibility"; key: string; finding: TechnicalAuditFinding };

const TOP_INSIGHTS_LIMIT = 6;

/**
 * Deterministic "Top Issues & Insights": (1) Core Web Vitals rated poor, then needs
 * improvement; (2) opportunities by Google's estimated time saving, then bytes; (3) failing
 * diagnostics by lowest score; (4) accessibility failures by lowest score. One row per audit id.
 */
export function rankTopInsights(result: TechnicalAuditStrategyResult, limit = TOP_INSIGHTS_LIMIT): TopInsight[] {
  const out: TopInsight[] = [];
  const seen = new Set<string>();
  const push = (item: TopInsight) => {
    if (seen.has(item.key) || out.length >= limit) return;
    seen.add(item.key);
    out.push(item);
  };
  const cwv = result.core_web_vitals || {};
  for (const wanted of ["poor", "needs_improvement"] as const) {
    for (const metric of CORE_WEB_VITALS) {
      const entry = cwv[metric];
      if (entry?.status === wanted) push({ kind: "metric", key: `metric:${metric}`, metric, status: wanted, entry });
    }
  }
  const byScore = (a: TechnicalAuditFinding, b: TechnicalAuditFinding) => (a.score ?? 101) - (b.score ?? 101);
  [...(result.opportunities || [])]
    .sort((a, b) => bestSavingsMs(b) - bestSavingsMs(a) || (b.overall_savings_bytes ?? 0) - (a.overall_savings_bytes ?? 0))
    .forEach((f) => push({ kind: "opportunity", key: f.id, finding: f }));
  [...(result.diagnostics || [])].sort(byScore).forEach((f) => push({ kind: "diagnostic", key: f.id, finding: f }));
  [...(result.accessibility_failures || [])].sort(byScore).forEach((f) => push({ kind: "accessibility", key: f.id, finding: f }));
  return out;
}

/** Health-score change vs an older run, as text ("▲ 3", "▼ 2", "No change"); null if not comparable. */
export function healthDelta(current: TechnicalAuditStrategyResult | null | undefined, previous: TechnicalAuditStrategyResult | null | undefined): string | null {
  const a = technicalHealthScore(current);
  const b = technicalHealthScore(previous);
  if (a === null || b === null) return null;
  const d = a - b;
  return d === 0 ? "No change" : `${d > 0 ? "▲" : "▼"} ${Math.abs(d)}`;
}

/* ── v2 (TECHNICAL_AUDIT_UI_SPEC v2 §10) ──────────────────────────────────── */

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${Math.round(bytes)} B`;
}

/** Only absolute https: URLs (for links built from Lighthouse or audited-site strings). */
export function isSafeHttpsUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && Boolean(u.hostname);
  } catch {
    return false;
  }
}

export type TextPart = { type: "text"; text: string } | { type: "code"; text: string } | { type: "link"; text: string; href: string };

const LINK_OR_CODE = /\[([^\[\]]*)\]\(([^()\s]*)\)|`([^`]+)`/g;
const MAX_TEXT = 4000;

/**
 * Lighthouse strings -> safe parts. Recognises `[label](https://…)` and `` `code` `` only.
 * Non-https links become plain text (label kept). Everything renders as React text nodes.
 */
export function parseLighthouseText(text: string | null | undefined): TextPart[] {
  const src = (text || "").slice(0, MAX_TEXT);
  const out: TextPart[] = [];
  let last = 0;
  for (const m of src.matchAll(LINK_OR_CODE)) {
    if (m.index! > last) out.push({ type: "text", text: src.slice(last, m.index) });
    if (m[3] !== undefined) out.push({ type: "code", text: m[3] });
    else if (isSafeHttpsUrl(m[2]) && m[1].trim()) out.push({ type: "link", text: m[1], href: m[2] });
    else if (m[1].trim()) out.push({ type: "text", text: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < src.length) out.push({ type: "text", text: src.slice(last) });
  return out;
}

/**
 * Riviso-defined impact bands over Google's estimated savings -- the one label on this screen
 * Google does not supply. Shown as "Impact" with the tooltip "Based on Google's estimated
 * savings". Proposed in the spec, pending owner confirmation.
 */
export const IMPACT_HIGH_MS = 1000;
export const IMPACT_HIGH_BYTES = 500 * 1024;
export const IMPACT_MEDIUM_MS = 300;
export const IMPACT_MEDIUM_BYTES = 100 * 1024;

export type ImpactTier = "high" | "medium" | "low";

export function impactTier(savingsMs: number | null | undefined, savingsBytes: number | null | undefined): ImpactTier | null {
  const ms = typeof savingsMs === "number" && savingsMs > 0 ? savingsMs : 0;
  const by = typeof savingsBytes === "number" && savingsBytes > 0 ? savingsBytes : 0;
  if (!ms && !by) return null;
  if (ms >= IMPACT_HIGH_MS || by >= IMPACT_HIGH_BYTES) return "high";
  if (ms >= IMPACT_MEDIUM_MS || by >= IMPACT_MEDIUM_BYTES) return "medium";
  return "low";
}

export const IMPACT_LABELS: Record<ImpactTier, string> = { high: "High", medium: "Medium", low: "Low" };

/** Metrics Lighthouse can attribute savings to, in PSI's display order. */
export const SAVINGS_METRICS = ["FCP", "LCP", "INP", "CLS", "TBT"] as const;

type WithSavings = { metric_savings?: Record<string, number> | null };

export function savingsMetrics(f: WithSavings): string[] {
  const s = f.metric_savings || {};
  return SAVINGS_METRICS.filter((m) => typeof s[m] === "number" && s[m] > 0);
}

/** Filter chips with real counts: All (n), then one per metric that has at least one finding. */
export function metricFilterChips(items: WithSavings[]): { key: string; label: string; count: number }[] {
  const chips = [{ key: "all", label: "All", count: items.length }];
  for (const m of SAVINGS_METRICS) {
    const n = items.filter((f) => savingsMetrics(f).includes(m)).length;
    if (n > 0) chips.push({ key: m, label: m, count: n });
  }
  return chips;
}

export type OpportunitySort = "savings" | "impact" | "metric" | "name";

type Sortable = TechnicalAuditOpportunity;
const TIER_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export function sortOpportunities<T extends Sortable>(items: T[], sort: OpportunitySort): T[] {
  const savings = (f: T) => bestSavingsMs(f) || 0;
  const bytes = (f: T) => f.overall_savings_bytes ?? 0;
  const tier = (f: T) => TIER_RANK[impactTier(bestSavingsMs(f), f.overall_savings_bytes) ?? ""] ?? 0;
  const metric = (f: T) => savingsMetrics(f)[0] ?? "ZZZ";
  const name = (f: T) => (f.title || f.id).toLowerCase();
  const bySavings = (a: T, b: T) => savings(b) - savings(a) || bytes(b) - bytes(a);
  const sorted = [...items];
  if (sort === "savings") sorted.sort(bySavings);
  else if (sort === "impact") sorted.sort((a, b) => tier(b) - tier(a) || bySavings(a, b));
  else if (sort === "metric") sorted.sort((a, b) => metric(a).localeCompare(metric(b)) || bySavings(a, b));
  else sorted.sort((a, b) => name(a).localeCompare(name(b)));
  return sorted;
}

/** Lighthouse score band for a 0-100 score (or null) -> display kind. */
export function kindFromScore(score: number | null | undefined): "failed" | "warning" | "passed" | "informational" {
  if (typeof score !== "number") return "informational";
  if (score >= 90) return "passed";
  return score >= 50 ? "warning" : "failed";
}

export type DiagnosticsFilter = "all" | "passed" | "warning" | "failed" | "informational";
const KIND_ORDER: Record<string, number> = { failed: 0, warning: 1, passed: 2, informational: 3 };

/**
 * Diagnostics chips: Passed (>= 90), Warnings (50-89), Failed (< 50), Informational.
 * "All" = passed + warnings + failed (informational excluded, as the UI tooltip says).
 */
export function diagnosticsBuckets<T extends { kind: string }>(rows: T[]) {
  const counts = { passed: 0, warning: 0, failed: 0, informational: 0 };
  for (const r of rows) if (r.kind in counts) counts[r.kind as keyof typeof counts] += 1;
  return { ...counts, all: counts.passed + counts.warning + counts.failed };
}

export function filterDiagnostics<T extends { kind: string }>(rows: T[], filter: DiagnosticsFilter): T[] {
  const kept = rows.filter((r) => (filter === "all" ? r.kind !== "informational" && r.kind in KIND_ORDER : r.kind === filter));
  // Stable sort keeps Lighthouse's own order within each group.
  return kept.map((r, i) => [r, i] as const).sort((a, b) => KIND_ORDER[a[0].kind] - KIND_ORDER[b[0].kind] || a[1] - b[1]).map(([r]) => r);
}

/**
 * Core Web Vitals assessment from real-user data: Passed only if LCP, INP and CLS are all
 * "good" at the 75th percentile; Failed if any of them is not; No data if any is missing.
 */
export function fieldAssessment(field: TechnicalAuditField | null | undefined): "passed" | "failed" | "no_data" {
  const m = field?.metrics;
  const statuses = (["lcp", "inp", "cls"] as const).map((k) => m?.[k]?.status ?? null);
  if (statuses.some((s) => s === null)) return "no_data";
  return statuses.every((s) => s === "good") ? "passed" : "failed";
}

export function formatFieldValue(metric: MetricKey, value: number | null | undefined): string {
  if (typeof value !== "number") return "—";
  if (metric === "cls") return value.toFixed(2);
  return formatMs(value);
}

/** good / needs improvement / poor shares as whole percentages (from Google's buckets). */
export function distributionPercents(field: TechnicalAuditFieldMetric | null | undefined): [number, number, number] | null {
  const d = field?.distributions || [];
  if (d.length !== 3) return null;
  return [Math.round(d[0].proportion * 100), Math.round(d[1].proportion * 100), Math.round(d[2].proportion * 100)];
}

/** Failing + warning audits for a category, from the index (null when not stored). */
export function categoryToFix(index: TechnicalAuditIndexEntry[] | undefined, category: TechnicalAuditIndexEntry["category"]): number | null {
  if (!index || index.length === 0) return null;
  return index.filter((a) => a.category === category && (a.kind === "failed" || a.kind === "warning")).length;
}

/** Safe download name, e.g. riviso-technical-audit-example.com-2026-10-20-mobile.json */
export function reportFilename(url: string | null | undefined, createdAt: string | null | undefined, strategy: Strategy): string {
  let host = "site";
  try {
    host = url ? new URL(url).hostname : host;
  } catch {
    /* keep default */
  }
  const day = (createdAt || "").slice(0, 10).replace(/[^0-9-]/g, "") || "unknown-date";
  return `riviso-technical-audit-${host.replace(/[^a-z0-9.-]/gi, "")}-${day}-${strategy}.json`;
}
