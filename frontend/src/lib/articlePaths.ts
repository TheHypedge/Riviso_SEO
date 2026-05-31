/** Safe article editor URL segments (UUIDs / slugs from our API). */
const REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export function isValidArticleRef(projectId: string, articleId: string): boolean {
  const pid = (projectId || "").trim();
  const aid = (articleId || "").trim();
  if (!pid || !aid) return false;
  if (aid.includes("/") || pid.includes("/")) return false;
  return REF_RE.test(pid) && REF_RE.test(aid);
}

export function articleEditorPath(projectId: string, articleId: string): string | null {
  if (!isValidArticleRef(projectId, articleId)) return null;
  return `/projects/${encodeURIComponent(projectId)}/articles/${encodeURIComponent(articleId)}`;
}

export function formatArticleLoadError(e: unknown): { message: string; canRetry: boolean; notFound: boolean } {
  if (e && typeof e === "object" && "status" in e) {
    const status = Number((e as { status: number }).status);
    if (status === 404) {
      return {
        message:
          "This article could not be found. It may have been deleted or moved to another project.",
        canRetry: false,
        notFound: true,
      };
    }
    if (status === 403 || status === 401) {
      return {
        message: "You do not have access to this article.",
        canRetry: false,
        notFound: false,
      };
    }
    if (status === 503) {
      return {
        message: "Database is temporarily unavailable. Check your Wi‑Fi, then retry — or use local JSON storage if you are offline.",
        canRetry: true,
        notFound: false,
      };
    }
    if (status === 408) {
      return {
        message: "Loading timed out. MongoDB may be unreachable — check your network, then click Retry.",
        canRetry: true,
        notFound: false,
      };
    }
    if (status === 500) {
      return {
        message: "Could not load this article. Try again in a moment.",
        canRetry: true,
        notFound: false,
      };
    }
  }
  const raw = e instanceof Error ? e.message : "Failed to load article";
  const network = /failed to fetch|networkerror|load failed/i.test(raw);
  const timedOut = /signal timed out|timeout|timed out/i.test(raw);
  return {
    message: timedOut
      ? "Loading timed out. The server may still be working — wait a moment and click Retry."
      : network
      ? "Could not reach the server. Check your connection and try again."
      : raw,
    canRetry: true,
    notFound: false,
  };
}
