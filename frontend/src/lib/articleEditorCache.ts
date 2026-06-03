import type { ArticleDetail } from "@/lib/api";

const PREFIX = "aa:article-editor:";

function key(projectId: string, articleId: string) {
  return `${PREFIX}${projectId}:${articleId}`;
}

export function readArticleEditorCache(projectId: string, articleId: string): ArticleDetail | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(key(projectId, articleId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ArticleDetail;
    // Require a non-empty id AND title — an entry with blank title was written
    // during a previous load that returned incomplete data (article created
    // without a title, or fetch interrupted). Returning it causes the editor
    // to show a blank title and body even when the API has the correct data.
    if (!parsed?.id || !(parsed.title || "").trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeArticleEditorCache(projectId: string, articleId: string, detail: ArticleDetail) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key(projectId, articleId), JSON.stringify(detail));
  } catch {
    // quota / private mode
  }
}
