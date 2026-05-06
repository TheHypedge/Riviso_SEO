import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

/** Markdown stored in DB → HTML for preview / WordPress-aligned display. */
export function markdownToArticleHtml(src: string): string {
  const t = (src || "").trim();
  if (!t) return "<p></p>";
  const html = marked.parse(t, { async: false });
  return typeof html === "string" ? html : "<p></p>";
}
