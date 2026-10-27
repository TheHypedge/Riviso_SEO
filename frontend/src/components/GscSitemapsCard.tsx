"use client";

import { useCallback, useEffect, useState } from "react";

import { Hint } from "@/components/settings/Hint";
import s from "@/components/settings/settingsCard.module.css";
import { api, type GscSitemap } from "@/lib/api";
import { formatDateOnly } from "@/lib/dateFormat";

type RowState = { label: string; state: "ok" | "warn" | "error" | "idle" };

function rowStatus(sm: GscSitemap): RowState {
  if (sm.errors) return { label: `${sm.errors} error${sm.errors === 1 ? "" : "s"}`, state: "error" };
  if (sm.warnings) return { label: `${sm.warnings} warning${sm.warnings === 1 ? "" : "s"}`, state: "warn" };
  if (sm.is_pending || !sm.last_downloaded) return { label: "Pending", state: "idle" };
  return { label: "Success", state: "ok" };
}

function splitUrl(raw: string): { host: string; path: string } {
  try {
    const u = new URL(raw);
    return { host: u.host, path: `${u.pathname}${u.search}` || "/" };
  } catch {
    return { host: "", path: raw };
  }
}

/** Sitemaps registered on the project's Search Console property: list, resubmit, remove, add. */
export function GscSitemapsCard({ projectId }: { projectId: string }) {
  const [sitemaps, setSitemaps] = useState<GscSitemap[] | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [confirmRemove, setConfirmRemove] = useState<string>("");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let alive = true;
    api
      .gscProjectListSitemaps(projectId)
      .then((res) => {
        if (!alive) return;
        setSitemaps(res.sitemaps || []);
        // Pre-fill the suggestion on first load only -- not after the user just submitted one.
        if (reloadKey === 0) setUrl((cur) => cur || res.suggested_sitemap_url || "");
      })
      .catch((e) => {
        if (!alive) return;
        setSitemaps([]);
        setMsg({ tone: "error", text: e instanceof Error ? e.message : "Could not load sitemaps" });
      });
    return () => {
      alive = false;
    };
  }, [projectId, reloadKey]);

  async function submit(target: string, isNew: boolean) {
    setBusy(`submit:${target}`);
    setMsg(null);
    try {
      const res = await api.gscProjectSubmitSitemap(projectId, target);
      setMsg({ tone: "ok", text: `${isNew ? "Submitted" : "Resubmitted"} ${res.sitemap_url}. Google will read it on its next crawl.` });
      if (isNew) setUrl("");
      load();
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message : "Sitemap submission failed" });
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
      setMsg({ tone: "ok", text: `Removed ${path} from Search Console.` });
      load();
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message : "Sitemap removal failed" });
    } finally {
      setBusy("");
    }
  }

  const count = sitemaps?.length ?? 0;

  return (
    <section className={s.card} aria-labelledby="gsc-sitemaps-title">
      <header className={s.head}>
        <div className={s.titleRow}>
          <h3 id="gsc-sitemaps-title" className={s.title}>
            Sitemaps
          </h3>
          <Hint label="About sitemaps">
            Sitemaps registered on your Search Console property. Riviso resubmits them after every
            live publish so Google re-reads them. Yoast and Rank Math use sitemap_index.xml;
            WordPress core uses wp-sitemap.xml.
          </Hint>
        </div>
        {sitemaps ? (
          <span className={s.badge} data-state={count ? "ok" : "warn"}>
            <span className={s.badgeDot} aria-hidden="true" />
            {count ? `${count} registered` : "None registered"}
          </span>
        ) : null}
      </header>

      {sitemaps === null ? (
        <p className={s.fieldHelp}>Loading sitemaps…</p>
      ) : count === 0 ? (
        <div className={s.empty}>
          <strong>No sitemaps yet.</strong>
          <span>Submit your site&apos;s sitemap below so Google can discover every article.</span>
        </div>
      ) : (
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Sitemap</th>
              <th scope="col">Indexed / submitted</th>
              <th scope="col">Last read</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sitemaps.map((sm) => {
              const { host, path } = splitUrl(sm.path);
              const submitted = Number(sm.submitted_urls) || 0;
              const indexed = Number(sm.indexed_urls) || 0;
              const pct = submitted ? Math.min(100, Math.round((indexed / submitted) * 100)) : 0;
              const st = rowStatus(sm);
              const confirming = confirmRemove === sm.path;
              return (
                <tr key={sm.path}>
                  <td data-label="Sitemap">
                    <a className={s.urlCell} href={sm.path} target="_blank" rel="noopener noreferrer">
                      <span className={s.urlPath}>{path}</span>
                      {host ? <span className={s.urlHost}>{host}</span> : null}
                    </a>
                  </td>
                  <td data-label="Indexed / submitted">
                    {submitted ? (
                      <span className={s.meter}>
                        <span className={s.meterText}>
                          {indexed.toLocaleString()} / {submitted.toLocaleString()}
                        </span>
                        <span className={s.meterTrack} aria-hidden="true">
                          <span className={s.meterFill} style={{ width: `${pct}%` }} />
                        </span>
                      </span>
                    ) : (
                      <span className={s.fieldHelp}>—</span>
                    )}
                  </td>
                  <td data-label="Last read">{sm.last_downloaded ? formatDateOnly(sm.last_downloaded) : "Not yet"}</td>
                  <td data-label="Status">
                    <span className={s.badge} data-state={st.state}>
                      <span className={s.badgeDot} aria-hidden="true" />
                      {st.label}
                    </span>
                  </td>
                  <td className={s.rowActions}>
                    {confirming ? (
                      <>
                        <button type="button" className={`${s.btnGhost} ${s.btnSm}`} disabled={busy !== ""} onClick={() => setConfirmRemove("")}>
                          Cancel
                        </button>
                        <button type="button" className={`${s.btnDanger} ${s.btnSm}`} disabled={busy !== ""} onClick={() => void remove(sm.path)}>
                          {busy === `remove:${sm.path}` ? "Removing…" : "Confirm remove"}
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className={`${s.btnSecondary} ${s.btnSm}`} disabled={busy !== ""} onClick={() => void submit(sm.path, false)}>
                          {busy === `submit:${sm.path}` ? "Resubmitting…" : "Resubmit"}
                        </button>
                        <button
                          type="button"
                          className={`${s.btnDangerGhost} ${s.btnSm}`}
                          disabled={busy !== ""}
                          onClick={() => setConfirmRemove(sm.path)}
                          aria-label={`Remove ${sm.path}`}
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <form
        className={s.addRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void submit(url.trim(), true);
        }}
      >
        <label className="sr-only" htmlFor="gsc-sitemap-url">
          Sitemap URL
        </label>
        <input
          id="gsc-sitemap-url"
          className={s.input}
          type="url"
          placeholder="https://example.com/sitemap_index.xml"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" className={s.btnPrimary} disabled={busy !== "" || !url.trim()}>
          {busy === `submit:${url.trim()}` ? "Submitting…" : "Submit sitemap"}
        </button>
      </form>

      {msg ? (
        <div className={s.alert} data-tone={msg.tone} role="status">
          {msg.text}
        </div>
      ) : null}
    </section>
  );
}
