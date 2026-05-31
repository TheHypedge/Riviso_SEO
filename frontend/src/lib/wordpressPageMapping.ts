/** Payload shape for WordPress mapped internal pages on generate. */

export type MappedWordPressPage = {
  title: string;
  post_url: string;
  featured_image_url?: string | null;
  image_url?: string | null;
  post_id?: string | null;
};

export type SiteMapEntry = {
  post_url?: string;
  post_title?: string;
  focus_keyphrase?: string;
  featured_image_url?: string;
  post_id?: string;
};

export function siteMapEntryToMapped(entry: SiteMapEntry): MappedWordPressPage | null {
  const title = (entry.post_title || "").trim();
  const post_url = (entry.post_url || "").trim();
  if (!title || !post_url) return null;
  const image = (entry.featured_image_url || "").trim();
  return {
    title,
    post_url,
    featured_image_url: image || null,
    image_url: image || null,
    post_id: (entry.post_id || "").trim() || null,
  };
}

export function toggleMappedPage(
  current: MappedWordPressPage[],
  page: MappedWordPressPage,
  maxItems: number,
): MappedWordPressPage[] {
  const key = page.post_url;
  const idx = current.findIndex((x) => x.post_url === key);
  if (idx >= 0) {
    return current.filter((_, i) => i !== idx);
  }
  if (current.length >= maxItems) {
    return [...current.slice(1), page];
  }
  return [...current, page];
}

export function isPageMapped(current: MappedWordPressPage[], postUrl: string): boolean {
  return current.some((p) => p.post_url === postUrl);
}
