import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeSample, formatSavings, withTechnicalResultDefaults } from "./technicalAudit";

// Shape of a history row stored before Phase 1 (no SEO findings, samples, fix_first, field source).
const OLD_FORMAT_RESULT = {
  scores: { performance: 61, accessibility: 88, best_practices: 92, pagespeed_seo: 83 },
  core_web_vitals: { lcp: { display_value: "3.0 s", numeric_value: 3000, status: "needs_improvement", source: "lab" } },
  opportunities: [{ id: "unused-javascript", title: "Reduce unused JavaScript", affected_resources: 4 }],
  diagnostics: [{ id: "meta-description", title: "Document does not have a meta description", score: 0 }],
  accessibility_failures: [],
  best_practices_failures: [],
  fetch_time: "2026-08-01T10:00:00.000Z",
} as const;

describe("withTechnicalResultDefaults", () => {
  it("renders an old-format row with new sections empty, not invented", () => {
    const r = withTechnicalResultDefaults(OLD_FORMAT_RESULT as never);
    assert.deepEqual(r.seo_failures, []);
    assert.deepEqual(r.fix_first, []);
    assert.equal(r.seo_summary, null);
    assert.equal(r.field_data_source, null);
    assert.equal(r.scores.performance, 61);
    assert.equal(r.opportunities[0].affected_resources, 4);
    assert.equal(r.opportunities[0].samples, undefined);
  });

  it("survives a missing or empty result", () => {
    const r = withTechnicalResultDefaults(undefined);
    assert.equal(r.scores.pagespeed_seo, null);
    assert.deepEqual(r.core_web_vitals, {});
    assert.deepEqual(r.diagnostics, []);
  });
});

describe("formatSavings", () => {
  it("formats Google's ms and byte savings", () => {
    assert.equal(formatSavings(900, 122880), "Est. savings 900 ms · 120 KiB");
    assert.equal(formatSavings(1500, 0), "Est. savings 1.5 s");
  });
  it("falls back to per-metric savings (Lighthouse 13 insights)", () => {
    assert.equal(formatSavings(null, 204800, { LCP: 2500, FCP: 0, TBT: 300 }), "Est. savings LCP 2.5 s · TBT 300 ms · 200 KiB");
    // overall ms wins; metrics are never added on top of it
    assert.equal(formatSavings(900, null, { LCP: 2500 }), "Est. savings 900 ms");
  });
  it("returns null when there are no savings", () => {
    assert.equal(formatSavings(null, undefined), null);
    assert.equal(formatSavings(0, 0), null);
  });
});

describe("describeSample", () => {
  it("prefers url, then label, selector, snippet", () => {
    assert.equal(describeSample({ url: "https://a.com/x.js", wasted_bytes: 2048 }), "https://a.com/x.js (2 KiB)");
    assert.equal(describeSample({ selector: "body > img", snippet: "<img>" }), "body > img");
    assert.equal(describeSample({}), null);
    assert.equal(describeSample(null), null);
  });
});
