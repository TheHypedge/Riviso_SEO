"use client";

import { useCallback, useEffect, useState } from "react";

import styles from "@/app/page.module.css";
import { ShopifyManualConnectGuide } from "@/components/shopify/ShopifyManualConnectGuide";
import { api } from "@/lib/api";

export type ShopifyConnectPanelProps = {
  projectId: string;
  shopUrl: string;
  onShopUrlChange: (value: string) => void;
  showGuide?: boolean;
  onConnected?: () => void;
  compact?: boolean;
};

export function ShopifyConnectPanel({
  projectId,
  shopUrl,
  onShopUrlChange,
  showGuide = true,
  onConnected,
  compact = false,
}: ShopifyConnectPanelProps) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.getProjectSettings(projectId, { skipGlobalLoading: true });
      if (s.shopify_client_id) setClientId(s.shopify_client_id);
    } catch {
      /* ignore */
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function connectStore() {
    const shop = shopUrl.trim();
    const cid = clientId.trim();
    const secret = clientSecret.trim();
    if (!shop || !cid || !secret) {
      setError("Enter store URL, Client ID, and Client secret.");
      return;
    }
    setConnecting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await api.connectShopify(projectId, {
        shop,
        client_id: cid,
        client_secret: secret,
      });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setClientSecret("");
      setSuccess(res.message);
      onConnected?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setConnecting(false);
    }
  }

  const labelClass = compact ? styles.label : styles.settingsFieldLabel;

  return (
    <div>
      {showGuide ? <ShopifyManualConnectGuide defaultOpen={!compact} /> : null}
      <label className={labelClass} style={{ marginTop: compact ? 14 : 16, display: "block" }}>
        Shopify store URL
        <input className={styles.input} value={shopUrl} onChange={(e) => onShopUrlChange(e.target.value)} placeholder="brandname.myshopify.com" />
      </label>
      <label className={labelClass} style={{ marginTop: 12, display: "block" }}>
        Client ID
        <input className={styles.input} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
      </label>
      <label className={labelClass} style={{ marginTop: 12, display: "block" }}>
        Client secret
        <input
          className={styles.input}
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder="shpss_…"
          autoComplete="off"
        />
      </label>
      {error ? <p className={styles.error} style={{ marginTop: 12 }}>{error}</p> : null}
      {success ? <p className={styles.muted} style={{ marginTop: 12, color: "rgba(150,191,72,0.95)" }}>{success}</p> : null}
      <div style={{ marginTop: 14 }}>
        <button
          type="button"
          className={styles.button}
          disabled={connecting || !shopUrl.trim() || !clientId.trim() || !clientSecret.trim()}
          onClick={() => void connectStore()}
        >
          {connecting ? "Connecting…" : "Connect store"}
        </button>
      </div>
    </div>
  );
}
