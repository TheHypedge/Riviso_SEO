"use client";

import { useEffect, useState } from "react";

import { Hint } from "@/components/settings/Hint";
import s from "@/components/settings/settingsCard.module.css";
import { api, type IndexNowStatus } from "@/lib/api";

/** Bing (and Yandex, Naver, Seznam, Yep) instant indexing via IndexNow — WordPress projects only. */
export function IndexNowSettings({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<IndexNowStatus | null>(null);
  const [busy, setBusy] = useState<"" | "setup" | "submit" | "toggle">("");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    api.indexNowStatus(projectId).then(setStatus).catch(() => setStatus(null));
  }, [projectId]);

  async function run(kind: "setup" | "submit" | "toggle", call: () => Promise<IndexNowStatus>, ok?: string) {
    setBusy(kind);
    setMsg(null);
    try {
      const next = await call();
      setStatus(next);
      if (ok) setMsg({ tone: "ok", text: ok });
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message : "Request failed" });
    } finally {
      setBusy("");
    }
  }

  if (!status?.supported) return null;

  const badge = status.ready
    ? { label: "Verified", state: "ok" }
    : status.key
      ? { label: "Not verified", state: "warn" }
      : { label: "Not set up", state: "idle" };

  return (
    <section className={s.card} aria-labelledby="indexnow-title">
      <header className={s.head}>
        <div className={s.titleRow}>
          <h3 id="indexnow-title" className={s.title}>
            Bing IndexNow
          </h3>
          <Hint label="About IndexNow">
            Tells Bing — and Yandex, Naver, Seznam and Yep, which share IndexNow submissions — about
            every post the moment it goes live or is updated. Google doesn&apos;t use IndexNow; Search
            Console covers it.
          </Hint>
        </div>
        <span className={s.badge} data-state={badge.state} role="status">
          <span className={s.badgeDot} aria-hidden="true" />
          {badge.label}
        </span>
      </header>

      {status.error && !status.ready ? (
        <div className={s.alert} data-tone="error" style={{ marginTop: 0, marginBottom: 12 }}>
          {status.error}
        </div>
      ) : null}

      {status.ready ? (
        <div className={s.optionRow} style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
          <div className={s.optionText}>
            <span className={s.optionTitle} id="indexnow-auto-label">
              Submit automatically
            </span>
            <span className={s.optionDesc}>Notify Bing after every live publish or update.</span>
          </div>
          <input
            type="checkbox"
            role="switch"
            className={s.switch}
            aria-labelledby="indexnow-auto-label"
            checked={status.enabled}
            disabled={busy !== ""}
            onChange={(e) => run("toggle", () => api.indexNowSetEnabled(projectId, e.target.checked))}
          />
        </div>
      ) : (
        <p className={s.fieldHelp} style={{ margin: 0 }}>
          Set up once: Riviso places a verification key on your site through the RivisoSEO plugin.
        </p>
      )}

      <div className={s.actions}>
        <span className={s.fieldHelp}>
          {status.last_submit_at ? `Last bulk submit ${status.last_submit_at} UTC — ${status.last_result}` : ""}
        </span>
        <div className={s.actionsRight}>
          <button
            type="button"
            className={status.ready ? s.btnSecondary : s.btnPrimary}
            disabled={busy !== ""}
            onClick={() => run("setup", () => api.indexNowSetup(projectId))}
          >
            {busy === "setup" ? "Checking…" : status.key ? "Verify again" : "Set up IndexNow"}
          </button>
          {status.ready ? (
            <button
              type="button"
              className={s.btnPrimary}
              disabled={busy !== ""}
              onClick={() => run("submit", () => api.indexNowSubmitAll(projectId), "Submitted all published posts to Bing.")}
            >
              {busy === "submit" ? "Submitting…" : "Submit all posts"}
            </button>
          ) : null}
        </div>
      </div>

      {msg ? (
        <div className={s.alert} data-tone={msg.tone} role="status">
          {msg.text}
        </div>
      ) : null}
    </section>
  );
}
