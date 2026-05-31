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
    if (!parsed?.id) return null;
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
