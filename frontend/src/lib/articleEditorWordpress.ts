/** WordPress publish/update eligibility for the single-article editor. */

export type ArticleWpEditorContext = {
  articleStatus: string;
  wpPostId: number | null;
  wpLink: string;
};

export function parseWpPostId(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Article is live on WordPress (published listing status + post link or id). */
export function isArticleLiveOnWordPress(ctx: ArticleWpEditorContext): boolean {
  const status = (ctx.articleStatus || "").trim().toLowerCase();
  if (status !== "published") return false;
  const hasPostId = ctx.wpPostId != null && ctx.wpPostId > 0;
  const hasLink = (ctx.wpLink || "").trim().length > 0;
  return hasPostId || hasLink;
}

/** Show "Update article" — only for posts already live, not draft/pending/scheduled. */
export function shouldShowWordPressUpdate(ctx: ArticleWpEditorContext): boolean {
  return isArticleLiveOnWordPress(ctx);
}

/** Show first-time "Publish" — not when already live or scheduled for auto-post. */
export function shouldShowWordPressPublish(ctx: ArticleWpEditorContext): boolean {
  const status = (ctx.articleStatus || "").trim().toLowerCase();
  if (status === "scheduled") return false;
  return !isArticleLiveOnWordPress(ctx);
}

export function canPushWordPressUpdate(opts: {
  ctx: ArticleWpEditorContext;
  websiteConnected: boolean;
  hasTitle: boolean;
  hasBody: boolean;
  hasPendingChanges: boolean;
  busy: boolean;
}): boolean {
  if (!shouldShowWordPressUpdate(opts.ctx)) return false;
  if (!opts.websiteConnected || !opts.hasTitle || !opts.hasBody) return false;
  if (!opts.hasPendingChanges || opts.busy) return false;
  const hasTarget =
    (opts.ctx.wpPostId != null && opts.ctx.wpPostId > 0) || (opts.ctx.wpLink || "").trim().length > 0;
  return hasTarget;
}
