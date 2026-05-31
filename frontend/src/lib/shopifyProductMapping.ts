/** Payload shape for POST .../generate and topic-cluster generate-all. */

export type MappedShopifyProduct = {
  title: string;
  handle: string;
  featured_image_url?: string | null;
  image_url?: string | null;
};

export type ShopifyCatalogProduct = {
  id?: number;
  title?: string;
  handle?: string;
  image_url?: string;
  status?: string;
};

export function catalogProductToMapped(p: ShopifyCatalogProduct): MappedShopifyProduct | null {
  const title = (p.title || "").trim();
  const handle = (p.handle || "").trim();
  if (!title || !handle) return null;
  const image = (p.image_url || "").trim();
  return {
    title,
    handle,
    featured_image_url: image || null,
    image_url: image || null,
  };
}

export function toggleMappedProduct(
  current: MappedShopifyProduct[],
  product: MappedShopifyProduct,
  maxItems: number,
): MappedShopifyProduct[] {
  const key = product.handle;
  const idx = current.findIndex((x) => x.handle === key);
  if (idx >= 0) {
    return current.filter((_, i) => i !== idx);
  }
  if (current.length >= maxItems) {
    return [...current.slice(1), product];
  }
  return [...current, product];
}

export function isProductMapped(current: MappedShopifyProduct[], handle: string): boolean {
  return current.some((p) => p.handle === handle);
}
