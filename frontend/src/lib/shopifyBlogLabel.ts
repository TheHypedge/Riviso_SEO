/** Human-readable label for a synced Shopify blog (container), not a single post. */

export type ShopifyBlogRow = {
  id?: number;
  title?: string;
  handle?: string;
  articles_count?: number;
};

export function formatShopifyBlogOptionLabel(b: ShopifyBlogRow): string {
  const title = (b.title || b.handle || "Blog").trim();
  const handle = (b.handle || "").trim();
  const count = typeof b.articles_count === "number" ? b.articles_count : null;
  const posts =
    count === null ? "" : ` · ${count} post${count === 1 ? "" : "s"}`;
  const path = handle ? ` · /blogs/${handle}` : "";
  return `${title} (blog channel${posts}${path})`;
}

export const SHOPIFY_BLOG_CHANNEL_HELP =
  "Shopify separates blogs (channels) from blog posts. Most stores include a default blog named News even with zero posts. " +
  "Content → Blog posts in Admin lists posts; use Manage blogs to rename or add channels.";
