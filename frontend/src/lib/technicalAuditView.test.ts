import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TechnicalAuditStrategyResult } from "./api";
import { withTechnicalResultDefaults } from "./technicalAudit";
import {
  bestSavingsMs,
  goodTarget,
  healthDelta,
  improvesText,
  metricDifference,
  plainLighthouseText,
  rankTopInsights,
  scoreDifference,
  scoreStatus,
  technicalHealthScore,
} from "./technicalAuditView";

function result(over: Partial<TechnicalAuditStrategyResult> = {}): TechnicalAuditStrategyResult {
  return withTechnicalResultDefaults({ scores: { performance: 60, accessibility: 90, best_practices: 81, pagespeed_seo: 92 }, ...over });
}

// Stored before seo_failures / samples / metric_savings existed.
const OLD_SHAPE = {
  scores: { performance: 48, accessibility: 77, best_practices: 100, pagespeed_seo: 85 },
  core_web_vitals: { lcp: { display_value: "5.1 s", numeric_value: 5100, status: "poor", source: "lab" } },
  opportunities: [{ id: "render-blocking-resources", title: "Eliminate render-blocking resources", overall_savings_ms: 900, affected_resources: 3 }],
  diagnostics: [{ id: "dom-size", title: "Avoid an excessive DOM size", score: 40 }],
  accessibility_failures: [{ id: "image-alt", title: "Images lack alt", score: 0 }],
  best_practices_failures: [],
} as unknown as TechnicalAuditStrategyResult;

describe("scores", () => {
  it("bands scores with Lighthouse's 90/50 cutoffs and keeps unknown as unknown", () => {
    assert.equal(scoreStatus(90), "good");
    assert.equal(scoreStatus(89), "needs_improvement");
    assert.equal(scoreStatus(49), "poor");
    assert.equal(scoreStatus(null), null);
    assert.equal(scoreStatus(undefined), null);
  });
  it("health score is the unchanged mean of performance, accessibility, best practices", () => {
    assert.equal(technicalHealthScore(result()), 77); // (60+90+81)/3 = 77
    assert.equal(technicalHealthScore(withTechnicalResultDefaults(undefined)), null);
  });
  it("health delta vs an older run", () => {
    assert.equal(healthDelta(result(), result({ scores: { performance: 51, accessibility: 90, best_practices: 81, pagespeed_seo: 92 } })), "▲ 3");
    assert.equal(healthDelta(result(), result()), "No change");
    assert.equal(healthDelta(result(), withTechnicalResultDefaults(undefined)), null);
  });
});

describe("differences", () => {
  it("score difference is desktop minus mobile, with words", () => {
    assert.deepEqual(scoreDifference(58, 70), { text: "+12", words: "desktop is 12 points higher" });
    assert.deepEqual(scoreDifference(70, 58), { text: "−12", words: "desktop is 12 points lower" });
    assert.equal(scoreDifference(70, 70)?.text, "Same");
    assert.equal(scoreDifference(null, 70), null);
  });
  it("time metrics read as faster/slower on desktop", () => {
    assert.equal(metricDifference("lcp", { numeric_value: 4100 }, { numeric_value: 1300 })?.text, "2.8 s faster on desktop");
    assert.equal(metricDifference("tbt", { numeric_value: 100 }, { numeric_value: 350 })?.text, "250 ms slower on desktop");
    assert.equal(metricDifference("lcp", { numeric_value: 1000 }, undefined), null);
  });
  it("CLS difference is unitless", () => {
    assert.deepEqual(metricDifference("cls", { numeric_value: 0.25 }, { numeric_value: 0.05 }), { text: "−0.2", words: "less layout shift on desktop" });
    assert.equal(metricDifference("cls", { numeric_value: 0.1 }, { numeric_value: 0.1 })?.text, "Same");
  });
});

describe("targets and text", () => {
  it("only documented thresholds produce a target", () => {
    assert.equal(goodTarget("lcp"), "Good ≤ 2.5 s");
    assert.equal(goodTarget("cls"), "Good ≤ 0.1");
    assert.equal(goodTarget("ttfb"), "Good ≤ 800 ms");
    assert.equal(goodTarget("tbt"), null);
    assert.equal(goodTarget("speed_index"), null);
  });
  it("strips Markdown links and code ticks from Lighthouse text", () => {
    assert.equal(plainLighthouseText("Defer `<script>`s. [Learn more](https://web.dev/x)."), "Defer <script>s. Learn more.");
    assert.equal(plainLighthouseText(undefined), "");
  });
  it("improves text lists only metrics with savings", () => {
    assert.equal(improvesText({ LCP: 1200, FCP: 0, TBT: 300 }), "Improves LCP, TBT");
    assert.equal(improvesText({}), null);
    assert.equal(improvesText(undefined), null);
  });
  it("best savings uses overall ms, else the largest per-metric saving", () => {
    assert.equal(bestSavingsMs({ overall_savings_ms: 900 }), 900);
    assert.equal(bestSavingsMs({ metric_savings: { LCP: 2500, FCP: 300 } }), 2500);
    assert.equal(bestSavingsMs({}), 0);
  });
});

describe("rankTopInsights", () => {
  it("orders poor CWV, needs-improvement CWV, opportunities by savings, diagnostics, accessibility", () => {
    const r = result({
      core_web_vitals: {
        lcp: { display_value: "3.0 s", status: "needs_improvement" },
        cls: { display_value: "0.4", status: "poor" },
        fcp: { display_value: "4.0 s", status: "poor" }, // not a Core Web Vital
      },
      opportunities: [
        { id: "small", title: "Small", overall_savings_ms: 100 },
        { id: "insight", title: "Insight", metric_savings: { LCP: 2400 } },
        { id: "big", title: "Big", overall_savings_ms: 900 },
      ],
      diagnostics: [
        { id: "d60", title: "D60", score: 60 },
        { id: "d10", title: "D10", score: 10 },
      ],
      accessibility_failures: [{ id: "a0", title: "A0", score: 0 }],
    });
    assert.deepEqual(
      rankTopInsights(r).map((i) => i.key),
      ["metric:cls", "metric:lcp", "insight", "big", "small", "d10"],
    );
  });
  it("dedupes by audit id and respects the limit", () => {
    const r = result({
      opportunities: [{ id: "x", title: "X", overall_savings_ms: 10 }],
      diagnostics: [{ id: "x", title: "X again", score: 0 }],
    });
    assert.deepEqual(rankTopInsights(r).map((i) => i.key), ["x"]);
    assert.equal(rankTopInsights(r, 0).length, 0);
  });
  it("renders an old-format run without throwing", () => {
    const r = withTechnicalResultDefaults(OLD_SHAPE);
    assert.deepEqual(rankTopInsights(r).map((i) => i.key), ["metric:lcp", "render-blocking-resources", "dom-size", "image-alt"]);
    assert.deepEqual(r.seo_failures, []);
  });
  it("returns nothing for an empty result", () => {
    assert.deepEqual(rankTopInsights(withTechnicalResultDefaults(undefined)), []);
  });
});

/* ── v2 helpers ─────────────────────────────────────────────────────────── */

import {
  categoryToFix,
  diagnosticsBuckets,
  distributionPercents,
  fieldAssessment,
  filterDiagnostics,
  formatBytes,
  formatFieldValue,
  impactTier,
  isSafeHttpsUrl,
  kindFromScore,
  metricFilterChips,
  parseLighthouseText,
  reportFilename,
  sortOpportunities,
} from "./technicalAuditView";

describe("parseLighthouseText", () => {
  it("keeps https links and code, as parts", () => {
    assert.deepEqual(parseLighthouseText("Use `font-display`. [Learn more](https://web.dev/x)."), [
      { type: "text", text: "Use " },
      { type: "code", text: "font-display" },
      { type: "text", text: ". " },
      { type: "link", text: "Learn more", href: "https://web.dev/x" },
      { type: "text", text: "." },
    ]);
  });
  it("never links javascript:, data: or http: URLs", () => {
    for (const bad of ["javascript:alert(1)", "javascript:void0", "data:text/html,x", "http://example.com"]) {
      const parts = parseLighthouseText(`[Click](${bad})`);
      assert.equal(parts.some((p) => p.type === "link"), false, bad);
    }
    assert.deepEqual(parseLighthouseText("[Click](javascript:void0)"), [{ type: "text", text: "Click" }]);
  });
  it("handles empty labels, unmatched backticks, plain text and huge input", () => {
    assert.deepEqual(parseLighthouseText("[](https://web.dev)"), []);
    assert.deepEqual(parseLighthouseText("a `b"), [{ type: "text", text: "a `b" }]);
    assert.deepEqual(parseLighthouseText(undefined), []);
    assert.equal(parseLighthouseText("x".repeat(10_000)).map((p) => p.text).join("").length, 4000);
  });
});

describe("isSafeHttpsUrl", () => {
  it("accepts only absolute https URLs", () => {
    assert.equal(isSafeHttpsUrl("https://res.cloudinary.com/a.jpg"), true);
    assert.equal(isSafeHttpsUrl("http://a.com"), false);
    assert.equal(isSafeHttpsUrl("javascript:alert(1)"), false);
    assert.equal(isSafeHttpsUrl("/relative"), false);
    assert.equal(isSafeHttpsUrl(null), false);
  });
});

describe("impactTier (Riviso bands over Google savings)", () => {
  it("bands by ms or bytes, whichever is larger", () => {
    assert.equal(impactTier(1000, 0), "high");
    assert.equal(impactTier(0, 600 * 1024), "high");
    assert.equal(impactTier(300, null), "medium");
    assert.equal(impactTier(50, 120 * 1024), "medium");
    assert.equal(impactTier(100, 10 * 1024), "low");
  });
  it("is null when Google gave no savings (never 'low')", () => {
    assert.equal(impactTier(null, undefined), null);
    assert.equal(impactTier(0, 0), null);
  });
});

describe("opportunities", () => {
  const opps = [
    { id: "a", title: "Zeta", overall_savings_ms: 200, metric_savings: { FCP: 200 } },
    { id: "b", title: "Alpha", metric_savings: { LCP: 2500, FCP: 0 } },
    { id: "c", title: "Mid", overall_savings_bytes: 600 * 1024 },
  ];
  it("metric chips count only metrics with real savings", () => {
    assert.deepEqual(metricFilterChips(opps), [
      { key: "all", label: "All", count: 3 },
      { key: "FCP", label: "FCP", count: 1 },
      { key: "LCP", label: "LCP", count: 1 },
    ]);
    assert.deepEqual(metricFilterChips([]), [{ key: "all", label: "All", count: 0 }]);
  });
  it("sorts by savings, impact, metric and name", () => {
    assert.deepEqual(sortOpportunities(opps, "savings").map((o) => o.id), ["b", "a", "c"]);
    assert.deepEqual(sortOpportunities(opps, "impact").map((o) => o.id), ["b", "c", "a"]);
    assert.deepEqual(sortOpportunities(opps, "metric").map((o) => o.id), ["a", "b", "c"]);
    assert.deepEqual(sortOpportunities(opps, "name").map((o) => o.id), ["b", "c", "a"]);
  });
});

describe("diagnostics", () => {
  const rows = [
    { id: "p", kind: "passed" },
    { id: "f1", kind: "failed" },
    { id: "w", kind: "warning" },
    { id: "i", kind: "informational" },
    { id: "f2", kind: "failed" },
  ];
  it("counts buckets; All excludes informational", () => {
    assert.deepEqual(diagnosticsBuckets(rows), { passed: 1, warning: 1, failed: 2, informational: 1, all: 4 });
    assert.deepEqual(diagnosticsBuckets([]), { passed: 0, warning: 0, failed: 0, informational: 0, all: 0 });
  });
  it("orders failed, warnings, passed and keeps Lighthouse order within a group", () => {
    assert.deepEqual(filterDiagnostics(rows, "all").map((r) => r.id), ["f1", "f2", "w", "p"]);
    assert.deepEqual(filterDiagnostics(rows, "informational").map((r) => r.id), ["i"]);
  });
  it("maps old-run scores to kinds", () => {
    assert.equal(kindFromScore(95), "passed");
    assert.equal(kindFromScore(60), "warning");
    assert.equal(kindFromScore(10), "failed");
    assert.equal(kindFromScore(null), "informational");
  });
});

describe("field data", () => {
  const m = (status: "good" | "needs_improvement" | "poor") => ({ percentile: 1, status, distributions: [] });
  it("assessment passes only when LCP, INP and CLS are all good", () => {
    assert.equal(fieldAssessment({ scope: "url", overall_status: "good", metrics: { lcp: m("good"), inp: m("good"), cls: m("good") } }), "passed");
    assert.equal(fieldAssessment({ scope: "url", overall_status: null, metrics: { lcp: m("good"), inp: m("poor"), cls: m("good") } }), "failed");
    assert.equal(fieldAssessment({ scope: "origin", overall_status: null, metrics: { lcp: m("good"), cls: m("good") } }), "no_data");
    assert.equal(fieldAssessment(null), "no_data");
  });
  it("formats p75 and distribution shares", () => {
    assert.equal(formatFieldValue("lcp", 845), "845 ms");
    assert.equal(formatFieldValue("cls", 0.01), "0.01");
    assert.equal(formatFieldValue("inp", null), "—");
    const dist = { percentile: 1, status: "good" as const, distributions: [{ min: 0, max: 0.1, proportion: 0.8749 }, { min: 0.1, max: 0.25, proportion: 0.0764 }, { min: 0.25, max: null, proportion: 0.0487 }] };
    assert.deepEqual(distributionPercents(dist), [87, 8, 5]);
    assert.equal(distributionPercents(undefined), null);
  });
});

describe("misc", () => {
  it("formats bytes like Lighthouse (KiB/MiB)", () => {
    assert.equal(formatBytes(934 * 1024), "934 KiB");
    assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MiB");
    assert.equal(formatBytes(500), "500 B");
  });
  it("counts audits to fix per category, null when the index was not stored", () => {
    const idx = [
      { id: "a", category: "seo", kind: "failed" },
      { id: "b", category: "seo", kind: "warning" },
      { id: "c", category: "seo", kind: "passed" },
    ] as never;
    assert.equal(categoryToFix(idx, "seo"), 2);
    assert.equal(categoryToFix(idx, "accessibility"), 0);
    assert.equal(categoryToFix(undefined, "seo"), null);
  });
  it("builds a safe report filename", () => {
    assert.equal(reportFilename("https://www.example.com/a?b", "2026-10-20 10:00:00", "mobile"), "riviso-technical-audit-www.example.com-2026-10-20-mobile.json");
    assert.equal(reportFilename("not a url", null, "desktop"), "riviso-technical-audit-site-unknown-date-desktop.json");
  });
});
