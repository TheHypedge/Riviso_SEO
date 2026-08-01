import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";

marked.setOptions({ gfm: true, breaks: true });

/**
 * Markdown stored in DB → HTML for preview / WordPress-aligned display.
 *
 * `marked` passes through raw HTML embedded in markdown source verbatim, and this
 * markdown ultimately comes from LLM generation — sanitize before every caller
 * hands the result to `dangerouslySetInnerHTML` (F0.4). Single choke point so
 * future callers can't forget it.
 */
export function markdownToArticleHtml(src: string): string {
  const t = (src || "").trim();
  if (!t) return "<p></p>";
  const html = marked.parse(t, { async: false });
  return typeof html === "string" ? DOMPurify.sanitize(html) : "<p></p>";
}
