/** @deprecated Import from rivisoLinguistics — kept for backward-compatible imports. */
export {
  auditMarkdown,
  splitMarkdownParagraphs,
  type AuditResult,
  type IntegrityFlag,
  type IntegritySignal,
} from "@/lib/rivisoLinguistics";

export function flaggedIndexSet(flags: { index: number }[]): Set<number> {
  return new Set(flags.map((f) => f.index));
}
