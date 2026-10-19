import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatIssueEvidence, issueGroupLabel } from "./seoAuditIssues";

describe("issueGroupLabel", () => {
  it("uses the rule name when the API sends one", () => {
    assert.equal(issueGroupLabel({ rule_id: "crawl_timeout", category: "Response Codes", name: "Page timed out" }), "Page timed out");
  });
  it("falls back to category for older API responses, then rule id", () => {
    assert.equal(issueGroupLabel({ rule_id: "response_4xx", category: "Response Codes" }), "Response Codes");
    assert.equal(issueGroupLabel({ rule_id: "brand_new_rule", category: "" }), "brand_new_rule");
  });
});

describe("formatIssueEvidence", () => {
  it("formats evidence values and skips empty ones", () => {
    assert.equal(formatIssueEvidence({ error: "timeout", discovered_from: null, inlink_count: 3 }), "error: timeout · inlink count: 3");
    assert.equal(formatIssueEvidence({ hops: [1, 2] }), "hops: [1,2]");
  });
  it("handles missing evidence (old rows)", () => {
    assert.equal(formatIssueEvidence(undefined), "");
    assert.equal(formatIssueEvidence({}), "");
  });
});
