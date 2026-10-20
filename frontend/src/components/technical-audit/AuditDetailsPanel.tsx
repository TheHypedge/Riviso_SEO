"use client";

import { useState } from "react";
import type { TechnicalAuditRun, TechnicalAuditStrategyResult } from "@/lib/api";
import { formatSiteAuditTimestamp } from "@/lib/technicalAuditFormat";
import { type Strategy, formatMs, isSafeHttpsUrl, reportFilename } from "@/lib/technicalAuditView";
import { type CssModule } from "./parts";

/** JSON report: provenance header + the stored result for one device. No secrets are stored on
 * the run, and the internal project id is left out. */
export function buildJsonReport(run: TechnicalAuditRun, strategy: Strategy, result: TechnicalAuditStrategyResult): string {
  return JSON.stringify(
    {
      provenance: {
        tool: "Riviso Technical Audit",
        source: "Google PageSpeed Insights API v5 (Lighthouse lab test; Chrome UX Report real-user data when available)",
        lighthouse_version: result.lighthouse_version ?? null,
        fetch_time: result.fetch_time ?? null,
        requested_url: result.requested_url ?? run.website_url,
        final_url: result.final_url ?? null,
        device: strategy,
        run_id: run.id,
        audited_at: run.created_at,
      },
      result,
    },
    null,
    2,
  );
}

/** Block I: where every number on the screen came from. */
export function AuditDetailsPanel({ run, result, strategy, psiUrl, styles }: { run: TechnicalAuditRun; result: TechnicalAuditStrategyResult; strategy: Strategy; psiUrl: string | null; styles: CssModule }) {
  const [showWarnings, setShowWarnings] = useState(false);
  const requested = result.requested_url || run.website_url;
  const finalUrl = result.final_url && result.final_url !== requested ? result.final_url : null;
  const warnings = result.run_warnings || [];
  const status =
    warnings.length > 0
      ? "Completed with warnings"
      : typeof result.run_duration_ms === "number"
        ? `Completed in ${formatMs(result.run_duration_ms)}`
        : "Completed";

  const download = () => {
    const blob = new Blob([buildJsonReport(run, strategy, result)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = reportFilename(result.final_url || requested, run.created_at, strategy);
    a.click();
    URL.revokeObjectURL(href);
  };

  return (
    <section id="ta-details" aria-labelledby="ta-details-title" className={`${styles.card} ${styles.siteAuditPanel}`}>
      <h3 id="ta-details-title" className={styles.siteAuditPanelTitle}>
        Audit Details
      </h3>
      <dl className={styles.siteAuditDetailsList}>
        <div>
          <dt>URL</dt>
          <dd>
            {isSafeHttpsUrl(requested) || requested?.startsWith("http://") ? (
              <a href={requested} target="_blank" rel="noopener noreferrer" className={styles.siteAuditMonoLink}>
                {requested}
              </a>
            ) : (
              requested || "—"
            )}
          </dd>
        </div>
        {finalUrl ? (
          <div>
            <dt>Final URL</dt>
            <dd className={styles.siteAuditMono}>{finalUrl}</dd>
          </div>
        ) : null}
        <div>
          <dt>Device</dt>
          <dd>
            {(result.form_factor || strategy) === "desktop" ? "Desktop" : "Mobile"} (emulated)
            {result.emulated_user_agent ? (
              <span className={styles.siteAuditMono} title={result.emulated_user_agent} style={{ display: "block", fontSize: 11 }}>
                {result.emulated_user_agent}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Audit type</dt>
          <dd>PageSpeed Insights · Lab data{result.field ? " · Real-user data included" : ""}</dd>
        </div>
        <div>
          <dt>Lighthouse version</dt>
          <dd>{result.lighthouse_version || "Not recorded for this run"}</dd>
        </div>
        <div>
          <dt>Audit time</dt>
          <dd>{result.fetch_time ? formatSiteAuditTimestamp(result.fetch_time) : formatSiteAuditTimestamp(run.created_at)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{status}</dd>
        </div>
        <div>
          <dt>Test conditions</dt>
          <dd>Not reported by PageSpeed Insights</dd>
        </div>
      </dl>

      {warnings.length > 0 ? (
        <div className={styles.siteAuditWarnings}>
          <button type="button" className={styles.siteAuditTextButton} aria-expanded={showWarnings} aria-controls="ta-run-warnings" onClick={() => setShowWarnings((v) => !v)}>
            Run warnings ({warnings.length}) <span aria-hidden="true">{showWarnings ? "⌃" : "⌄"}</span>
          </button>
          {showWarnings ? (
            <ul id="ta-run-warnings" className={styles.siteAuditSampleList}>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className={styles.siteAuditDetailsActions}>
        {psiUrl ? (
          <a href={psiUrl} target="_blank" rel="noopener noreferrer" className={styles.btnSecondary}>
            View on PageSpeed Insights ↗<span className={styles.srOnly}> (opens in a new tab)</span>
          </a>
        ) : null}
        <button type="button" className={styles.btnSecondary} onClick={download}>
          Download report
        </button>
      </div>
    </section>
  );
}
