"use client";

import { Hint } from "@/components/settings/Hint";
import type { SiteMapListResponse } from "@/lib/api";
import { formatDayMonYearTime } from "@/lib/dateFormat";

import s from "./settingsCard.module.css";

type Props = {
  siteMap: SiteMapListResponse | null;
  busy: boolean;
  message: string | null;
  onSync: () => void;
  linkAware: boolean;
  onLinkAware: (v: boolean) => void;
  canSync: boolean;
};

/** Project Settings → Integrations → Internal linking: the WordPress post list used for internal links. */
export function SiteMapSection(p: Props) {
  const entries = p.siteMap?.entries ?? [];
  const count = p.siteMap?.count ?? 0;
  const withKeyphrase = entries.filter((e) => (e.focus_keyphrase || "").trim()).length;
  const lastSynced = entries.reduce((max, e) => ((e.fetched_at || "") > max ? e.fetched_at : max), "");
  const recent = entries.slice(0, 5);
  // Success messages from syncSiteMap() always start with "Synced"; anything else is an error.
  const failed = !!p.message && !/^Synced /.test(p.message);

  return (
    <section className={s.card} aria-labelledby="sitemap-title">
      <header className={s.head}>
        <div className={s.titleRow}>
          <h3 id="sitemap-title" className={s.title}>
            Internal linking
          </h3>
          <Hint label="About internal linking">
            Riviso copies the list of published posts from your WordPress site — URL, title, focus
            keyphrase and featured image. With internal-link aware articles on, new drafts link to
            these posts and can borrow a featured image as a style reference.
          </Hint>
        </div>
        <span className={s.badge} data-state={count ? "ok" : "idle"}>
          <span className={s.badgeDot} aria-hidden="true" />
          {count ? `${count.toLocaleString()} posts synced` : "Not synced"}
        </span>
      </header>

      <div className={s.optionRow} style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
        <div className={s.optionText}>
          <span className={s.optionTitle} id="link-aware-label">
            Internal-link aware articles
          </span>
          <span className={s.optionDesc}>
            New articles link to relevant posts from this list. Applies when you click Save changes.
          </span>
        </div>
        <input
          type="checkbox"
          role="switch"
          className={s.switch}
          aria-labelledby="link-aware-label"
          checked={p.linkAware}
          onChange={(e) => p.onLinkAware(e.target.checked)}
        />
      </div>

      {count ? (
        <>
          <dl className={s.stats}>
            <div>
              <dt>Posts</dt>
              <dd>{count.toLocaleString()}</dd>
            </div>
            <div>
              <dt>With focus keyphrase</dt>
              <dd>{withKeyphrase.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Last synced</dt>
              <dd>{formatDayMonYearTime(lastSynced) || "—"}</dd>
            </div>
          </dl>
          <div className={s.listHead}>
            <span>Recently updated posts</span>
            {p.siteMap?.wp_site_url ? <span className={s.urlHost}>{p.siteMap.wp_site_url}</span> : null}
          </div>
          <ul className={s.postList}>
            {recent.map((e) => (
              <li key={e.id || e.post_url}>
                <a href={e.post_url} target="_blank" rel="noopener noreferrer" className={s.postTitle}>
                  {e.post_title || e.post_url}
                </a>
                {e.focus_keyphrase ? <span className={s.chip}>{e.focus_keyphrase}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className={s.empty} style={{ marginTop: 14 }}>
          <strong>No posts synced yet.</strong>
          <span>
            {p.canSync
              ? "Sync to copy your published WordPress posts so new articles can link to them."
              : "Connect and verify WordPress first, then sync your posts."}
          </span>
        </div>
      )}

      <div className={s.actions}>
        <span className={s.fieldHelp}>Sync again after you publish or edit posts outside Riviso.</span>
        <button type="button" className={count ? s.btnSecondary : s.btnPrimary} onClick={p.onSync} disabled={p.busy || !p.canSync}>
          {p.busy ? "Syncing…" : count ? "Sync again" : "Sync from WordPress"}
        </button>
      </div>

      {p.message ? (
        <div className={s.alert} data-tone={failed ? "error" : "ok"} role="status">
          {p.message}
        </div>
      ) : null}
    </section>
  );
}
