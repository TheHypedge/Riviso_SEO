"use client";

import styles from "@/app/page.module.css";

import {
  SHOPIFY_CONFUSABLE_SCOPES,
  SHOPIFY_PRODUCT_MAPPING_SCOPES,
  SHOPIFY_PUBLISH_SCOPES,
} from "@/lib/shopifyScopes";

const ADMIN_API_SCOPES = [
  {
    group: "Products",
    scopes: ["read_products", "write_products", "read_product_listings", "write_product_listings"],
    required: ["read_products"],
  },
  {
    group: "Store content (blogs)",
    scopes: ["read_content", "write_content"],
    required: ["read_content", "write_content"],
  },
] as const;

const STEPS = [
  <>
    In the <strong>Shopify Developer Dashboard</strong> (<code>dev.shopify.com</code>), open your app (e.g.{" "}
    <strong>Riviso SEO</strong>).
  </>,
  <>
    Go to <strong>Versions</strong> → <strong>Select scopes</strong> → <strong>All APIs</strong> and enable these
    Admin API checkboxes (same labels as Shopify):
    <ul style={{ margin: "8px 0 0", paddingLeft: "1.2rem" }}>
      {ADMIN_API_SCOPES.map((g) => (
        <li key={g.group} style={{ marginBottom: 8 }}>
          <strong>{g.group}</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: "1.1rem" }}>
            {g.scopes.map((s) => (
              <li key={s}>
                <code>{s}</code>
                {(g.required as readonly string[]).includes(s) ? " — required" : " — optional"}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  </>,
  <>
    Click <strong>Release</strong> on the version (saved scopes are not active until released), then on{" "}
    <strong>Overview</strong> click <strong>Install app</strong> on this store.
  </>,
  <>
    Copy <strong>Client ID</strong> and <strong>Client secret</strong> (<code>shpss_…</code>) from{" "}
    <strong>Settings</strong>.
  </>,
  <>
    Paste store URL + credentials below, then <strong>Connect store</strong> or <strong>Refresh connection</strong>.
    Riviso exchanges credentials for an API token that includes only scopes Shopify granted on this store.
  </>,
];

type Props = {
  defaultOpen?: boolean;
};

export function ShopifyManualConnectGuide({ defaultOpen = true }: Props) {
  return (
    <details className={styles.shopifyConnectGuide} open={defaultOpen}>
      <summary className={styles.shopifyConnectGuideSummary}>
        How to connect with Developer Dashboard credentials
      </summary>
      <ol className={styles.shopifyConnectGuideList}>
        {STEPS.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <p className={styles.muted} style={{ fontSize: 12, margin: "10px 0 0", lineHeight: 1.45 }}>
        <strong>Product-aware generation</strong> needs <code>read_products</code> (handles + featured images) and{" "}
        <code>read_content</code> (blogs). Optional: <code>write_content</code>, <code>write_products</code>.
      </p>
      <table className={styles.table} style={{ marginTop: 10, fontSize: 11 }}>
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
              <td className={styles.td}>{row.required ? "Yes" : "No"}</td>
              <td className={styles.td}>{row.purpose}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.muted} style={{ fontSize: 11, margin: "10px 0 0", lineHeight: 1.45 }}>
        <strong>Not catalog access:</strong>{" "}
        {SHOPIFY_CONFUSABLE_SCOPES.map((c) => (
          <span key={c.scope}>
            <code>{c.scope}</code> — {c.note}{" "}
          </span>
        ))}
      </p>
      <p className={styles.muted} style={{ fontSize: 12, margin: "10px 0 0", lineHeight: 1.45 }}>
        After enabling scopes, click <strong>Release</strong>, <strong>Update app permissions</strong> in Riviso, then{" "}
        <strong>Sync from Shopify</strong> on the Products tab.
      </p>
    </details>
  );
}
