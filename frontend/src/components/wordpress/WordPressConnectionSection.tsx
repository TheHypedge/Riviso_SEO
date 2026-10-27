"use client";

import { useState } from "react";

import { Hint } from "@/components/settings/Hint";
import { WordPressBulkSyncButton } from "@/components/WordPressBulkSyncButton";
import type { ProjectSettings } from "@/lib/api";

import s from "@/components/settings/settingsCard.module.css";

type BadgeState = "ok" | "warn" | "error" | "idle";
type Badge = { label: string; state: BadgeState; detail: string };

function connectionBadge(settings: ProjectSettings): Badge {
  const status = (settings.wp_verified_status || "").toLowerCase();
  const at = (settings.wp_verified_at || "").trim();
  if (status === "connected" && at) return { label: "Connected", state: "ok", detail: `Last verified ${at} UTC.` };
  if (status === "auth_failed")
    return { label: "Auth failed", state: "error", detail: settings.wp_verified_message || "Check the username and application password." };
  if (status === "failed" || status === "error")
    return { label: "Verification failed", state: "error", detail: settings.wp_verified_message || "Could not reach the WordPress REST API." };
  if (settings.wp_app_password_set && (settings.wp_site_url || settings.website_url))
    return { label: "Not verified", state: "warn", detail: "Credentials are saved but have not been verified. Click Verify connection." };
  return { label: "Not connected", state: "idle", detail: "Enter your site details below and click Verify connection." };
}

function pluginBadge(settings: ProjectSettings): Badge | null {
  const msg = (settings.wp_plugin_message || "").trim();
  switch ((settings.wp_plugin_status || "").toLowerCase()) {
    case "active":
      return { label: "Plugin active", state: "ok", detail: msg || "The RivisoSEO plugin is installed and responding." };
    case "upgrade_required":
      return { label: "Plugin update needed", state: "warn", detail: msg || "Download the latest plugin and upload it in WordPress → Plugins." };
    case "installed":
      return { label: "Plugin unreachable", state: "warn", detail: msg || "The plugin is installed but its /ping route was rejected." };
    case "capability":
      return { label: "Plugin blocked", state: "error", detail: msg || "The WordPress user needs the Editor or Administrator role." };
    case "missing":
      return { label: "Plugin not installed", state: "error", detail: msg || "Download the plugin and activate it in WordPress → Plugins." };
    case "unknown":
      return { label: "Plugin unknown", state: "warn", detail: msg || "Could not reach the WordPress REST index." };
    default:
      return null;
  }
}

function StatusBadge({ badge }: { badge: Badge }) {
  return (
    <Hint
      label={badge.detail}
      trigger={
        <span className={s.badge} data-state={badge.state} tabIndex={0}>
          <span className={s.badgeDot} aria-hidden="true" />
          {badge.label}
        </span>
      }
    >
      {badge.detail}
    </Hint>
  );
}

const EyeIcon = ({ off }: { off?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
    {off ? <path d="M3 3l18 18" /> : null}
  </svg>
);

const DownloadIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
  </svg>
);

type Props = {
  projectId: string;
  settings: ProjectSettings;
  name: string;
  onName: (v: string) => void;
  url: string;
  onUrl: (v: string) => void;
  user: string;
  onUser: (v: string) => void;
  pass: string;
  onPass: (v: string) => void;
  schemaEnabled: boolean;
  onSchemaEnabled: (v: boolean) => void;
  verifying: boolean;
  onVerify: () => void;
  verifyResult: { ok: boolean; message: string } | null;
  onDownloadPlugin: () => void;
};

/** Project Settings → WordPress connection: credentials, status, plugin, schema markup. */
export function WordPressConnectionSection(p: Props) {
  const [showPass, setShowPass] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const conn = connectionBadge(p.settings);
  const plugin = pluginBadge(p.settings);
  const connected = conn.state === "ok";
  const missingPass = !p.pass.trim() && !p.settings.wp_app_password_set;
  const verifyDisabled = p.verifying || !p.url.trim() || !p.user.trim() || missingPass;

  return (
    <section className={s.card} aria-labelledby="wp-connection-title">
      <header className={s.head}>
        <div className={s.titleRow}>
          <h3 id="wp-connection-title" className={s.title}>
            WordPress connection
          </h3>
          <Hint label="How to connect WordPress">
            <strong className={s.tooltipTitle}>How to connect</strong>
            <ol className={s.tooltipList}>
              <li>Download the RivisoSEO plugin and activate it in WordPress → Plugins.</li>
              <li>In WordPress → Users → Profile, create an Application Password.</li>
              <li>Enter your site URL, WordPress username and that password, then click Verify connection.</li>
            </ol>
            Riviso publishes articles through the WordPress REST API — your login password is never used.
          </Hint>
        </div>
        <div className={s.badges}>
          <StatusBadge badge={conn} />
          {plugin ? <StatusBadge badge={plugin} /> : null}
        </div>
      </header>

      <div className={s.grid}>
        <label className={s.field}>
          <span className={s.label}>Project display name</span>
          <input className={s.input} value={p.name} onChange={(e) => p.onName(e.target.value)} />
        </label>
        <label className={s.field}>
          <span className={s.label}>Site URL</span>
          <input
            className={s.input}
            value={p.url}
            onChange={(e) => p.onUrl(e.target.value)}
            placeholder="https://example.com"
            autoComplete="url"
            inputMode="url"
          />
        </label>
        <label className={s.field}>
          <span className={s.label}>WordPress username</span>
          <input
            className={s.input}
            value={p.user}
            onChange={(e) => p.onUser(e.target.value)}
            placeholder="Login username"
            autoComplete="username"
          />
        </label>
        <div className={s.field}>
          <span className={s.labelRow}>
            <label className={s.label} htmlFor="wp-app-password">
              Application password
            </label>
            <a
              className={s.helpLink}
              href="https://wordpress.org/documentation/article/application-passwords/"
              target="_blank"
              rel="noopener noreferrer"
            >
              How to create ↗
            </a>
          </span>
          <span className={s.passWrap}>
            <input
              id="wp-app-password"
              className={s.input}
              value={p.pass}
              type={showPass ? "text" : "password"}
              onChange={(e) => p.onPass(e.target.value)}
              placeholder={p.settings.wp_app_password_set ? "Saved — paste a new one to replace" : "xxxx xxxx xxxx xxxx xxxx xxxx"}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className={s.eyeBtn}
              onClick={() => setShowPass((v) => !v)}
              aria-label={showPass ? "Hide application password" : "Show application password"}
            >
              <EyeIcon off={showPass} />
            </button>
          </span>
        </div>
      </div>

      <div className={s.actions}>
        <button type="button" className={s.btnGhost} onClick={p.onDownloadPlugin}>
          <DownloadIcon />
          Download plugin
        </button>
        <div className={s.actionsRight}>
          <WordPressBulkSyncButton
            projectId={p.projectId}
            disabled={!connected}
            className={s.btnSecondary}
            onMessage={setSyncMsg}
          />
          <button
            type="button"
            className={s.btnPrimary}
            onClick={p.onVerify}
            disabled={verifyDisabled}
            title={missingPass ? "Enter the application password first." : undefined}
          >
            {p.verifying ? "Verifying…" : connected ? "Re-verify" : "Verify connection"}
          </button>
        </div>
      </div>

      {p.verifyResult ? (
        <div className={s.alert} data-tone={p.verifyResult.ok ? "ok" : "error"} role="status">
          {p.verifyResult.message}
        </div>
      ) : null}
      {syncMsg ? (
        <div className={s.alert} data-tone="info" role="status">
          {syncMsg}
        </div>
      ) : null}

      <div className={s.optionRow}>
        <div className={s.optionText}>
          <span className={s.optionTitle} id="wp-schema-label">
            Schema markup (JSON-LD)
            {connected ? (
              <span className={s.chip} data-state={p.settings.wp_schema_supported ? "ok" : "warn"}>
                {p.settings.wp_schema_supported ? "Active on site" : "Plugin update needed"}
              </span>
            ) : null}
          </span>
          <span className={s.optionDesc}>
            Adds Article and FAQ structured data to every published post. Works alongside Yoast and Rank Math.
          </span>
        </div>
        <input
          type="checkbox"
          role="switch"
          className={s.switch}
          aria-labelledby="wp-schema-label"
          checked={p.schemaEnabled}
          onChange={(e) => p.onSchemaEnabled(e.target.checked)}
        />
      </div>
    </section>
  );
}
