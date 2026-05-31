"use client";

import styles from "@/app/page.module.css";
import { InlineListSkeleton } from "@/components/skeleton";
import {
  catalogProductToMapped,
  isProductMapped,
  toggleMappedProduct,
  type MappedShopifyProduct,
  type ShopifyCatalogProduct,
} from "@/lib/shopifyProductMapping";
import {
  SHOPIFY_CONFUSABLE_SCOPES,
  SHOPIFY_PRODUCT_MAPPING_SCOPES,
  SHOPIFY_PUBLISH_SCOPES,
} from "@/lib/shopifyScopes";

type Props = {
  products: ShopifyCatalogProduct[];
  value: MappedShopifyProduct[];
  onChange: (next: MappedShopifyProduct[]) => void;
  maxItems?: number;
  loading?: boolean;
  /** When true, picker only works if Project Settings → Product-aware is on. */
  requireProductAwareToggle?: boolean;
  productAwareEnabled?: boolean;
  grantedScopes?: string[];
  compact?: boolean;
};

export function ShopifyProductMapPicker({
  products,
  value,
  onChange,
  maxItems = 3,
  loading = false,
  requireProductAwareToggle = false,
  productAwareEnabled = true,
  grantedScopes = [],
  compact = false,
}: Props) {
  const activeProducts = products.filter((p) => {
    const st = String(p.status || "").trim().toLowerCase();
    return st === "active";
  });

  if (requireProductAwareToggle && !productAwareEnabled) {
    return (
      <p className={styles.muted} style={{ fontSize: 12, lineHeight: 1.5, margin: "12px 0 0" }}>
        Turn on <strong>Product-aware articles</strong> in Project Settings → Shopify to weave product links and
        optional featured-image references into generated content.
      </p>
    );
  }

  const missingReadProducts = grantedScopes.length > 0 && !grantedScopes.includes("read_products");

  return (
    <div style={{ marginTop: compact ? 8 : 14, display: "grid", gap: 10 }}>
      <div>
        <div style={{ fontWeight: 800, fontSize: 13, color: "rgba(255,255,255,0.92)" }}>Map active products</div>
        <p className={styles.muted} style={{ margin: "6px 0 0", fontSize: 12, lineHeight: 1.5 }}>
          Showing <strong>active</strong> products only. Select up to {maxItems} — Riviso adds{" "}
          <code>/products/&#123;handle&#125;</code> links in the article and uses the first product&apos;s featured
          image as a style reference for the generated hero image when available.
        </p>
      </div>

      {missingReadProducts ? (
        <div
          style={{
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid color-mix(in oklab, #e6b422, transparent 45%)",
            background: "color-mix(in oklab, #e6b422 10%, transparent)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <strong>Missing `read_products` on your store token.</strong> Sync products in Project Settings → Shopify
          after enabling scopes below and clicking <strong>Update app permissions</strong>.
        </div>
      ) : null}

      {loading ? (
        <InlineListSkeleton rows={5} />
      ) : activeProducts.length === 0 ? (
        <p className={styles.muted} style={{ fontSize: 12, lineHeight: 1.5 }}>
          No <strong>active</strong> products in the catalog snapshot. Open the <strong>Products</strong> tab and click{" "}
          <strong>Sync from Shopify</strong>, or enable <code>read_products</code> (see scopes below).
        </p>
      ) : (
        <div
          style={{
            maxHeight: compact ? 200 : 260,
            overflowY: "auto",
            border: "1px solid var(--button-secondary-border)",
            borderRadius: 10,
            padding: 8,
            display: "grid",
            gap: 6,
          }}
        >
          {activeProducts.map((p) => {
            const mapped = catalogProductToMapped(p);
            if (!mapped) return null;
            const checked = isProductMapped(value, mapped.handle);
            return (
              <label
                key={mapped.handle}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 10px",
                  borderRadius: 8,
                  cursor: "pointer",
                  background: checked ? "rgba(217,119,87,0.12)" : "rgba(255,255,255,0.03)",
                  border: checked
                    ? "1px solid rgba(217,119,87,0.45)"
                    : "1px solid transparent",
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onChange(toggleMappedProduct(value, mapped, maxItems))}
                />
                {p.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.image_url}
                    alt=""
                    width={36}
                    height={36}
                    style={{ width: 36, height: 36, borderRadius: 8, objectFit: "cover" }}
                  />
                ) : (
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: "rgba(255,255,255,0.06)",
                    }}
                  />
                )}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontWeight: 700, fontSize: 13 }}>{mapped.title}</span>
                  <span className={styles.muted} style={{ fontSize: 11 }}>
                    /products/{mapped.handle}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}

      {value.length > 0 ? (
        <p className={styles.muted} style={{ fontSize: 11, margin: 0 }}>
          Selected: {value.map((p) => p.title).join(" · ")}
        </p>
      ) : null}

      <details className={styles.shopifyConnectGuide} style={{ marginTop: 4 }}>
        <summary className={styles.shopifyConnectGuideSummary} style={{ fontSize: 12 }}>
          Shopify app scopes for product mapping
        </summary>
        <table className={styles.table} style={{ marginTop: 8, fontSize: 11 }}>
          <thead>
            <tr>
              <th className={styles.th}>Scope</th>
              <th className={styles.th}>Required</th>
              <th className={styles.th}>Purpose</th>
            </tr>
          </thead>
          <tbody>
            {SHOPIFY_PRODUCT_MAPPING_SCOPES.map((row) => (
              <tr key={row.scope}>
                <td className={styles.td}>
                  <code>{row.scope}</code>
                </td>
                <td className={styles.td}>{row.required ? "Yes" : "Optional"}</td>
                <td className={styles.td}>{row.purpose}</td>
              </tr>
            ))}
            {SHOPIFY_PUBLISH_SCOPES.map((row) => (
              <tr key={`pub-${row.scope}`}>
                <td className={styles.td}>
                  <code>{row.scope}</code>
                </td>
                <td className={styles.td}>{row.required ? "Yes" : "Optional"}</td>
                <td className={styles.td}>{row.purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.muted} style={{ fontSize: 11, marginTop: 10, lineHeight: 1.45 }}>
          <strong>Not sufficient for catalog:</strong>{" "}
          {SHOPIFY_CONFUSABLE_SCOPES.map((c) => (
            <span key={c.scope}>
              <code>{c.scope}</code> ({c.note}){" "}
            </span>
          ))}
        </p>
        <p className={styles.muted} style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
          After enabling scopes: <strong>Release</strong> the app version → <strong>Update app permissions</strong> in
          Riviso → <strong>Sync from Shopify</strong> on the Products tab.
        </p>
      </details>
    </div>
  );
}
