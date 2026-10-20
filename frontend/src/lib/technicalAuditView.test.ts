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
