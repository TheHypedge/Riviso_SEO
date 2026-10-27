"use client";

import { useEffect, useState } from "react";

import styles from "@/app/page.module.css";
import { api, type IndexNowStatus } from "@/lib/api";

/** Bing (and Yandex, Naver, Seznam, Yep) instant indexing via IndexNow — WordPress projects only. */
export function IndexNowSettings({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<IndexNowStatus | null>(null);
  const [busy, setBusy] = useState<"" | "setup" | "submit" | "toggle">("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.indexNowStatus(projectId).then(setStatus).catch(() => setStatus(null));
  }, [projectId]);

  async function run(kind: "setup" | "submit" | "toggle", call: () => Promise<IndexNowStatus>, ok?: string) {
    setBusy(kind);
    setMsg(null);
    try {
      const next = await call();
      setStatus(next);
      if (ok) setMsg(ok);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy("");
    }
  }

  if (!status?.supported) return null;

  return (
    <div className={`${styles.card} ${styles.cardWide}`} style={{ marginTop: 14 }}>
      <div className={styles.row} style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ marginTop: 0, marginBottom: 0 }} className={styles.sectionSecondaryTitle}>
          Bing instant indexing (IndexNow)
        </h3>
        <span className={styles.muted} style={{ fontSize: 13 }} role="status">
          {status.ready ? "✓ Verified" : status.key ? "Not verified" : "Not set up"}
        </span>
      </div>
      <div className={styles.muted} style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
        Tells Bing — and Yandex, Naver, Seznam and Yep, which share IndexNow submissions — about every post the moment
        it goes live or is updated. Google does not use IndexNow; it is covered by Search Console above.
      </div>

      {status.error && !status.ready ? (
        <div className={styles.muted} style={{ fontSize: 13, marginTop: 10, lineHeight: 1.5 }}>
          {status.error}
        </div>
      ) : null}

      {status.ready ? (
        <label className={styles.label} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, marginBottom: 0 }}>
          <input
            type="checkbox"
            checked={status.enabled}
            disabled={busy !== ""}
            onChange={(e) => run("toggle", () => api.indexNowSetEnabled(projectId, e.target.checked))}
          />
          <span style={{ fontSize: 13 }}>Submit to Bing automatically after a live publish or update</span>
        </label>
      ) : null}

      <div className={styles.row} style={{ gap: 8, marginTop: 12, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button
          type="button"
          className={styles.button}
          disabled={busy !== ""}
          onClick={() => run("setup", () => api.indexNowSetup(projectId))}
        >
          {busy === "setup" ? "Checking…" : status.key ? "Verify again" : "Set up IndexNow"}
        </button>
        {status.ready ? (
          <button
            type="button"
            className={styles.button}
            disabled={busy !== ""}
            onClick={() => run("submit", () => api.indexNowSubmitAll(projectId), "Submitted all published posts to Bing.")}
          >
            {busy === "submit" ? "Submitting…" : "Submit all published posts"}
          </button>
        ) : null}
      </div>

      {msg ? (
        <div className={styles.muted} style={{ fontSize: 13, marginTop: 8 }} role="status">
          {msg}
        </div>
      ) : null}
      {status.last_submit_at ? (
        <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
          Last bulk submit: {status.last_submit_at} UTC — {status.last_result}
        </div>
      ) : null}
    </div>
  );
}
