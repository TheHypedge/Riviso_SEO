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

/** Article is linked to a live WordPress post (post id or permalink). */
export function isArticleLiveOnWordPress(ctx: ArticleWpEditorContext): boolean {
  const hasPostId = ctx.wpPostId != null && ctx.wpPostId > 0;
  const hasLink = (ctx.wpLink || "").trim().length > 0;
  if (hasPostId || hasLink) return true;
  const status = (ctx.articleStatus || "").trim().toLowerCase();
  return status === "published";
}

/** WordPress REST status or permalink indicates the post is in trash. */
export function isWordPressPostTrashed(opts: {
  wpLastStatus?: string | null;
  wpLink?: string | null;
}): boolean {
  const status = (opts.wpLastStatus || "").trim().toLowerCase();
  if (status === "trash") return true;
  const link = (opts.wpLink || "").trim().toLowerCase();
  return link.includes("__trashed");
}

export function formatWordPressRestStatus(status: string | null | undefined): string {
  const s = (status || "").trim().toLowerCase();
  if (!s) return "";
  if (s === "publish") return "Published on WordPress";
  if (s === "draft") return "Draft on WordPress";
  if (s === "trash") return "Trashed on WordPress";
  if (s === "pending") return "Pending review on WordPress";
  if (s === "future") return "Scheduled on WordPress";
  return `WordPress: ${s}`;
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
  /** When true, UI may highlight unsynced edits; updates are allowed even when false. */
  hasPendingChanges?: boolean;
  busy: boolean;
}): boolean {
  if (!shouldShowWordPressUpdate(opts.ctx)) return false;
  if (!opts.websiteConnected || !opts.hasTitle || !opts.hasBody) return false;
  if (opts.busy) return false;
  const hasTarget =
    (opts.ctx.wpPostId != null && opts.ctx.wpPostId > 0) || (opts.ctx.wpLink || "").trim().length > 0;
  return hasTarget;
}
