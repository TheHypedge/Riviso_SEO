/**
 * Pure view logic for the Technical Audit screen. No React, no fetching -- every value is
 * read from a stored PageSpeed Insights result or is arithmetic on it.
 */
import type { TechnicalAuditCwvEntry, TechnicalAuditFinding, TechnicalAuditOpportunity, TechnicalAuditStrategyResult } from "./api";

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
