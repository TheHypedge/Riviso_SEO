"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import styles from "@/app/page.module.css";
import projectsDark from "@/app/projects/projectsDark.module.css";
import { FormFieldsSkeleton } from "@/components/skeleton";
import { ShopifyManualConnectGuide } from "@/components/shopify/ShopifyManualConnectGuide";
import { api, clearAuth, getAccessToken, invalidateProjectSettingsCache } from "@/lib/api";

export default function ConnectShopifyPage() {
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const projectId = params.projectId;

  const [shop, setShop] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    invalidateProjectSettingsCache(projectId);
    try {
      let proj = await api.getProject(projectId, { skipGlobalLoading: true });
      if ((proj.platform || "").toLowerCase() !== "shopify") {
        proj = await api.updateProject(projectId, { platform: "shopify" }, { skipGlobalLoading: true });
      }
      const settings = await api.getProjectSettings(projectId, { skipGlobalLoading: true });
      const hintUrl = (proj.website_url || settings.shopify_shop || "").trim();
      if (hintUrl) setShop(hintUrl);
      if (settings.shopify_client_id) setClientId(settings.shopify_client_id);
      if (
        (settings.shopify_verified_status || "").toLowerCase() === "connected" &&
        (settings.shopify_verified_at || "").trim()
      ) {
        router.replace(`/projects/${projectId}?tab=project_settings`);
      }
    } catch {
      /* form still usable */
    } finally {
      setLoading(false);
    }
  }, [projectId, router]);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace("/");
      setLoading(false);
      return;
    }
    void load();
  }, [load, router]);

  async function connectStore() {
    const shopInput = shop.trim();
    const cid = clientId.trim();
    const secret = clientSecret.trim();
    if (!shopInput || !cid || !secret) {
      setResult({ ok: false, message: "Enter store URL, Client ID, and Client secret." });
      return;
    }
    setConnecting(true);
    setResult(null);
    try {
      const res = await api.connectShopify(projectId, {
        shop: shopInput,
        client_id: cid,
        client_secret: secret,
      });
      setResult({ ok: res.ok, message: res.message });
      if (res.ok) {
        router.replace(`/projects/${projectId}?tab=project_settings`);
      }
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : "Connection failed" });
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className={projectsDark.shell}>
      <header className={projectsDark.topBar}>
        <Link href="/dashboard" className={styles.muted} style={{ fontSize: 13 }}>
          ← Back to dashboard
        </Link>
      </header>

      <main className={projectsDark.main} style={{ maxWidth: 560, margin: "0 auto" }}>
        <div className={styles.sectionCard} style={{ padding: 28 }}>
          <h1 style={{ margin: "0 0 8px", fontSize: 22 }}>Connect your Shopify store</h1>
          <p className={styles.muted} style={{ fontSize: 14, lineHeight: 1.55, marginBottom: 16 }}>
            Use your Developer Dashboard Client ID and Client secret. Riviso exchanges them for an Admin API token.
          </p>

          {loading ? (
            <FormFieldsSkeleton fields={3} />
          ) : (
            <>
              <ShopifyManualConnectGuide defaultOpen />
              <label className={styles.label} style={{ marginTop: 16 }}>
                Shopify store URL
                <input className={styles.input} value={shop} onChange={(e) => setShop(e.target.value)} placeholder="brandname.myshopify.com" />
              </label>
              <label className={styles.label}>
                Client ID
                <input className={styles.input} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
              </label>
              <label className={styles.label}>
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
              {result ? <p className={result.ok ? styles.muted : styles.error} style={{ marginTop: 12 }}>{result.message}</p> : null}
              <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className={styles.button}
                  disabled={connecting || !shop.trim() || !clientId.trim() || !clientSecret.trim()}
                  onClick={() => void connectStore()}
                >
                  {connecting ? "Connecting…" : "Connect store"}
                </button>
                <Link href={`/projects/${projectId}?tab=project_settings`} className={styles.btnSecondary} style={{ display: "inline-flex", alignItems: "center" }}>
                  Skip for now
                </Link>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
