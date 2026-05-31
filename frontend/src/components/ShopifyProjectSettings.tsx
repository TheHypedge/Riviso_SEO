"use client";

import { useCallback, useEffect, useState } from "react";

import styles from "@/app/page.module.css";
import { ShopifyManualConnectGuide } from "@/components/shopify/ShopifyManualConnectGuide";
import { api, type ProjectSettings } from "@/lib/api";

type Props = {
  projectId: string;
  name: string;
  storeUrl: string;
  clientId: string;
  settings: ProjectSettings;
  productAwareEnabled?: boolean;
  onProductAwareEnabledChange?: (value: boolean) => void;
  onNameChange: (value: string) => void;
  onStoreUrlChange: (value: string) => void;
  onClientIdChange: (value: string) => void;
  onConnectionChange?: () => void;
  onSettingsSaved?: (saved: ProjectSettings) => void;
};

export function ShopifyProjectSettings({
  projectId,
  name,
  storeUrl,
  settings,
  productAwareEnabled,
  onProductAwareEnabledChange,
  clientId,
  onNameChange,
  onStoreUrlChange,
  onClientIdChange,
  onConnectionChange,
  onSettingsSaved,
}: Props) {
  const [clientSecret, setClientSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reauthorizing, setReauthorizing] = useState(false);
  const [actionResult, setActionResult] = useState<{ ok: boolean; message: string } | null>(null);

  const status = (settings.shopify_verified_status || "").toLowerCase();
  const verifiedAt = (settings.shopify_verified_at || "").trim();
  let pillLabel = "Not connected";
  let pillState: "verified" | "warning" | "failed" | "pending" = "pending";
  let pillTitle = "Enter store URL, Client ID, and Client Secret, then connect. Requires read_products scope for catalog sync.";
  if (status === "connected" && verifiedAt) {
    pillLabel = "Verified";
    pillState = "verified";
    pillTitle = `Last verified ${verifiedAt} UTC.`;
  } else if (status === "auth_failed") {
    pillLabel = "Auth failed";
    pillState = "failed";
    pillTitle = settings.shopify_verified_message || "Check Client ID and Secret in Developer Dashboard.";
  } else if (status === "failed" || status === "error") {
    pillLabel = "Connection failed";
    pillState = "failed";
    pillTitle = settings.shopify_verified_message || "Could not connect to Shopify.";
  } else if (settings.shopify_client_secret_set && storeUrl.trim()) {
    pillLabel = "Not verified yet";
    pillState = "warning";
    pillTitle = "Credentials saved — verify or refresh connection.";
  }

  const buildSettingsPatch = useCallback(() => {
    const shop = storeUrl.trim();
    const patch: Parameters<typeof api.updateProjectSettings>[1] = {
      name: name.trim(),
      website_url: shop,
      shopify_shop: shop,
      shopify_client_id: clientId.trim(),
    };
    const secret = clientSecret.trim();
    if (secret) {
      patch.shopify_client_secret = secret;
    }
    return patch;
  }, [name, storeUrl, clientId, clientSecret]);

  const persistFormFields = useCallback(async () => {
    const saved = await api.updateProjectSettings(projectId, buildSettingsPatch());
    onSettingsSaved?.(saved);
    return saved;
  }, [projectId, buildSettingsPatch, onSettingsSaved]);

  const verifyPayload = useCallback(() => {
    const shop = storeUrl.trim();
    const secret = clientSecret.trim();
    return {
      shop,
      client_id: clientId.trim(),
      ...(secret ? { client_secret: secret } : {}),
    };
  }, [storeUrl, clientId, clientSecret]);

  const canUseStoredSecret = settings.shopify_client_secret_set;
  const credentialsReady =
    Boolean(storeUrl.trim()) && Boolean(clientId.trim()) && (Boolean(clientSecret.trim()) || canUseStoredSecret);

  async function openReauthorizeUrl(explicitUrl?: string | null) {
    setReauthorizing(true);
    setActionResult(null);
    try {
      const url =
        explicitUrl ||
        (
          await api.getShopifyReauthorizeUrl(projectId, {
            shop: storeUrl.trim(),
          })
        ).url;
      if (!url) {
        setActionResult({ ok: false, message: "Could not build Shopify permission URL." });
        return;
      }
      window.location.href = url;
    } catch (e) {
      setActionResult({
        ok: false,
        message: e instanceof Error ? e.message : "Could not open Shopify permissions",
      });
    } finally {
      setReauthorizing(false);
    }
  }

  async function connectStore() {
    const secret = clientSecret.trim();
    if (!storeUrl.trim() || !clientId.trim() || !secret) {
      setActionResult({
        ok: false,
        message: "Enter Shopify store URL, Client ID, and Client Secret.",
      });
      return;
    }
    setConnecting(true);
    setActionResult(null);
    try {
      await persistFormFields();
      const res = await api.connectShopify(projectId, {
        shop: storeUrl.trim(),
        client_id: clientId.trim(),
        client_secret: secret,
      });
      if (res.needs_reauthorize && res.reauthorize_url) {
        setActionResult({
          ok: false,
          message: `${res.message} Opening Shopify to update permissions…`,
        });
        await openReauthorizeUrl(res.reauthorize_url);
        return;
      }
      setActionResult({ ok: res.ok, message: res.message });
      if (res.ok) {
        setClientSecret("");
        onConnectionChange?.();
      }
    } catch (e) {
      setActionResult({
        ok: false,
        message: e instanceof Error ? e.message : "Connection failed",
      });
    } finally {
      setConnecting(false);
    }
  }

  async function verifyConnection() {
    if (!credentialsReady) {
      setActionResult({
        ok: false,
        message: "Enter store URL, Client ID, and Client Secret (or use saved secret).",
      });
      return;
    }
    setVerifying(true);
    setActionResult(null);
    try {
      await persistFormFields();
      const res = await api.verifyShopifyConnection(projectId, verifyPayload());
      if (res.needs_reauthorize && res.reauthorize_url) {
        setActionResult({
          ok: false,
          message: `${res.message} Opening Shopify to update permissions…`,
        });
        await openReauthorizeUrl(res.reauthorize_url);
        return;
      }
      setActionResult({ ok: res.ok, message: res.message });
      if (res.ok) {
        setClientSecret("");
        onConnectionChange?.();
      }
    } catch (e) {
      setActionResult({
        ok: false,
        message: e instanceof Error ? e.message : "Verify failed",
      });
    } finally {
      setVerifying(false);
    }
  }

  async function refreshConnection() {
    if (!credentialsReady) {
      setActionResult({
        ok: false,
        message: "Save credentials first, then refresh.",
      });
      return;
    }
    setRefreshing(true);
    setActionResult(null);
    try {
      await persistFormFields();
      const syncRes = await api.syncShopifyCatalog(projectId);
      const syncMsg = (syncRes.sync_message || "New API token issued and catalog synced.").trim();
      setActionResult({ ok: true, message: syncMsg });
      setClientSecret("");
      onConnectionChange?.();
    } catch (e) {
      setActionResult({
        ok: false,
        message: e instanceof Error ? e.message : "Refresh failed",
      });
    } finally {
      setRefreshing(false);
    }
  }

  const secretRequired = !clientSecret.trim() && !settings.shopify_client_secret_set;
  const busy = connecting || verifying || refreshing || reauthorizing;

  return (
    <section className={styles.settingsSectionCard}>
      <div className={styles.wpConnectionHead}>
        <div>
          <p className={styles.settingsSectionKicker}>Website</p>
          <h3 className={styles.settingsSectionTitle}>Shopify connection</h3>
          <p className={styles.settingsSectionDesc}>
            Connect with your store URL and Developer Dashboard credentials. Riviso exchanges Client ID + secret for an
            API token. Your app version must include <strong>read_products</strong> (Products sync),{" "}
            <strong>read_content</strong> and <strong>write_content</strong> (blog publish).
          </p>
        </div>
        <span className={styles.wpStatusPill} data-state={pillState} title={pillTitle}>
          {pillLabel}
          {pillState === "verified" && verifiedAt ? (
            <span className={styles.wpStatusPillTime}> · {verifiedAt} UTC</span>
          ) : null}
        </span>
      </div>

      {!verifiedAt ? <ShopifyManualConnectGuide defaultOpen /> : null}

      <div className={styles.settingsFieldsGrid}>
        <label className={styles.settingsFieldLabel}>
          Project display name
          <input className={styles.input} value={name} onChange={(e) => onNameChange(e.target.value)} />
        </label>
        <label className={styles.settingsFieldLabel}>
          Shopify store URL
          <input
            className={styles.input}
            value={storeUrl}
            onChange={(e) => onStoreUrlChange(e.target.value)}
            placeholder="brandname.myshopify.com"
            autoComplete="url"
            inputMode="url"
          />
        </label>
        <label className={styles.settingsFieldLabel}>
          Client ID
          <input
            className={styles.input}
            value={clientId}
            onChange={(e) => onClientIdChange(e.target.value)}
            placeholder="From Developer Dashboard → Settings"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className={styles.settingsFieldLabel}>
          Client secret
          <span className={styles.authPasswordWrap}>
            <input
              className={`${styles.input} ${styles.authPasswordInput}`}
              value={clientSecret}
              type={showSecret ? "text" : "password"}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={
                settings.shopify_client_secret_set && !clientSecret
                  ? "•••••• (saved — paste to update)"
                  : "shpss_… from Developer Dashboard → Settings"
              }
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className={styles.authToggle}
              onClick={() => setShowSecret((v) => !v)}
              aria-label={showSecret ? "Hide client secret" : "Show client secret"}
            >
              {showSecret ? "×" : "👁"}
            </button>
          </span>
          {settings.shopify_client_secret_set ? (
            <span className={styles.muted} style={{ fontSize: 11, marginTop: 4, display: "block" }}>
              Client secret is stored securely. Leave blank to keep the saved value; paste only when rotating the secret.
            </span>
          ) : null}
        </label>
      </div>

      <div className={styles.wpConnectionActions}>
        <button
          type="button"
          className={styles.button}
          disabled={busy || !storeUrl.trim() || !clientId.trim() || secretRequired}
          onClick={() => void connectStore()}
        >
          {connecting ? "Connecting…" : "Connect store"}
        </button>
        <button
          type="button"
          className={styles.btnSecondary}
          disabled={busy || !credentialsReady}
          onClick={() => void verifyConnection()}
          title="Exchange credentials, verify shop access, and sync catalog"
        >
          {verifying ? "Verifying…" : "Verify connection"}
        </button>
        <button
          type="button"
          className={styles.btnSecondary}
          disabled={busy || !credentialsReady}
          onClick={() => void refreshConnection()}
          title="Issue a new API token and re-sync products, blogs, and pages"
        >
          {refreshing ? "Refreshing…" : "Refresh connection"}
        </button>
        <button
          type="button"
          className={styles.btnSecondary}
          disabled={busy || !storeUrl.trim() || !clientId.trim() || secretRequired}
          onClick={() => void openReauthorizeUrl()}
          title="Run Shopify OAuth to apply new scopes after you release an app version (required for read_products)"
        >
          {reauthorizing ? "Opening Shopify…" : "Update app permissions"}
        </button>
      </div>

      {actionResult ? (
        <p className={actionResult.ok ? styles.muted : styles.error} style={{ marginTop: 12, fontSize: 13 }}>
          {actionResult.message}
        </p>
      ) : null}

      {settings.shopify_verified_message && !actionResult ? (
        <p className={styles.muted} style={{ marginTop: 10, fontSize: 13, lineHeight: 1.5 }}>
          {settings.shopify_verified_message}
        </p>
      ) : null}

      {settings.shopify_shop ? (
        <p className={styles.muted} style={{ fontSize: 13, marginTop: 10 }}>
          Shopify admin: <strong>{settings.shopify_shop}</strong>
          {settings.shopify_access_token_set ? " · API token active" : null}
        </p>
      ) : null}

      <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid color-mix(in oklab, var(--aa-hairline), transparent 12%)` }}>
        <label className={styles.settingsFieldLabel} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            type="checkbox"
            checked={Boolean(productAwareEnabled)}
            onChange={(e) => onProductAwareEnabledChange?.(e.target.checked)}
          />
          <span>
            <strong>Product-aware blog generation</strong>
            <div className={styles.muted} style={{ fontSize: 12, marginTop: 4, lineHeight: 1.45 }}>
              When enabled, Riviso pulls relevant products from this project&apos;s Shopify catalog.
            </div>
          </span>
        </label>
      </div>
    </section>
  );
}
