"use client";

import { useState } from "react";

import { Hint } from "@/components/settings/Hint";
import type { LinkedInStatus, SocialPost } from "@/lib/api";
import { formatDateOnly, formatDayMonYearTime } from "@/lib/dateFormat";

import s from "./settingsCard.module.css";

const RECENT_CARDS = 5;
const TABLE_PAGE = 10;
const EXPIRY_WARN_DAYS = 7;

/** First non-empty line of a post — what readers see before "…see more". */
export function openingLine(text: string): string {
  return (text || "").split("\n").map((l) => l.trim()).find(Boolean) || "(empty post)";
}

function restOfPost(text: string): string {
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.slice(1).join(" ");
}

function daysUntil(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw.includes("T") || raw.endsWith("Z") ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? Math.ceil((t - Date.now()) / 86_400_000) : null;
}

type Props = {
  status: LinkedInStatus | null;
  loading: boolean;
  error: string | null;
  justConnected: boolean;
  connecting: boolean;
  disconnecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onSelectAuthor: (urn: string) => void;
  posts: SocialPost[];
  articleTitle: (articleId: string) => string | null;
  onSaveSettings: (autoPostEnabled: boolean, delayMinutes: number) => Promise<void>;
};

function delayLabel(min: number): string {
  if (min < 60) return `${min} minutes`;
  const h = min / 60;
  return h === 24 ? "24 hours (1 day)" : `${h} hour${h === 1 ? "" : "s"}`;
}

/** Settings tab: auto-post every published article to LinkedIn after a chosen delay. */
function AutoPostSettings({ status, onSave }: { status: LinkedInStatus; onSave: Props["onSaveSettings"] }) {
  const savedEnabled = !!status.auto_post_enabled;
  const savedDelay = status.auto_post_delay_minutes || 30;
  const options = status.auto_post_delay_options?.length ? status.auto_post_delay_options : [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
  const [enabled, setEnabled] = useState(savedEnabled);
  const [delay, setDelay] = useState(savedDelay);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const dirty = enabled !== savedEnabled || (enabled && delay !== savedDelay);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await onSave(enabled, delay);
      setMsg({ tone: "ok", text: enabled ? `Auto-post is on — articles go to LinkedIn ${delayLabel(delay)} after they're published.` : "Auto-post is off." });
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message : "Could not save settings" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="tabpanel" id="linkedin-panel-settings" aria-labelledby="linkedin-tab-settings">
      <div className={s.optionRow} style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
        <div className={s.optionText}>
          <span className={s.optionTitle} id="li-auto-label">
            Post to LinkedIn after an article is published
          </span>
          <span className={s.optionDesc}>
            When an article goes live on your site, Riviso writes a LinkedIn caption and shares it with the featured image.
          </span>
        </div>
        <input
          type="checkbox"
          role="switch"
          className={s.switch}
          aria-labelledby="li-auto-label"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
      </div>

      {enabled ? (
        <div className={s.subSettings}>
          <label className={s.field}>
            <span className={s.label}>Post it after</span>
            <select className={s.input} value={delay} onChange={(e) => setDelay(Number(e.target.value))}>
              {options.map((m) => (
                <option key={m} value={m}>
                  {delayLabel(m)}
                </option>
              ))}
            </select>
          </label>
          <ul className={s.noteList}>
            <li>The wait starts when the article is published live (manually, on a schedule, or right after generation).</li>
            <li>Each article is posted once — articles already on LinkedIn are skipped.</li>
            <li>Queued posts appear in Scheduled Articles, where you can cancel them.</li>
          </ul>
        </div>
      ) : null}

      <div className={s.actions}>
        <span className={s.fieldHelp}>{dirty ? "You have unsaved changes." : ""}</span>
        <button type="button" className={s.btnPrimary} onClick={() => void save()} disabled={!dirty || busy}>
          {busy ? "Saving…" : "Save settings"}
        </button>
      </div>
      {msg ? (
        <div className={s.alert} data-tone={msg.tone} role="status">
          {msg.text}
        </div>
      ) : null}
    </div>
  );
}

/** Social tab → LinkedIn: account, "post as", recent posts (cards) and full history (table). */
export function LinkedInSection(p: Props) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [view, setView] = useState<"overview" | "settings">("overview");
  const connected = !!p.status?.connected;
  const notConfigured = p.status?.configured === false;
  const expiresIn = daysUntil(p.status?.token_expires_at);
  const expiringSoon = connected && expiresIn !== null && expiresIn <= EXPIRY_WARN_DAYS;
  const name = (p.status?.member_name || "").trim();
  const posted = p.posts.filter((x) => x.platform === "linkedin" && x.external_url);
  const tableRows = showAll ? posted : posted.slice(0, TABLE_PAGE);

  let badge: { label: string; state: "ok" | "warn" | "error" | "idle" };
  if (p.loading) badge = { label: "Checking…", state: "idle" };
  else if (notConfigured) badge = { label: "Not configured", state: "warn" };
  else if (expiringSoon) badge = { label: expiresIn! <= 0 ? "Expired — reconnect" : "Reconnect soon", state: "warn" };
  else if (connected) badge = { label: "Connected", state: "ok" };
  else badge = { label: "Not connected", state: "idle" };

  const linked = formatDayMonYearTime(p.status?.connected_at);
  const expires = p.status?.token_expires_at ? formatDateOnly(p.status.token_expires_at) : "";

  return (
    <section className={s.card} aria-labelledby="linkedin-title">
      <header className={s.head}>
        <div className={s.titleRow}>
          <h3 id="linkedin-title" className={s.title}>
            LinkedIn
          </h3>
          <Hint label="About LinkedIn sharing">
            Connect a LinkedIn account to share published articles as posts — right away or on a
            schedule. Links on LinkedIn are &ldquo;nofollow&rdquo;: they bring referral traffic and
            visibility, not a direct SEO backlink.
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
          LinkedIn connected{name ? ` as ${name}` : ""}. You can now share articles from the article editor.
        </div>
      ) : null}

      {connected && !notConfigured ? (
        <div className={s.tabs} role="tablist" aria-label="LinkedIn">
          {(["overview", "settings"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`linkedin-tab-${t}`}
              aria-selected={view === t}
              aria-controls={`linkedin-panel-${t}`}
              className={s.tab}
              onClick={() => setView(t)}
            >
              {t === "overview" ? "Overview" : "Settings"}
              {t === "settings" && p.status?.auto_post_enabled ? <span className={s.tabDot} aria-label="Auto-post on" /> : null}
            </button>
          ))}
        </div>
      ) : null}

      {connected && view === "settings" && p.status ? (
        <AutoPostSettings status={p.status} onSave={p.onSaveSettings} />
      ) : (
        <div role={connected ? "tabpanel" : undefined} id={connected ? "linkedin-panel-overview" : undefined} aria-labelledby={connected ? "linkedin-tab-overview" : undefined}>
      {notConfigured ? (
        <div className={s.alert}>
          LinkedIn sign-in isn&apos;t configured on the server (LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET). Ask your
          administrator to set it up.
        </div>
      ) : (
        <div className={s.accountRow}>
          <span className={s.avatar} data-brand="linkedin" aria-hidden="true">
            {connected ? (name[0] || "in").toUpperCase() : "in"}
          </span>
          <div className={s.accountText}>
            {connected ? (
              <>
                <span className={s.accountEmail}>{name || "LinkedIn account"}</span>
                <span className={s.accountMeta}>
                  {[linked ? `Linked ${linked}` : "", expires ? `Access until ${expires}` : ""].filter(Boolean).join(" · ")}
                </span>
              </>
            ) : (
              <>
                <span className={s.accountEmail}>No LinkedIn account connected</span>
                <span className={s.accountMeta}>Connect the profile (or page admin) you want to post as.</span>
              </>
            )}
          </div>
          <div className={s.accountActions}>
            {connected && confirmDisconnect ? (
              <>
                <button type="button" className={`${s.btnGhost} ${s.btnSm}`} onClick={() => setConfirmDisconnect(false)} disabled={p.disconnecting}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={`${s.btnDanger} ${s.btnSm}`}
                  onClick={() => {
                    setConfirmDisconnect(false);
                    p.onDisconnect();
                  }}
                  disabled={p.disconnecting}
                >
                  Confirm disconnect
                </button>
              </>
            ) : (
              <>
                {connected ? (
                  <button type="button" className={s.btnDangerGhost} onClick={() => setConfirmDisconnect(true)} disabled={p.disconnecting}>
                    {p.disconnecting ? "Disconnecting…" : "Disconnect"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={connected && !expiringSoon ? s.btnSecondary : s.btnPrimary}
                  onClick={p.onConnect}
                  disabled={p.connecting || p.loading}
                >
                  {p.connecting ? "Redirecting…" : connected ? "Reconnect" : "Connect LinkedIn"}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {connected && (p.status?.organizations?.length ?? 0) > 0 ? (
        <label className={s.field} style={{ marginTop: 16 }}>
          <span className={s.label}>Post as</span>
          <select
            className={s.input}
            value={p.status?.selected_author_urn || p.status?.person_urn || ""}
            onChange={(e) => p.onSelectAuthor(e.target.value)}
          >
            {p.status?.person_urn ? <option value={p.status.person_urn}>{name || "You"} — personal profile</option> : null}
            {(p.status?.organizations || []).map((org) => (
              <option key={org.urn} value={org.urn}>
                {org.name || org.urn} — company page
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {posted.length ? (
        <>
          <div className={s.listHead} style={{ marginTop: 20 }}>
            <span>Recent posts</span>
            <span>{posted.length.toLocaleString()} shared</span>
          </div>
          <ul className={s.postCards}>
            {posted.slice(0, RECENT_CARDS).map((post) => (
              <li key={post.id}>
                <a href={post.external_url} target="_blank" rel="noopener noreferrer" className={s.postCard}>
                  <span className={s.postCardTitle}>{openingLine(post.content_text)}</span>
                  <span className={s.postCardBody}>{restOfPost(post.content_text)}</span>
                  <span className={s.postCardFoot}>
                    <span>{formatDateOnly(post.posted_at || post.created_at)}</span>
                    <span aria-hidden="true">View ↗</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>

          <div className={s.listHead} style={{ marginTop: 22 }}>
            <span>All posts</span>
          </div>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Opening line</th>
                <th scope="col">Article</th>
                <th scope="col">Published</th>
                <th scope="col">
                  <span className="sr-only">Link</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((post) => (
                <tr key={post.id}>
                  <td data-label="Opening line">
                    <span className={s.clampOne}>{openingLine(post.content_text)}</span>
                  </td>
                  <td data-label="Article">
                    <span className={s.clampOne} style={{ color: "var(--aa-muted)" }}>
                      {p.articleTitle(post.article_id) || "—"}
                    </span>
                  </td>
                  <td data-label="Published" style={{ whiteSpace: "nowrap" }}>
                    {formatDayMonYearTime(post.posted_at || post.created_at) || "—"}
                  </td>
                  <td className={s.rowActions}>
                    <a href={post.external_url} target="_blank" rel="noopener noreferrer" className={`${s.btnSecondary} ${s.btnSm}`}>
                      Open ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {posted.length > TABLE_PAGE ? (
            <div className={s.actions} style={{ justifyContent: "center" }}>
              <button type="button" className={`${s.btnGhost} ${s.btnSm}`} style={{ marginLeft: 0 }} onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show less" : `Show all ${posted.length.toLocaleString()} posts`}
              </button>
            </div>
          ) : null}
        </>
      ) : connected ? (
        <div className={s.empty} style={{ marginTop: 16 }}>
          <strong>No posts yet.</strong>
          <span>Open any article and click Share to LinkedIn — your posts will show up here.</span>
        </div>
      ) : null}
        </div>
      )}
    </section>
  );
}
