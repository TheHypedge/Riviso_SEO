"use client";

import { useCallback, useEffect, useState } from "react";

import styles from "@/app/page.module.css";
import { api, type GscSitemap } from "@/lib/api";

/** Sitemaps registered on the project's Search Console property: list, (re)submit, remove. */
export function GscSitemapsCard({ projectId }: { projectId: string }) {
  const [sitemaps, setSitemaps] = useState<GscSitemap[] | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [confirmRemove, setConfirmRemove] = useState<string>("");
  const [msg, setMsg] = useState<string | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let alive = true;
    api
      .gscProjectListSitemaps(projectId)
      .then((res) => {
        if (!alive) return;
        setSitemaps(res.sitemaps || []);
        setUrl((cur) => cur || res.suggested_sitemap_url || "");
      })
      .catch((e) => {
        if (!alive) return;
        setSitemaps([]);
        setMsg(e instanceof Error ? e.message : "Could not load sitemaps");
      });
    return () => {
      alive = false;
    };
  }, [projectId, reloadKey]);

  async function submit(target: string) {
    setBusy(`submit:${target}`);
    setMsg(null);
    try {
      const res = await api.gscProjectSubmitSitemap(projectId, target);
      setMsg(`Submitted ${res.sitemap_url}. Google will re-read it on its next crawl.`);
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Sitemap submission failed");
    } finally {
      setBusy("");
    }
  }

  async function remove(path: string) {
    setBusy(`remove:${path}`);
    setMsg(null);
    try {
      await api.gscProjectDeleteSitemap(projectId, path);
      setConfirmRemove("");
      setMsg(`Removed ${path} from Search Console.`);
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Sitemap removal failed");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className={`${styles.card} ${styles.cardWide}`} style={{ marginTop: 14 }}>
      <h3 style={{ marginTop: 0, marginBottom: 0 }} className={styles.sectionSecondaryTitle}>
        Search Console sitemaps
      </h3>
      <div className={styles.muted} style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
        Riviso resubmits these after every live publish so Google re-reads them. Submit your site&apos;s sitemap
        once if none is listed (Yoast: <code>sitemap_index.xml</code>, Rank Math: <code>sitemap_index.xml</code>,
        WordPress core: <code>wp-sitemap.xml</code>).
      </div>

      {sitemaps === null ? (
        <div className={styles.muted} style={{ fontSize: 13, marginTop: 10 }}>Loading…</div>
      ) : sitemaps.length === 0 ? (
        <div className={styles.muted} style={{ fontSize: 13, marginTop: 10 }}>No sitemaps registered yet.</div>
      ) : (
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={{ padding: "6px 8px" }}>Sitemap</th>
                <th style={{ padding: "6px 8px" }}>Submitted / indexed</th>
                <th style={{ padding: "6px 8px" }}>Last read by Google</th>
                <th style={{ padding: "6px 8px" }}>Status</th>
                <th style={{ padding: "6px 8px" }} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sitemaps.map((s) => (
                <tr key={s.path} style={{ borderTop: "1px solid var(--aa-hairline)" }}>
                  <td style={{ padding: "6px 8px", wordBreak: "break-all" }}>{s.path}</td>
                  <td style={{ padding: "6px 8px" }}>
                    {s.submitted_urls || "–"} / {s.indexed_urls || "–"}
                  </td>
                  <td style={{ padding: "6px 8px" }}>{(s.last_downloaded || "").slice(0, 10) || "Not yet"}</td>
                  <td style={{ padding: "6px 8px" }}>
                    {s.errors ? `${s.errors} error(s)` : s.warnings ? `${s.warnings} warning(s)` : s.is_pending ? "Pending" : "OK"}
                  </td>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap", textAlign: "right" }}>
                    <button type="button" className={styles.button} disabled={busy !== ""} onClick={() => void submit(s.path)}>
                      {busy === `submit:${s.path}` ? "Resubmitting…" : "Resubmit"}
                    </button>{" "}
                    {confirmRemove === s.path ? (
                      <>
                        <button type="button" className={styles.button} data-tone="danger" disabled={busy !== ""} onClick={() => void remove(s.path)}>
                          {busy === `remove:${s.path}` ? "Removing…" : "Confirm remove"}
                        </button>{" "}
                        <button type="button" className={styles.button} disabled={busy !== ""} onClick={() => setConfirmRemove("")}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" className={styles.button} disabled={busy !== ""} onClick={() => setConfirmRemove(s.path)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form
        className={styles.row}
        style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void submit(url.trim());
        }}
      >
        <label className={styles.label} style={{ flex: "1 1 280px", margin: 0 }}>
          <span className="sr-only">Sitemap URL</span>
          <input
            className={styles.input}
            type="url"
            placeholder="https://example.com/sitemap_index.xml"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <button type="submit" className={styles.button} disabled={busy !== "" || !url.trim()}>
          {busy === `submit:${url.trim()}` ? "Submitting…" : "Submit sitemap"}
        </button>
      </form>

      {msg ? (
        <div className={styles.muted} style={{ fontSize: 13, marginTop: 8 }} role="status">
          {msg}
        </div>
      ) : null}
    </div>
  );
}
