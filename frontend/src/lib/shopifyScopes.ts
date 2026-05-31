/**
 * Shopify Admin API scopes for Riviso — enable in Dev Dashboard → Versions → Release → Update app permissions.
 */

export type ShopifyScopeDoc = {
  scope: string;
  required: boolean;
  group: string;
  purpose: string;
};

/** Product mapping + catalog sync */
export const SHOPIFY_PRODUCT_MAPPING_SCOPES: ShopifyScopeDoc[] = [
  {
    scope: "read_products",
    required: true,
    group: "Products",
    purpose: "Product titles, handles (/products/{handle}), and featured image URLs.",
  },
  {
    scope: "write_products",
    required: false,
    group: "Products",
    purpose: "Optional — update product data from Riviso later.",
  },
  {
    scope: "read_product_listings",
    required: false,
    group: "Listings (optional)",
    purpose: "Sales channel listings — does not replace read_products for catalog.",
  },
  {
    scope: "write_product_listings",
    required: false,
    group: "Listings (optional)",
    purpose: "Write listings — not required for blog publish or catalog sync.",
  },
];

/** Direct post to Shopify blog (draft or live) */
export const SHOPIFY_PUBLISH_SCOPES: ShopifyScopeDoc[] = [
  {
    scope: "read_content",
    required: true,
    group: "Store content",
    purpose: "List blogs and read existing blog articles.",
  },
  {
    scope: "write_content",
    required: true,
    group: "Store content",
    purpose: "Create blog articles as draft or published.",
  },
];

export const SHOPIFY_ALL_RECOMMENDED_SCOPES: ShopifyScopeDoc[] = [
  ...SHOPIFY_PRODUCT_MAPPING_SCOPES.filter((s) => s.required || s.scope.startsWith("read_") || s.scope.startsWith("write_content")),
  ...SHOPIFY_PUBLISH_SCOPES,
];

/** Scopes that do NOT replace read_products */
export const SHOPIFY_CONFUSABLE_SCOPES: { scope: string; note: string }[] = [
  {
    scope: "read_product_listings",
    note: "Listings only — not the Admin API product catalog.",
  },
  {
    scope: "read_product_feeds",
    note: "Feeds only — not product records or images.",
  },
];

export function requiredScopeNames(): string[] {
  return [
    ...SHOPIFY_PRODUCT_MAPPING_SCOPES.filter((s) => s.required).map((s) => s.scope),
    ...SHOPIFY_PUBLISH_SCOPES.filter((s) => s.required).map((s) => s.scope),
  ];
}
