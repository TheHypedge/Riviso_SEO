"use client";

import { useState } from "react";

import styles from "@/app/page.module.css";
import { api } from "@/lib/api";

/** Pull the current WordPress state (status, link, SEO meta) into every linked article. */
export function WordPressBulkSyncButton({ projectId, disabled }: { projectId: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.syncLinkedArticlesFromWordPress(projectId);
      setMsg(
        `Synced ${r.synced_count} of ${r.linked_count} linked article(s)` +
          (r.skipped_count ? `, ${r.skipped_count} skipped` : "") +
          (r.error_count ? `, ${r.error_count} failed (${r.errors[0]?.message || "see article"})` : "") +
          ".",
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "WordPress sync failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className={styles.button}
        type="button"
        onClick={() => void run()}
        disabled={busy || disabled}
        title="Pull status, link and SEO fields from WordPress for every article already published there."
      >
        {busy ? "Syncing…" : "Sync articles from WordPress"}
      </button>
      {msg ? (
        <span className={styles.muted} style={{ fontSize: 13, flexBasis: "100%" }} role="status">
          {msg}
        </span>
      ) : null}
    </>
  );
}
