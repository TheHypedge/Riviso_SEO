/**
 * Diff helpers for humanization review UI (green = changed editorial output).
 */

import { splitMarkdownParagraphs } from "@/lib/rivisoLinguistics";

const SENT_SPLIT = /(?<=[.!?])\s+/;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeSentence(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function splitSentences(text: string): string[] {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  return t.split(SENT_SPLIT).map((x) => x.trim()).filter(Boolean);
}

/** Highlight sentences in `after` that differ from `before`. */
export function highlightSentenceDiffHtml(before: string, after: string): string {
  const beforeNorm = new Set(splitSentences(before).map(normalizeSentence));
  const parts = splitSentences(after);
  if (!parts.length) return escapeHtml(after);

  return parts
    .map((sent) => {
      const esc = escapeHtml(sent);
      const changed = !beforeNorm.has(normalizeSentence(sent));
      if (changed) {
        return `<mark class="riviso-humanized-mark">${esc}</mark>`;
      }
      return esc;
    })
    .join(" ");
}

export type CompareBlock = {
  index: number;
  original: string;
  humanized: string;
  changed: boolean;
  humanizedHtml: string;
};

export type HumanizeRewritten = { index: number; before: string; after: string };

export function buildHumanizeCompareBlocks(
  original: string,
  humanized: string,
  rewritten?: HumanizeRewritten[] | null,
): CompareBlock[] {
  const origParas = splitMarkdownParagraphs(original);
  const humanParas = splitMarkdownParagraphs(humanized);
  const rewrittenMap = new Map((rewritten || []).map((r) => [r.index, r]));
  const maxLen = Math.max(origParas.length, humanParas.length);
  const blocks: CompareBlock[] = [];

  for (let i = 0; i < maxLen; i += 1) {
    const o = origParas[i] ?? "";
    const h = humanParas[i] ?? "";
    const rw = rewrittenMap.get(i);
    const changed = Boolean(rw) || (o.trim() !== h.trim() && Boolean(o.trim() || h.trim()));
    const before = rw?.before ?? o;
    const after = rw?.after ?? h;
    blocks.push({
      index: i,
      original: o,
      humanized: h,
      changed,
      humanizedHtml: changed ? highlightSentenceDiffHtml(before, after) : escapeHtml(h),
    });
  }

  return blocks;
}

export function countChangedBlocks(blocks: CompareBlock[]): number {
  return blocks.filter((b) => b.changed).length;
}
