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
  }
  const raw = e instanceof Error ? e.message : "Failed to load article";
  const network = /failed to fetch|networkerror|load failed/i.test(raw);
  return {
    message: network
      ? "Could not reach the server. Check your connection and try again."
      : raw,
    canRetry: true,
    notFound: false,
  };
}
