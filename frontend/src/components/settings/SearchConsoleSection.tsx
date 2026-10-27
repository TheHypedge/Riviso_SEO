"use client";

import { Hint } from "@/components/settings/Hint";
import type { GscSite, ProjectGscStatus } from "@/lib/api";
import { formatDayMonYearTime } from "@/lib/dateFormat";

import s from "./settingsCard.module.css";

const PERMISSION_LABELS: Record<string, string> = {
  siteOwner: "Owner",
  siteFullUser: "Full access",
  siteRestrictedUser: "Restricted",
  siteUnverifiedUser: "Unverified",
};

/** "sc-domain:example.com" → example.com (Domain) · "https://www.example.com/" → www.example.com (URL prefix). */
export function describeGscProperty(siteUrl: string): { host: string; kind: string } {
  const raw = (siteUrl || "").trim();
  if (raw.startsWith("sc-domain:")) return { host: raw.slice("sc-domain:".length), kind: "Domain property" };
  try {
    const u = new URL(raw);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return { host: `${u.host}${path}`, kind: u.protocol === "http:" ? "URL prefix (http)" : "URL prefix" };
  } catch {
    return { host: raw, kind: "Property" };
  }
}

function siteLabel(site: GscSite): string {
  const { host, kind } = describeGscProperty(site.siteUrl);
  const perm = site.permissionLevel ? PERMISSION_LABELS[site.permissionLevel] || site.permissionLevel : "";
  return [host, kind, perm].filter(Boolean).join(" · ");
}

type BadgeState = "ok" | "warn" | "error" | "idle";

type Props = {
  status: ProjectGscStatus | null;
  sites: GscSite[];
  loading: boolean;
  apiUnavailable: boolean;
  connecting: boolean;
  disconnecting: boolean;
  justConnected: boolean;
  error: string | null;
  saveMessage: string | null;
  propertyUrl: string;
  onPropertyUrl: (v: string) => void;
  indexOnPublish: boolean;
  onIndexOnPublish: (v: boolean) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onSave: () => void;
};

/** Project Settings → Integrations → Search Console: Google account, property, auto-indexing. */
export function SearchConsoleSection(p: Props) {
  const connected = !!p.status?.connected;
  const notConfigured = p.status?.configured === false;
  const savedProperty = (p.status?.property_url || "").trim();

  let badge: { label: string; state: BadgeState };
  if (p.loading) badge = { label: "Checking…", state: "idle" };
  else if (p.apiUnavailable) badge = { label: "Backend update needed", state: "error" };
  else if (notConfigured) badge = { label: "Not configured", state: "warn" };
  else if (connected && savedProperty) badge = { label: "Connected", state: "ok" };
  else if (connected) badge = { label: "Choose a property", state: "warn" };
  else badge = { label: "Not connected", state: "idle" };

  const linkedAt = formatDayMonYearTime(p.status?.connected_at);
  const email = (p.status?.email || "").trim();
  const dirty =
    p.propertyUrl !== savedProperty || p.indexOnPublish !== Boolean(p.status?.index_on_publish ?? true);
  // Keep the saved property selectable even if Google stopped listing it.
  const sites =
    savedProperty && !p.sites.some((x) => x.siteUrl === savedProperty)
      ? [{ siteUrl: savedProperty }, ...p.sites]
      : p.sites;

  return (
    <section className={s.card} aria-labelledby="gsc-title">
      <header className={s.head}>
        <div className={s.titleRow}>
          <h3 id="gsc-title" className={s.title}>
            Search Console
          </h3>
          <Hint label="About Search Console">
            Connect this project to its own Google account and Search Console property. Riviso
            then resubmits your sitemap after every live publish, checks indexing status, and
            shows clicks and impressions. Each project can use a different Google account.
          </Hint>
        </div>
        <span className={s.badge} data-state={badge.state} role="status">
          <span className={s.badgeDot} aria-hidden="true" />
          {badge.label}
        </span>
      </header>

      {p.error ? (
        <div className={s.alert} data-tone="error" role="alert" style={{ marginTop: 0, marginBottom: 14 }}>
          {p.error}
        </div>
      ) : null}
      {p.justConnected && connected ? (
        <div className={s.alert} data-tone="ok" role="status" style={{ marginTop: 0, marginBottom: 14 }}>
          Google account connected. Choose the property for this project below and save.
        </div>
      ) : null}

      {p.apiUnavailable ? (
        <div className={s.alert} data-tone="error">
          The server doesn&apos;t support per-project Search Console yet. Redeploy the backend, then reload this page.
        </div>
      ) : notConfigured ? (
        <div className={s.alert}>
          Google sign-in isn&apos;t configured on the server (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).
          Ask your administrator to set it up.
        </div>
      ) : (
        <div className={s.accountRow}>
          <span className={s.avatar} aria-hidden="true">
            {connected ? (email[0] || "G").toUpperCase() : "G"}
          </span>
          <div className={s.accountText}>
            {connected ? (
              <>
                <span className={s.accountEmail}>{email || "Google account"}</span>
                <span className={s.accountMeta}>{linkedAt ? `Linked ${linkedAt}` : "Linked"}</span>
              </>
            ) : (
              <>
                <span className={s.accountEmail}>No Google account connected</span>
                <span className={s.accountMeta}>Use the account that owns this site in Search Console.</span>
              </>
            )}
          </div>
          <div className={s.accountActions}>
            {connected ? (
              <button type="button" className={s.btnDangerGhost} onClick={p.onDisconnect} disabled={p.disconnecting}>
                {p.disconnecting ? "Disconnecting…" : "Disconnect"}
              </button>
            ) : null}
            <button
              type="button"
              className={connected ? s.btnSecondary : s.btnPrimary}
              onClick={p.onConnect}
              disabled={p.connecting || p.loading}
            >
              {p.connecting ? "Opening Google…" : connected ? "Reconnect" : "Connect Google"}
            </button>
          </div>
        </div>
      )}

      {connected ? (
        <>
          <label className={s.field} style={{ marginTop: 16 }}>
            <span className={s.label}>Property</span>
            <select className={s.input} value={p.propertyUrl} onChange={(e) => p.onPropertyUrl(e.target.value)}>
              <option value="">Choose a property…</option>
              {sites.map((site) => (
                <option key={site.siteUrl} value={site.siteUrl}>
                  {siteLabel(site)}
                </option>
              ))}
            </select>
            {p.sites.length === 0 && !p.loading ? (
              <span className={s.fieldHelp}>
                This Google account has no Search Console properties. Add and verify your site in Search Console,
                then click Reconnect.
              </span>
            ) : null}
          </label>

          <div className={s.optionRow}>
            <div className={s.optionText}>
              <span className={s.optionTitle} id="gsc-index-label">
                Request indexing after publish
              </span>
              <span className={s.optionDesc}>
                Resubmit your sitemap to Google whenever an article goes live.
              </span>
            </div>
            <input
              type="checkbox"
              role="switch"
              className={s.switch}
              aria-labelledby="gsc-index-label"
              checked={p.indexOnPublish}
              onChange={(e) => p.onIndexOnPublish(e.target.checked)}
            />
          </div>

          <div className={s.actions}>
            <span className={s.fieldHelp} role="status">
              {p.saveMessage || (dirty ? "You have unsaved changes." : "")}
            </span>
            <button type="button" className={s.btnPrimary} onClick={p.onSave} disabled={!dirty}>
              Save
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
