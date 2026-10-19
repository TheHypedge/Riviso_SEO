import type { SeoAuditIssueGroup } from "./api";

/** Rule name from the backend registry; older API responses only had the category. */
export function issueGroupLabel(g: Pick<SeoAuditIssueGroup, "name" | "rule_id" | "category">): string {
  return (g.name || "").trim() || g.category || g.rule_id;
}

function humanKey(k: string): string {
  return k.replace(/_/g, " ");
}

/**
 * One compact line of the data that triggered an issue, e.g. "error: timeout · inlink count: 3".
 * Skips empty values; nested objects/arrays are shown as JSON so nothing is silently hidden.
 */
export function formatIssueEvidence(evidence: Record<string, unknown> | null | undefined): string {
  if (!evidence) return "";
  return Object.entries(evidence)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${humanKey(k)}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}
