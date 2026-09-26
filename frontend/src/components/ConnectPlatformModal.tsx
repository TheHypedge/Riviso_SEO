"use client";

import { useState } from "react";

import styles from "@/app/page.module.css";
import { ShopifyConnectPanel } from "@/components/shopify/ShopifyConnectPanel";
import { api, downloadWordpressPlugin } from "@/lib/api";
import type { ProjectSettings, WordpressVerifyResponse } from "@/lib/api";
import { resolveProjectPlatform, type ProjectPlatformKind } from "@/lib/projectPlatform";
import { useFocusTrap } from "@/lib/useFocusTrap";

type ConnectPlatformModalProps = {
  projectId: string;
  settings?: Pick<
    ProjectSettings,
    "platform" | "shopify_connected" | "shopify_shop" | "wp_site_url" | "website_url" | "plugin_download_url"
  > | null;
  onClose: () => void;
  /** Called once the platform is actually verified/connected -- caller closes
   * the modal and re-fetches whatever project/settings state it holds. */
  onConnected: () => void;
};

/** Inline "connect your website" flow shared by every "Connect Website to
 * Publish" entry point (article editor Publish button, the articles-list
 * banner, and the generic website-not-connected popup) -- so a user who
 * skipped connecting at project creation never has to leave the page they're
 * on to finish connecting. Always shows a platform switcher rather than
 * assuming WordPress, since a skipped project's `platform` field is just a
 * harmless creation-time default, not a real choice. */
export function ConnectPlatformModal({ projectId, settings, onClose, onConnected }: ConnectPlatformModalProps) {
  const [platform, setPlatform] = useState<ProjectPlatformKind>(() => resolveProjectPlatform({ settings }));
  const trapRef = useFocusTrap(true);

  const [shopifyShopUrl, setShopifyShopUrl] = useState(settings?.shopify_shop || "");

  const [wpUsername, setWpUsername] = useState("");
  const [wpAppPassword, setWpAppPassword] = useState("");
  const [wpVerifying, setWpVerifying] = useState(false);
  const [wpVerify, setWpVerify] = useState<WordpressVerifyResponse | null>(null);
  const [wpPluginError, setWpPluginError] = useState<string | null>(null);

  async function verifyWordPress() {
    setWpVerify(null);
    setWpVerifying(true);
    try {
      await api.updateProjectSettings(projectId, { wp_username: wpUsername, wp_app_password: wpAppPassword });
      const res = await api.verifyWordpress(projectId, { wp_username: wpUsername, wp_app_password: wpAppPassword });
      setWpVerify(res);
      if (res.ok) onConnected();
    } catch (e) {
      setWpVerify({ ok: false, status: "error", message: e instanceof Error ? e.message : "Verify failed" });
    } finally {
      setWpVerifying(false);
    }
  }

  return (
    <>
      <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={onClose} />
      <div ref={trapRef} className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Connect your website">
        <div className={styles.modalHead}>
          <h3 className={styles.modalTitle}>Connect your website</h3>
          <button type="button" className={styles.btnSecondary} onClick={onClose}>
            Close
          </button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.pbModeTabs} role="tablist" aria-label="Platform" style={{ marginBottom: 14 }}>
            <button
              role="tab"
              aria-selected={platform === "wordpress"}
              className={`${styles.pbModeBtn}${platform === "wordpress" ? ` ${styles.pbModeBtnActive}` : ""}`}
              type="button"
              onClick={() => setPlatform("wordpress")}
            >
              WordPress
            </button>
            <button
              role="tab"
              aria-selected={platform === "shopify"}
              className={`${styles.pbModeBtn}${platform === "shopify" ? ` ${styles.pbModeBtnActive}` : ""}`}
              type="button"
              onClick={() => setPlatform("shopify")}
            >
              Shopify
            </button>
          </div>

          {platform === "wordpress" ? (
            <div>
              <p className={styles.muted} style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>
                Connect your WordPress website so Riviso can publish generated articles. Add your WordPress
                username and an Application Password (Users &rarr; Profile &rarr; Application Passwords).
              </p>
              <label className={styles.label}>
                WordPress site URL
                <input className={styles.input} value={settings?.wp_site_url || settings?.website_url || ""} readOnly />
              </label>
              <label className={styles.label}>
                WordPress username
                <input className={styles.input} value={wpUsername} onChange={(e) => setWpUsername(e.target.value)} placeholder="e.g. admin" />
              </label>
              <label className={styles.label}>
                Application password
                <input
                  className={styles.input}
                  value={wpAppPassword}
                  onChange={(e) => setWpAppPassword(e.target.value)}
                  placeholder="xxxx xxxx xxxx xxxx"
                />
              </label>
              <div className={styles.row}>
                <button
                  className={styles.btnSecondary}
                  type="button"
                  onClick={async () => {
                    setWpPluginError(null);
                    try {
                      await downloadWordpressPlugin(settings?.plugin_download_url);
                    } catch (e) {
                      setWpPluginError(e instanceof Error ? e.message : "Could not download plugin.");
                    }
                  }}
                >
                  Download plugin
                </button>
                <button
                  className={styles.button}
                  type="button"
                  disabled={wpVerifying || !wpUsername.trim() || !wpAppPassword.trim()}
                  onClick={() => void verifyWordPress()}
                >
                  {wpVerifying ? "Verifying…" : "Verify"}
                </button>
              </div>
              {wpPluginError ? (
                <p role="alert" className={styles.error} style={{ fontSize: 13, marginTop: 8 }}>
                  {wpPluginError}
                </p>
              ) : null}
              {wpVerify ? (
                <p className={wpVerify.ok ? styles.muted : styles.error} style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
                  {wpVerify.message}
                </p>
              ) : null}
            </div>
          ) : (
            <ShopifyConnectPanel
              projectId={projectId}
              shopUrl={shopifyShopUrl}
              onShopUrlChange={setShopifyShopUrl}
              onConnected={onConnected}
            />
          )}
        </div>
        <div className={styles.modalFooter}>
          <button type="button" className={styles.btnSecondary} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}
