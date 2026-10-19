import type { TechnicalAuditSample, TechnicalAuditStrategyResult } from "./api";

/**
 * Fill every list/summary the Technical Audit UI reads, so older history rows (stored before
 * SEO findings, samples and "Fix first" existed) render with those sections hidden instead
 * of crashing. Missing data stays missing: summaries become null, never zero counts.
 */
export function withTechnicalResultDefaults(r: Partial<TechnicalAuditStrategyResult> | null | undefined): TechnicalAuditStrategyResult {
  const s = (r?.scores || {}) as Partial<TechnicalAuditStrategyResult["scores"]>;
  return {
    ...(r || {}),
    scores: {
      performance: s.performance ?? null,
      accessibility: s.accessibility ?? null,
      best_practices: s.best_practices ?? null,
      pagespeed_seo: s.pagespeed_seo ?? null,
    },
    core_web_vitals: r?.core_web_vitals || {},
    opportunities: r?.opportunities || [],
    diagnostics: r?.diagnostics || [],
    accessibility_failures: r?.accessibility_failures || [],
    best_practices_failures: r?.best_practices_failures || [],
    seo_failures: r?.seo_failures || [],
    accessibility_summary: r?.accessibility_summary ?? null,
    best_practices_summary: r?.best_practices_summary ?? null,
    seo_summary: r?.seo_summary ?? null,
    fix_first: r?.fix_first || [],
    field_data_source: r?.field_data_source ?? null,
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${Math.round(bytes)} B`;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/**
 * Google's own estimated savings, e.g. "Est. savings 0.9 s · 120 KiB" or, for Lighthouse 13
 * insights that only report per-metric savings, "Est. savings LCP 2.5 s · FCP 300 ms".
 * Null when Lighthouse gave no savings figure.
 */
export function formatSavings(
  ms: number | null | undefined,
  bytes: number | null | undefined,
  metricSavings?: Record<string, number> | null,
): string | null {
  const parts: string[] = [];
  if (typeof ms === "number" && ms > 0) {
    parts.push(formatMs(ms));
  } else {
    for (const [metric, v] of Object.entries(metricSavings || {})) {
      if (typeof v === "number" && v > 0) parts.push(`${metric} ${formatMs(v)}`);
    }
  }
  if (typeof bytes === "number" && bytes > 0) parts.push(formatBytes(bytes));
  return parts.length ? `Est. savings ${parts.join(" · ")}` : null;
}

/** One readable line for an affected-resource sample: what it is, then its own waste figure. */
export function describeSample(sample: TechnicalAuditSample | null | undefined): string | null {
  if (!sample) return null;
  const what = sample.url || sample.label || sample.selector || sample.snippet;
  if (!what) return null;
  const waste = [
    typeof sample.wasted_ms === "number" && sample.wasted_ms > 0 ? formatMs(sample.wasted_ms) : null,
    typeof sample.wasted_bytes === "number" && sample.wasted_bytes > 0 ? formatBytes(sample.wasted_bytes) : null,
  ].filter(Boolean);
  return waste.length ? `${what} (${waste.join(", ")})` : what;
}

export const FINDING_SECTION_LABELS: Record<string, string> = {
  opportunities: "Performance opportunity",
  diagnostics: "Performance diagnostic",
  accessibility_failures: "Accessibility",
  best_practices_failures: "Best Practices",
  seo_failures: "SEO",
};
